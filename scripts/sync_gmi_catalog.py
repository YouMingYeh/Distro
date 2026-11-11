# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Pull the live GMI Cloud video-model catalog into src/data/gmi-video-models.json.

Every GMI request-queue model publishes its own parameter schema (names, types,
enum options, min/max) and pricing. This script normalizes the parameters each
video model calls by different names (ratio / aspect_ratio / aspectRatio,
duration / durationSeconds, first_frame / first_frame_image / image, ...) into a
single `map`, so the Worker and the bench script can build a payload for ANY
listed model from one normalized request instead of hand-writing each model.

The output contains no secrets and is safe to commit. Re-run it when GMI adds
models:

    uv run scripts/sync_gmi_catalog.py            # reads GMI_API_KEY from env or .env
    uv run scripts/sync_gmi_catalog.py --summary  # also print the selectable list
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

BASE = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/models"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "data" / "gmi-video-models.json"

# Curated picks shown first in the UI. Everything else stays selectable.
FEATURED = {
    "fast": ["gemini-omni-1.2-flash", "veo-3.1-lite-generate-001", "kling-3.0-turbo-t2v"],
    "default": ["wan3.0-video", "MiniMax-H3"],
    "quality": ["seedance-2-5-260628", "kling-v3-text-to-video", "wan3.0-video-prime"],
    "talking_head": ["heygen-avatar-4"],
}

# Normalized slot -> candidate parameter names, in priority order.
ALIASES: dict[str, list[str]] = {
    "prompt": ["prompt", "text", "input_text"],
    "negative_prompt": ["negative_prompt", "negativePrompt"],
    "duration": ["duration", "durationSeconds", "video_length"],
    "aspect": ["ratio", "aspect_ratio", "aspectRatio"],
    "resolution": ["resolution", "quality", "video_resolution"],
    "size": ["size"],  # enum of "W*H": aspect + resolution in one param (wan2.6)
    "width": ["width"],  # open-weight models: raw pixels
    "height": ["height"],
    "num_frames": ["num_frames"],  # open-weight models: duration = (frames - 1) / fps
    "fps": ["fps", "frame_rate"],
    "tier": ["mode"],  # Kling: std (720p) / pro (1080p) / 4k
    "first_frame": ["first_frame", "first_frame_image", "image", "image_url", "img_url", "image_path",
                    "path_input_image", "path_to_image", "first_frame_img", "start_frame_url"],
    "last_frame": ["last_frame", "last_frame_image", "lastFrame", "last_frame_img", "end_frame_url"],
    "reference_images": ["reference_image", "reference_images", "images"],
    "audio_drive": ["audio_url"],
    "video": ["video", "video_url", "input_video", "video_path"],  # source video to edit / extend / transform
    "reference_videos": ["reference_videos", "reference_video", "reference_video_urls", "ref_videos"],
    "audio_gen": ["generate_audio", "generateAudio", "generate_audio_switch", "sound", "audio"],
    "watermark": ["watermark"],
    "task": ["task"],
    "seed": ["seed"],
}


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


def slim_param(p: dict[str, Any]) -> dict[str, Any]:
    out = {k: p[k] for k in ("name", "type", "required", "default_value", "min_value", "max_value") if p.get(k) is not None}
    if p.get("options"):
        out["options"] = [o.get("value") for o in p["options"]]
    return out


