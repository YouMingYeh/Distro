# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi>=0.115", "uvicorn>=0.30", "httpx>=0.27", "pydantic>=2"]
# ///
"""Distro video model server: one HTTP endpoint in front of every GMI Cloud video model.

    POST /generate            start a job (any catalog model id, or a tier: fast / default / quality)
    POST /generate?wait=true  block until the video is ready (or wait_timeout), then return the job
    GET  /jobs/{id}           job status, cost, video_url
    GET  /jobs/{id}/video     the finished mp4
    GET  /models              selectable models with flags and a 5s estimate
    GET  /spend               spend cap, reserved, committed
    GET  /health

Run:
    uv run model_server/app.py                 # http://localhost:8787, GMI_API_KEY from env or .env

Env (all optional except GMI_API_KEY):
    GMI_API_KEY, GMI_ORG_ID
    SPEND_CAP_USD=9          global cap across all jobs, persisted in model_server/data/spend.json
    MAX_RENDER_USD=1.00      one job may not reserve more than this
    MODEL_SERVER_TOKEN       if set, require `Authorization: Bearer <token>`
    PUBLIC_BASE_URL          base for video_url (e.g. your cloudflared tunnel); default: request host
    PORT=8787, HOST=0.0.0.0

Costs are LIST-PRICE estimates reserved before submit. GMI keeps generating at a
negative balance, so this cap is the real limiter. Failed GMI jobs are refunded
by GMI, so their reserve is released; timeouts stay reserved (they may still bill).
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from gmi_video import VideoRequest, build, load_catalog  # noqa: E402

QUEUE_URL = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests"
DATA = HERE / "data"
VIDEOS = DATA / "videos"
LEDGER = DATA / "spend.json"
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


# ---------------------------------------------------------------- spend ledger
class Ledger:
    """Reserve -> commit/release, persisted so the cap survives restarts."""

    def __init__(self, path: Path, cap: float):
        self.path, self.cap = path, cap
        self.lock = asyncio.Lock()
        self.state = {"committed": 0.0, "reserved": {}, "entries": []}
        if path.exists():
            self.state = json.loads(path.read_text())

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.state, indent=1))

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
            self._save()

    async def settle(self, job: str, commit: bool, note: str = "") -> None:
        async with self.lock:
            usd = self.state["reserved"].pop(job, 0.0)
            if commit:
                self.state["committed"] += usd
            self._log("commit" if commit else "release", job, usd, note)
            self._save()


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


async def run_job(job: Job) -> None:
    client: httpx.AsyncClient = STATE["gmi"]
    ledger: Ledger = STATE["ledger"]
    settled = False

    async def finish(status: Status, commit: bool | None, error: str | None = None) -> None:
        nonlocal settled
        job.status, job.error = status, error
        job.finished_at = time.time()
        job.elapsed_s = round(job.finished_at - job.created_at, 1)
        if commit is not None and not settled:
            await ledger.settle(job.job_id, commit, error or status)
            settled = True
        DONE[job.job_id].set()

    try:
        r = await client.post(QUEUE_URL, json={"model": job.model, "payload": job.payload})
        body = r.json() if r.content else {}
        if r.status_code >= 400:
            return await finish("failed", False, f"GMI submit HTTP {r.status_code}: {pick(body, 'error', 'message') or body}")
        job.gmi_request_id = pick(body, "request_id", "id", "data.request_id", "data.id")
        if not job.gmi_request_id:
            return await finish("failed", False, f"GMI submit returned no request_id: {str(body)[:300]}")
        job.status = "submitted"

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
            job.gmi_status = st
            if st in ("processing", "dispatched", "running"):
                job.status = "processing"
            if st == "success":
                job.gmi_video_url = pick(pb, "outcome.media_urls.0.url", "outcome.video_url",
                                         "data.outcome.media_urls.0.url", "data.outcome.video_url")
                break
            if st in ("failed", "cancelled", "canceled", "error"):
                return await finish("failed", False, f"GMI {st}: {str(pick(pb, 'error', 'message', 'outcome') or '')[:300]}")
        else:
            return await finish("timeout", None, f"no result after {JOB_TIMEOUT_S:.0f}s; reserve kept (may bill)")

        if not job.gmi_video_url:
            return await finish("failed", True, "GMI success without a video URL")
        job.status = "downloading"
        dest = VIDEOS / f"{job.job_id}.mp4"
        # separate client: never send the GMI bearer to the storage host
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, read=300), follow_redirects=True) as dl:
            async with dl.stream("GET", job.gmi_video_url) as dr:
                dr.raise_for_status()
                with dest.open("wb") as f:
                    async for chunk in dr.aiter_bytes():
                        f.write(chunk)
        await finish("ready", True)
    except Exception as e:  # noqa: BLE001
        # If GMI accepted the request we may be billed: commit rather than release.
        await finish("failed", True if job.gmi_request_id else False, f"{type(e).__name__}: {e}")


def public(job: Job, request: Request) -> dict[str, Any]:
    d = job.model_dump()
    if job.status == "ready":
        base = PUBLIC_BASE or str(request.base_url).rstrip("/")
        d["video_url"] = f"{base}/jobs/{job.job_id}/video"
    return d


# ---------------------------------------------------------------- app
@asynccontextmanager
async def lifespan(_: FastAPI):
    key = env("GMI_API_KEY")
    if not key:
        raise SystemExit("GMI_API_KEY not set (env or .env)")
    h = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if org := env("GMI_ORG_ID"):
        h["X-Organization-ID"] = org
    VIDEOS.mkdir(parents=True, exist_ok=True)
    STATE["catalog"] = load_catalog()
    STATE["ledger"] = Ledger(LEDGER, SPEND_CAP)
    STATE["gmi"] = httpx.AsyncClient(headers=h, timeout=httpx.Timeout(60, read=120))
    yield
    await STATE["gmi"].aclose()


app = FastAPI(title="Distro video model server", lifespan=lifespan)


def auth(authorization: str | None = Header(None)) -> None:
    if TOKEN and not (authorization and secrets.compare_digest(authorization, f"Bearer {TOKEN}")):
        raise HTTPException(401, "missing or bad bearer token")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "models": len(STATE["catalog"]["models"]), "catalog_generated_at": STATE["catalog"]["generated_at"]}


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
def get_video(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    path = VIDEOS / f"{job_id}.mp4"
    if not job or job.status != "ready" or not path.exists():
        raise HTTPException(404, "video not ready")
    return FileResponse(path, media_type="video/mp4", filename=f"{job_id}.mp4")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=env("HOST", "0.0.0.0"), port=int(env("PORT", "8787")))
