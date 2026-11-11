# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Benchmark GMI Cloud video models on one 9:16 talking-head hook prompt.

Works with ANY video model in src/data/gmi-video-models.json (run
sync_gmi_catalog.py first): payloads are built from each model's published
parameter schema by gmi_video.build(). Submits all selected models at once,
polls, downloads the mp4s, and writes a timing and cost table.

Costs are LIST-PRICE ESTIMATES from the catalog, not billed amounts. GMI keeps
generating at a negative balance, so --budget here is the only limiter.

Usage (GMI_API_KEY from env or .env; never commit it):
    uv run scripts/bench_video_models.py --list                    # selectable models
    uv run scripts/bench_video_models.py --dry-run                 # payloads + estimate, no spend
    uv run scripts/bench_video_models.py                           # default 4, asks before spending
    uv run scripts/bench_video_models.py --models fast             # a featured tier
    uv run scripts/bench_video_models.py --models wan3.0-video pixverse-v6-t2v --yes
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "model_server"))
from gmi_video import Built, VideoRequest, build, load_catalog, resolve  # noqa: E402

QUEUE_URL = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests"
ROOT = Path(__file__).resolve().parent.parent

# Generic, brand-free UGC hook. Override with --prompt.
DEFAULT_PROMPT = (
    "Vertical 9:16 handheld selfie video filmed on a phone. A young adult in a "
    "casual, softly lit living room looks straight into the front camera and "
    "says with genuine excitement: \"Okay, why did nobody tell me about this "
    "app sooner?\" Natural daylight, authentic UGC style, slight handheld "
    "shake, clear speech with accurate lip sync, no text, no logos."
)
NEGATIVE = "blurry, distorted face, extra fingers, text, watermark, logo"
DEFAULT_SET = ["gemini-omni-1.2-flash", "wan3.0-video", "MiniMax-H3", "seedance-2-5-260628"]
TERMINAL_OK = {"success"}
TERMINAL_BAD = {"failed", "cancelled", "canceled", "error"}


@dataclass
class Run:
    built: Built
    tier: str | None
    request_id: str | None = None
    status: str = "pending"
    submitted_at: float = 0.0
    finished_at: float = 0.0
    video_url: str | None = None
    file: str | None = None
    error: str | None = None
    probe: dict[str, Any] = field(default_factory=dict)
    raw: list[dict[str, Any]] = field(default_factory=list)

    @property
    def model(self) -> str:
        return self.built.model

    @property
    def elapsed(self) -> float | None:
        return round(self.finished_at - self.submitted_at, 1) if self.finished_at else None