def build_map(params: list[dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    by_name = {p["name"]: p for p in params}
    used: set[str] = set()
    m: dict[str, Any] = {}
    for slot, names in ALIASES.items():
        for n in names:
            p = by_name.get(n)
            if not p or n in used:
                continue
            # 'audio' and 'image' are ambiguous across models: check the type.
            if slot == "audio_gen" and n == "audio" and p.get("type") != "boolean":
                continue
            if slot == "video" and p.get("type") != "video":
                continue
            if slot == "first_frame" and n in ("image", "image_path") and p.get("type") not in ("first_frame_image", "image"):
                continue
            if slot == "first_frame" and n in ("image", "image_path") and (p.get("max_value") or 1) > 1:
                continue  # multi-image list is a reference set, not a first frame
            m[slot] = slim_param(p)
            used.add(n)
            break
    unmapped_required = [
        p["name"] for p in params
        if p.get("required") and p["name"] not in used and p.get("default_value") in (None, "")
    ]
    return m, unmapped_required


RES_RE = re.compile(r"(\d{3,4}\s*[pP]|[248]\s*[kK])[^$\d]{0,20}\$\s*(\d+(?:\.\d+)?)")


def parse_price(info: dict[str, Any] | None, details: str | None) -> dict[str, Any]:
    info = info or {}
    price: dict[str, Any] = {
        "unit": info.get("unit"),
        "base_usd": (info.get("price") or 0) / 1_000_000,
        "type": info.get("pricing_type"),
    }
    if info.get("price_chart"):
        price["chart"] = info["price_chart"]  # rates in micro-USD
    by_res = {}
    for res, usd in RES_RE.findall(details or ""):
        by_res[res.replace(" ", "").lower()] = float(usd)
    if by_res:
        price["by_resolution_usd_per_s"] = by_res
    if details:
        price["details"] = details.strip()[:400]
    return price


def entry(model: dict[str, Any]) -> dict[str, Any]:
    params = sorted(model.get("parameters") or [], key=lambda p: p.get("order", 999))
    m, unmapped = build_map(params)
    aspect_opts = [str(o) for o in (m.get("aspect", {}).get("options") or [])]
    for s in m.get("size", {}).get("options") or []:
        w, _, h = str(s).partition("*")
        if w.isdigit() and h.isdigit() and abs(int(h) / int(w) - 16 / 9) < 0.05:
            aspect_opts.append("9:16")
    if "width" in m and "height" in m:
        aspect_opts.append("9:16")  # free-form pixels: any ratio
    inputs = [i["type"] for i in (model.get("modalities") or {}).get("input", [])]
    required_inputs = [i["type"] for i in (model.get("modalities") or {}).get("input", []) if i.get("required")]
    tier = next((t for t, ids in FEATURED.items() if model["model"] in ids), None)
    return {
        "id": model["model"],
        "provider": model.get("external_provider") or (model.get("tags") or [None])[0],
        "tags": model.get("tags") or [],
        "featured": tier,
        "description": (model.get("brief_description") or "")[:300],
        "inputs": inputs,
        "required_inputs": required_inputs,
        "text_to_video": "prompt" in m and not any(t != "text" for t in required_inputs),
        "image_to_video": "first_frame" in m,
        "video_input": "video" in m,
        "reference_video": "reference_videos" in m,
        "supports_9_16": "9:16" in aspect_opts,
        "selectable": not unmapped and "prompt" in m,
        "unmapped_required": unmapped,
        "map": m,
        "price": parse_price(model.get("price_info"), model.get("pricing_details")),
        "params": [slim_param(p) for p in params],
    }


async def fetch_all(key: str) -> list[dict[str, Any]]:
    h = {"Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(headers=h, timeout=60) as c:
        ids = (await c.get(BASE)).raise_for_status().json()["model_ids"]
        sem = asyncio.Semaphore(16)

        async def one(i: str) -> dict[str, Any] | None:
            async with sem:
                try:
                    r = await c.get(f"{BASE}/{i}")
                    return r.json() if r.status_code == 200 else None
                except httpx.HTTPError:
                    return None

        print(f"fetching {len(ids)} model cards...", file=sys.stderr)
        return [m for m in await asyncio.gather(*(one(i) for i in ids)) if m]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--summary", action="store_true")
    a = ap.parse_args()

    models = asyncio.run(fetch_all(load_key()))
    video = [
        m for m in models
        if m.get("model_type") == "video" and m.get("status") == "active"
        and (m.get("model_metadata") or {}).get("visibility", "visible") == "visible"
    ]
    entries = sorted((entry(m) for m in video), key=lambda e: (e["featured"] is None, e["id"].lower()))
    doc = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": BASE,
        "featured": FEATURED,
        "models": entries,
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")

    sel = [e for e in entries if e["selectable"] and e["text_to_video"] and e["supports_9_16"]]
    missing = [f for ids in FEATURED.values() for f in ids if f not in {e["id"] for e in entries}]
    print(f"wrote {a.out.relative_to(ROOT)}: {len(entries)} active video models, "
          f"{len(sel)} text-to-video + 9:16 + fully mapped")
    if missing:
        print(f"WARNING featured ids not in live catalog: {missing}")
    if a.summary:
        for e in entries:
            flags = "".join([
                "T" if e["text_to_video"] else "-", "I" if e["image_to_video"] else "-",
                "9" if e["supports_9_16"] else "-", "A" if "audio_drive" in e["map"] else "-",
                "V" if e["video_input"] else "-", "R" if e["reference_video"] else "-",
                "" if e["selectable"] else f" unmapped={e['unmapped_required']}",
            ])
            print(f"  {e['featured'] or '':12} {e['id']:40} ${e['price']['base_usd']:.3f}/{e['price']['unit']}  {flags}")
        print("  flags: T=text-to-video I=first-frame 9=9:16 A=audio-driven V=source video R=reference video")


if __name__ == "__main__":
    main()
