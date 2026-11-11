# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi>=0.115", "uvicorn>=0.30", "httpx>=0.27", "pydantic>=2", "google-cloud-storage>=2.18"]
# ///
"""Distro video model server: one HTTP endpoint in front of every GMI Cloud video model.

    POST /generate            start a job (any catalog model id, or a tier: fast / default / quality)
    POST /generate?wait=true  block until the video is ready (or wait_timeout), then return the job
    GET  /jobs/{id}           job status, cost, video_url
    GET  /jobs/{id}/video     the finished mp4
    GET  /models              selectable models with flags and a 5s estimate
    GET  /spend               spend cap, reserved, committed
    GET  /health

Run locally:
    uv run model_server/app.py                 # http://localhost:8787, GMI_API_KEY from env or .env

Env (all optional except GMI_API_KEY):
    GMI_API_KEY, GMI_ORG_ID
    SPEND_CAP_USD=9          global cap across all jobs, persisted in the ledger
    MAX_RENDER_USD=1.00      one job may not reserve more than this
    MODEL_SERVER_TOKEN       require `Authorization: Bearer <token>`; mandatory on Cloud Run
    GCS_BUCKET               store videos, jobs and the ledger in this bucket instead of model_server/data
    PUBLIC_BASE_URL          base for video_url; default: request host
    PORT=8787, HOST=0.0.0.0

Costs are LIST-PRICE estimates reserved before submit. GMI keeps generating at a
negative balance, so this cap is the real limiter. Failed GMI jobs are refunded
by GMI, so their reserve is released; timeouts stay reserved (they may still bill).
Jobs are saved on every status change; after a restart, jobs that GMI accepted
resume polling.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from gmi_video import VideoRequest, build, load_catalog  # noqa: E402

QUEUE_URL = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests"
POLL_S = 5.0
JOB_TIMEOUT_S = 900.0


def env(name: str, default: str | None = None) -> str | None:
    if v := os.environ.get(name):
        return v
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            if line.strip().startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'") or default
    return default


SPEND_CAP = float(env("SPEND_CAP_USD", "9"))
MAX_RENDER = float(env("MAX_RENDER_USD", "1.00"))
TOKEN = env("MODEL_SERVER_TOKEN")
PUBLIC_BASE = (env("PUBLIC_BASE_URL") or "").rstrip("/")
GCS_BUCKET = env("GCS_BUCKET")
ON_CLOUD_RUN = bool(os.environ.get("K_SERVICE"))


# ---------------------------------------------------------------- storage
class Store:
    """Small key/value + file store: local folder, or a GCS bucket when GCS_BUCKET is set."""

    def __init__(self, bucket: str | None):
        self.local = HERE / "data"
        self.bucket = None
        if bucket:
            from google.cloud import storage  # imported only when used

            self.bucket = storage.Client().bucket(bucket)
        else:
            self.local.mkdir(parents=True, exist_ok=True)

    async def read_json(self, key: str) -> Any:
        def go() -> Any:
            if self.bucket:
                blob = self.bucket.blob(key)
                return json.loads(blob.download_as_bytes()) if blob.exists() else None
            p = self.local / key
            return json.loads(p.read_text()) if p.exists() else None
        return await asyncio.to_thread(go)

    async def write_json(self, key: str, obj: Any) -> None:
        data = json.dumps(obj, indent=1)

        def go() -> None:
            if self.bucket:
                self.bucket.blob(key).upload_from_string(data, content_type="application/json")
            else:
                p = self.local / key
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(data)
        await asyncio.to_thread(go)

    async def list_json(self, prefix: str) -> list[Any]:
        def go() -> list[Any]:
            if self.bucket:
                return [json.loads(b.download_as_bytes()) for b in self.bucket.list_blobs(prefix=prefix)
                        if b.name.endswith(".json")]
            d = self.local / prefix
            return [json.loads(p.read_text()) for p in d.glob("*.json")] if d.exists() else []
        return await asyncio.to_thread(go)

    def temp_path(self, key: str) -> Path:
        if self.bucket:
            return Path(tempfile.gettempdir()) / key.replace("/", "_")
        p = self.local / key
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    async def put_file(self, path: Path, key: str, content_type: str) -> None:
        if not self.bucket:
            return  # temp_path already is the final local path
        await asyncio.to_thread(self.bucket.blob(key).upload_from_filename, str(path), content_type=content_type)
        path.unlink(missing_ok=True)

    async def get_file(self, key: str) -> bytes | Path | None:
        if self.bucket:
            def go() -> bytes | None:
                blob = self.bucket.blob(key)
                return blob.download_as_bytes() if blob.exists() else None
            return await asyncio.to_thread(go)
        p = self.local / key
        return p if p.exists() else None


# ---------------------------------------------------------------- spend ledger
class Ledger:
    """Reserve -> commit/release, persisted so the cap survives restarts. Run one instance only."""

    KEY = "spend.json"

    def __init__(self, store: Store, cap: float):
        self.store, self.cap = store, cap
        self.lock = asyncio.Lock()
        self.state: dict[str, Any] = {"committed": 0.0, "reserved": {}, "entries": []}

    async def load(self) -> None:
        if saved := await self.store.read_json(self.KEY):
            self.state = saved

    @property
    def reserved(self) -> float:
        return round(sum(self.state["reserved"].values()), 4)

    def summary(self) -> dict[str, Any]:
        used = self.state["committed"] + self.reserved
        return {"cap_usd": self.cap, "committed_usd": round(self.state["committed"], 4),
                "reserved_usd": self.reserved, "remaining_usd": round(self.cap - used, 4),
                "entries": self.state["entries"][-50:]}

    def _log(self, kind: str, job: str, usd: float, note: str = "") -> None:
        self.state["entries"].append({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "kind": kind,
                                      "job_id": job, "usd": round(usd, 4), "note": note})

    async def reserve(self, job: str, usd: float, note: str) -> None:
        async with self.lock:
            if self.state["committed"] + self.reserved + usd > self.cap + 1e-9:
                raise HTTPException(402, f"spend cap: ${usd:.2f} would exceed cap ${self.cap:.2f} "
                                         f"(committed ${self.state['committed']:.2f}, reserved ${self.reserved:.2f})")
            self.state["reserved"][job] = usd
            self._log("reserve", job, usd, note)
            await self.store.write_json(self.KEY, self.state)

    async def settle(self, job: str, commit: bool, note: str = "") -> None:
        async with self.lock:
            if job not in self.state["reserved"]:
                return
            usd = self.state["reserved"].pop(job)
            if commit:
                self.state["committed"] += usd
            self._log("commit" if commit else "release", job, usd, note)
            await self.store.write_json(self.KEY, self.state)


# ---------------------------------------------------------------- jobs
class GenerateBody(BaseModel):
    model: str = Field("default", description="catalog model id, or tier: fast | default | quality")
    prompt: str
    duration: int = Field(5, ge=1, le=30)
    aspect: str = "9:16"
    resolution: str = "720p"
    negative_prompt: str | None = None
    first_frame: str | None = Field(None, description="public image URL (image-to-video)")
    last_frame: str | None = None
    audio_url: str | None = Field(None, description="public wav/mp3 URL that drives lip sync (Wan)")
    audio: bool = True
    seed: int | None = None
    dry_run: bool = Field(False, description="build payload + estimate, do not submit or spend")


Status = Literal["queued", "submitted", "processing", "downloading", "ready", "failed", "timeout"]
TERMINAL = {"ready", "failed", "timeout"}


class Job(BaseModel):
    job_id: str
    model: str
    status: Status = "queued"
    est_usd: float
    duration_s: float
    warnings: list[str] = []
    payload: dict[str, Any]
    gmi_request_id: str | None = None
    gmi_status: str | None = None
    gmi_video_url: str | None = None
    video_url: str | None = None
    created_at: float = Field(default_factory=time.time)
    finished_at: float | None = None
    elapsed_s: float | None = None
    error: str | None = None


JOBS: dict[str, Job] = {}
DONE: dict[str, asyncio.Event] = {}
STATE: dict[str, Any] = {}


def pick(d: Any, *paths: str) -> Any:
    for path in paths:
        cur = d
        for part in path.split("."):
            if isinstance(cur, list):
                cur = cur[int(part)] if part.isdigit() and int(part) < len(cur) else None
            elif isinstance(cur, dict):
                cur = cur.get(part)
            else:
                cur = None
            if cur is None:
                break
        if cur:
            return cur
    return None


def resolve_model(sel: str) -> dict[str, Any]:
    cat = STATE["catalog"]
    by_id = {e["id"].lower(): e for e in cat["models"]}
    if sel in cat["featured"]:
        for mid in cat["featured"][sel]:
            e = by_id.get(mid.lower())
            if e and e["selectable"] and e["text_to_video"] and e["supports_9_16"]:
                return e
        raise HTTPException(400, f"no usable model in tier '{sel}'")
    e = by_id.get(sel.lower())
    if not e:
        raise HTTPException(404, f"unknown model '{sel}'; see GET /models")
    if not e["selectable"]:
        raise HTTPException(400, f"model '{e['id']}' needs inputs this server does not map: {e['unmapped_required']}")
    return e


async def save_job(job: Job) -> None:
    await STATE["store"].write_json(f"jobs/{job.job_id}.json", job.model_dump())


async def finish(job: Job, status: Status, commit: bool | None, error: str | None = None) -> None:
    job.status, job.error = status, error
    job.finished_at = time.time()
    job.elapsed_s = round(job.finished_at - job.created_at, 1)
    if commit is not None:
        await STATE["ledger"].settle(job.job_id, commit, error or status)
    await save_job(job)
    if ev := DONE.get(job.job_id):
        ev.set()


async def run_job(job: Job) -> None:
    """Submit to GMI, then poll and store the result."""
    client: httpx.AsyncClient = STATE["gmi"]
    try:
        r = await client.post(QUEUE_URL, json={"model": job.model, "payload": job.payload})
        body = r.json() if r.content else {}
        if r.status_code >= 400:
            return await finish(job, "failed", False, f"GMI submit HTTP {r.status_code}: {pick(body, 'error', 'message') or body}")
        job.gmi_request_id = pick(body, "request_id", "id", "data.request_id", "data.id")
        if not job.gmi_request_id:
            return await finish(job, "failed", False, f"GMI submit returned no request_id: {str(body)[:300]}")
        job.status = "submitted"
        await save_job(job)
    except Exception as e:  # noqa: BLE001
        # Unknown whether GMI accepted it; keep the reserve rather than under-count.
        return await finish(job, "failed", None, f"submit {type(e).__name__}: {e}")
    await poll_job(job)


async def poll_job(job: Job) -> None:
    client: httpx.AsyncClient = STATE["gmi"]
    store: Store = STATE["store"]
    try:
        while time.time() - job.created_at < JOB_TIMEOUT_S:
            await asyncio.sleep(POLL_S)
            try:
                pr = await client.get(f"{QUEUE_URL}/{job.gmi_request_id}")
            except httpx.HTTPError:
                continue
            if pr.status_code >= 500:
                continue
            pb = pr.json()
            st = str(pick(pb, "status", "data.status") or "unknown").lower()
            changed = st != job.gmi_status
            job.gmi_status = st
            if st in ("processing", "dispatched", "running") and job.status != "processing":
                job.status = "processing"
            if st == "success":
                job.gmi_video_url = pick(pb, "outcome.media_urls.0.url", "outcome.video_url",
                                         "data.outcome.media_urls.0.url", "data.outcome.video_url")
                break
            if st in ("failed", "cancelled", "canceled", "error"):
                return await finish(job, "failed", False, f"GMI {st}: {str(pick(pb, 'error', 'message', 'outcome') or '')[:300]}")
            if changed:
                await save_job(job)
        else:
            return await finish(job, "timeout", None, f"no result after {JOB_TIMEOUT_S:.0f}s; reserve kept (may bill)")

        if not job.gmi_video_url:
            return await finish(job, "failed", True, "GMI success without a video URL")
        job.status = "downloading"
        key = f"videos/{job.job_id}.mp4"
        tmp = store.temp_path(key)
        # separate client: never send the GMI bearer to the storage host
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, read=300), follow_redirects=True) as dl:
            async with dl.stream("GET", job.gmi_video_url) as dr:
                dr.raise_for_status()
                with tmp.open("wb") as f:
                    async for chunk in dr.aiter_bytes():
                        f.write(chunk)
        await store.put_file(tmp, key, "video/mp4")
        await finish(job, "ready", True)
    except Exception as e:  # noqa: BLE001
        # GMI accepted the request, so we may be billed: commit rather than release.
        await finish(job, "failed", True, f"{type(e).__name__}: {e}")


def public(job: Job, request: Request) -> dict[str, Any]:
    d = job.model_dump()
    if job.status == "ready":
        base = PUBLIC_BASE or str(request.base_url).rstrip("/")
        if ON_CLOUD_RUN and base.startswith("http://"):
            base = "https://" + base[len("http://"):]  # TLS ends at Google's front end
        d["video_url"] = f"{base}/jobs/{job.job_id}/video"
    return d


async def recover_jobs() -> None:
    """After a restart: reload jobs, resume polling the ones GMI accepted."""
    for raw in await STATE["store"].list_json("jobs/"):
        job = Job(**raw)
        JOBS[job.job_id] = job
        if job.status in TERMINAL:
            continue
        DONE[job.job_id] = asyncio.Event()
        if job.gmi_request_id:
            asyncio.create_task(poll_job(job))
        else:
            await finish(job, "failed", None, "server restarted before submit finished; reserve kept")


# ---------------------------------------------------------------- app
@asynccontextmanager
async def lifespan(_: FastAPI):
    key = env("GMI_API_KEY")
    if not key:
        raise SystemExit("GMI_API_KEY not set (env or .env)")
    if ON_CLOUD_RUN and not TOKEN:
        raise SystemExit("MODEL_SERVER_TOKEN is required on Cloud Run: every call spends money")
    h = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if org := env("GMI_ORG_ID"):
        h["X-Organization-ID"] = org
    STATE["catalog"] = load_catalog()
    STATE["store"] = Store(GCS_BUCKET)
    STATE["ledger"] = Ledger(STATE["store"], SPEND_CAP)
    await STATE["ledger"].load()
    STATE["gmi"] = httpx.AsyncClient(headers=h, timeout=httpx.Timeout(60, read=120))
    await recover_jobs()
    yield
    await STATE["gmi"].aclose()


app = FastAPI(title="Distro video model server", lifespan=lifespan)


def auth(authorization: str | None = Header(None)) -> None:
    if TOKEN and not (authorization and secrets.compare_digest(authorization, f"Bearer {TOKEN}")):
        raise HTTPException(401, "missing or bad bearer token")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "models": len(STATE["catalog"]["models"]),
            "catalog_generated_at": STATE["catalog"]["generated_at"],
            "storage": "gcs" if GCS_BUCKET else "local"}


@app.get("/models", dependencies=[Depends(auth)])
def models(all: bool = False) -> dict[str, Any]:
    out = []
    probe = VideoRequest(prompt="x")
    for e in STATE["catalog"]["models"]:
        ok = e["selectable"] and e["text_to_video"] and e["supports_9_16"]
        if not ok and not all:
            continue
        try:
            est = build(e, probe).est_usd
        except ValueError:
            est = None
        out.append({"id": e["id"], "tier": e["featured"], "provider": e["provider"],
                    "est_usd_5s_720p": est, "text_to_video": e["text_to_video"],
                    "image_to_video": e["image_to_video"], "supports_9_16": e["supports_9_16"],
                    "audio_drive": "audio_drive" in e["map"], "description": e["description"]})
    return {"tiers": STATE["catalog"]["featured"], "models": out}


@app.get("/spend", dependencies=[Depends(auth)])
def spend() -> dict[str, Any]:
    return STATE["ledger"].summary()


@app.post("/generate", dependencies=[Depends(auth)])
async def generate(body: GenerateBody, request: Request, wait: bool = False, wait_timeout: float = 600) -> Any:
    entry = resolve_model(body.model)
    req = VideoRequest(**body.model_dump(exclude={"model", "dry_run"}))
    try:
        b = build(entry, req)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if b.est_usd > MAX_RENDER:
        raise HTTPException(402, f"{b.model} estimate ${b.est_usd:.2f} exceeds MAX_RENDER_USD ${MAX_RENDER:.2f}")
    if body.dry_run:
        return {"dry_run": True, "model": b.model, "payload": b.payload, "est_usd": b.est_usd,
                "duration_s": b.duration, "price_source": b.price_source, "warnings": b.warnings}

    job = Job(job_id=f"job_{secrets.token_hex(6)}", model=b.model, est_usd=b.est_usd,
              duration_s=b.duration, warnings=b.warnings, payload=b.payload)
    await STATE["ledger"].reserve(job.job_id, b.est_usd, f"{b.model} {b.duration:g}s")
    JOBS[job.job_id] = job
    DONE[job.job_id] = asyncio.Event()
    await save_job(job)
    asyncio.create_task(run_job(job))
    if wait:
        try:
            await asyncio.wait_for(DONE[job.job_id].wait(), timeout=wait_timeout)
        except asyncio.TimeoutError:
            pass  # return current status; client keeps polling GET /jobs/{id}
    return public(job, request)


@app.get("/jobs/{job_id}", dependencies=[Depends(auth)])
def get_job(job_id: str, request: Request) -> dict[str, Any]:
    if job_id not in JOBS:
        raise HTTPException(404, "unknown job")
    return public(JOBS[job_id], request)


@app.get("/jobs/{job_id}/video", dependencies=[Depends(auth)])
async def get_video(job_id: str) -> Response:
    job = JOBS.get(job_id)
    if not job or job.status != "ready":
        raise HTTPException(404, "video not ready")
    got = await STATE["store"].get_file(f"videos/{job_id}.mp4")
    if got is None:
        raise HTTPException(404, "video file missing")
    headers = {"Content-Disposition": f'inline; filename="{job_id}.mp4"'}
    if isinstance(got, Path):
        return FileResponse(got, media_type="video/mp4", headers=headers)
    return Response(got, media_type="video/mp4", headers=headers)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=env("HOST", "0.0.0.0"), port=int(env("PORT", "8787")))