def load_key() -> str:
    key = os.environ.get("GMI_API_KEY")
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("GMI_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("GMI_API_KEY not found in env or .env")
    return key


def headers() -> dict[str, str]:
    h = {"Authorization": f"Bearer {load_key()}", "Content-Type": "application/json"}
    if org := os.environ.get("GMI_ORG_ID"):
        h["X-Organization-ID"] = org
    return h


def pick(d: Any, *paths: str) -> Any:
    """Return the first non-empty value among dotted paths (tolerant of shape drift)."""
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


def safe_name(model: str) -> str:
    return "".join(c if c.isalnum() or c in "-._" else "_" for c in model)


async def run_one(client: httpx.AsyncClient, run: Run, out: Path, poll_s: float, timeout_s: float) -> None:
    name = run.model
    try:
        r = await client.post(QUEUE_URL, json=run.built.body)
        run.submitted_at = time.time()
        body = r.json() if r.content else {}
        run.raw.append({"submit": body, "http": r.status_code})
        if r.status_code >= 400:
            raise RuntimeError(f"submit HTTP {r.status_code}: {str(body)[:300]}")
        run.request_id = pick(body, "request_id", "id", "data.request_id", "data.id")
        if not run.request_id:
            raise RuntimeError(f"no request_id in submit response: {str(body)[:300]}")
        print(f"[{name}] submitted {run.request_id}", flush=True)

        last = None
        while time.time() - run.submitted_at < timeout_s:
            await asyncio.sleep(poll_s)
            pr = await client.get(f"{QUEUE_URL}/{run.request_id}")
            if pr.status_code >= 500:
                continue
            pb = pr.json()
            st = str(pick(pb, "status", "data.status") or "unknown").lower()
            if st != last:
                print(f"[{name}] {st} at {time.time() - run.submitted_at:.0f}s", flush=True)
                last = st
            run.status = st
            if st in TERMINAL_OK:
                run.finished_at = time.time()
                run.raw.append({"final": pb})
                run.video_url = pick(pb, "outcome.media_urls.0.url", "outcome.video_url",
                                     "data.outcome.media_urls.0.url", "data.outcome.video_url")
                break
            if st in TERMINAL_BAD:
                run.finished_at = time.time()
                run.raw.append({"final": pb})
                raise RuntimeError(f"generation {st}: {str(pick(pb, 'error', 'message', 'outcome') or '')[:300]}")
        else:
            run.status = "timeout"
            raise RuntimeError(f"timed out after {timeout_s:.0f}s (request {run.request_id} may still bill)")

        if run.video_url:
            dest = out / f"{safe_name(name)}.mp4"
            # Separate client: never send the GMI bearer to the storage host.
            async with httpx.AsyncClient(timeout=httpx.Timeout(60, read=300), follow_redirects=True) as dl:
                async with dl.stream("GET", run.video_url) as dr:
                    dr.raise_for_status()
                    with dest.open("wb") as f:
                        async for chunk in dr.aiter_bytes():
                            f.write(chunk)
            run.file = str(dest)
            run.probe = ffprobe(dest)
            print(f"[{name}] done in {run.elapsed}s -> {dest}", flush=True)
        else:
            run.error = "success but no video URL in outcome (see raw)"
    except Exception as e:  # keep the other models running
        run.error = str(e)
        if run.status not in TERMINAL_BAD | {"timeout"}:
            run.status = "error"
        print(f"[{name}] ERROR {e}", flush=True)


def ffprobe(path: Path) -> dict[str, Any]:
    if not shutil.which("ffprobe"):
        return {}
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_type,width,height:format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        info = json.loads(res.stdout)
        v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
        has_audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
        return {"width": v.get("width"), "height": v.get("height"),
                "duration": round(float(info.get("format", {}).get("duration", 0)), 2),
                "audio": has_audio}
    except Exception:
        return {}


def report(runs: list[Run], out: Path, prompt: str) -> None:
    lines = [
        f"# Video model bench {out.name}", "", f"Prompt: {prompt}", "",
        "| model | tier | status | seconds | est. USD | output | audio | file |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in runs:
        p = r.probe
        dims = f"{p.get('width')}x{p.get('height')} {p.get('duration')}s" if p else "-"
        aspect = ""
        if p.get("width") and p.get("height"):
            aspect = " (9:16)" if abs(p["height"] / p["width"] - 16 / 9) < 0.05 else " (NOT 9:16)"
        lines.append(
            f"| {r.model} | {r.tier or ''} | {r.status} | {r.elapsed or '-'} | "
            f"{r.built.est_usd:.3f} | {dims}{aspect} | {p.get('audio', '-')} | {Path(r.file).name if r.file else '-'} |"
        )
    errs = [r for r in runs if r.error]
    if errs:
        lines += ["", "## Errors", ""] + [f"- `{r.model}`: {r.error}" for r in errs]
    total = sum(r.built.est_usd for r in runs if r.request_id and r.status not in TERMINAL_BAD)
    lines += ["", f"Estimated list-price spend (accepted requests, excludes failed/refunded): ${total:.2f}"]
    (out / "results.md").write_text("\n".join(lines) + "\n")
    (out / "results.json").write_text(json.dumps(
        [{"model": r.model, "tier": r.tier, "payload": r.built.payload, "duration": r.built.duration,
          "est_usd": r.built.est_usd, "price_source": r.built.price_source, "warnings": r.built.warnings,
          "request_id": r.request_id, "status": r.status, "elapsed_s": r.elapsed,
          "video_url": r.video_url, "file": r.file, "probe": r.probe, "error": r.error, "raw": r.raw}
         for r in runs], indent=2))
    print("\n" + "\n".join(lines))
    print(f"\nWrote {out / 'results.md'} and results.json")


def list_models(catalog: dict[str, Any], show_all: bool) -> None:
    req = VideoRequest(prompt="x")
    print(f"{'tier':12} {'model':40} {'5s 720p est':>11}  flags")
    for e in catalog["models"]:
        ok = e["selectable"] and e["text_to_video"] and e["supports_9_16"]
        if not ok and not show_all:
            continue
        try:
            b = build(e, req)
            est = f"${b.est_usd:.3f}"
        except ValueError:
            est = "n/a"
        flags = " ".join(f for f, on in (("t2v", e["text_to_video"]), ("i2v", e["image_to_video"]),
                                          ("9:16", e["supports_9_16"]), ("audio-drive", "audio_drive" in e["map"])) if on)
        print(f"{e['featured'] or '':12} {e['id']:40} {est:>11}  {flags}")
    print(f"\nfeatured tiers usable with --models: {', '.join(catalog['featured'])}"
          f"{'' if show_all else '   (--all to include models that are not t2v + 9:16)'}")


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", nargs="+", default=DEFAULT_SET, help="model ids or tiers: fast default quality")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--duration", type=int, default=5, help="seconds (snapped per model)")
    ap.add_argument("--resolution", default="720p")
    ap.add_argument("--aspect", default="9:16")
    ap.add_argument("--first-frame", help="public image URL for image-to-video")
    ap.add_argument("--audio-url", help="public wav/mp3 URL to drive lip sync (Wan)")
    ap.add_argument("--no-audio", action="store_true", help="turn off generated audio where switchable")
    ap.add_argument("--budget", type=float, default=3.0, help="refuse if total estimate exceeds this USD")
    ap.add_argument("--timeout", type=float, default=600, help="per-model timeout, seconds")
    ap.add_argument("--poll", type=float, default=10, help="poll interval, seconds")
    ap.add_argument("--out", default=str(ROOT / "bench_out"))
    ap.add_argument("--dry-run", action="store_true", help="print payloads and estimate only")
    ap.add_argument("--yes", action="store_true", help="skip the spend confirmation")
    ap.add_argument("--list", action="store_true", help="list selectable models and exit")
    ap.add_argument("--all", action="store_true", help="with --list, include every video model")
    a = ap.parse_args()

    catalog = load_catalog()
    if a.list:
        list_models(catalog, a.all)
        return

    req = VideoRequest(prompt=a.prompt, duration=a.duration, aspect=a.aspect, resolution=a.resolution,
                       negative_prompt=NEGATIVE, first_frame=a.first_frame, audio_url=a.audio_url,
                       audio=not a.no_audio)
    runs: list[Run] = []
    for e in resolve(catalog, a.models):
        try:
            runs.append(Run(build(e, req), e["featured"]))
        except ValueError as err:
            print(f"skip {e['id']}: {err}")
    if not runs:
        sys.exit("nothing to run")

    total = sum(r.built.est_usd for r in runs)
    print(f"{'model':40} {'dur':>5} {'est USD':>8}  price source / warnings")
    for r in runs:
        b = r.built
        print(f"{b.model:40} {b.duration:>5g} {b.est_usd:>8.3f}  {b.price_source}"
              + (f"  ! {'; '.join(b.warnings)}" if b.warnings else ""))
    print(f"{'TOTAL (list price estimate)':40} {'':>5} {total:>8.3f}  budget ${a.budget:.2f}")

    if a.dry_run:
        for r in runs:
            print(f"\n{json.dumps(r.built.body, indent=2)}")
        return
    if total > a.budget:
        sys.exit(f"Estimate ${total:.2f} exceeds --budget ${a.budget:.2f}. Drop models or raise --budget.")
    h = headers()
    if not a.yes:
        if input(f"Spend about ${total:.2f} on GMI? [y/N] ").strip().lower() != "y":
            sys.exit("Aborted, nothing submitted.")

    out = Path(a.out) / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(headers=h, timeout=httpx.Timeout(60, read=300), follow_redirects=True) as client:
        await asyncio.gather(*(run_one(client, r, out, a.poll, a.timeout) for r in runs))
    report(runs, out, a.prompt)


if __name__ == "__main__":
    asyncio.run(main())
