"""Build a GMI request-queue payload for ANY catalog video model from one normalized request.

Reads src/data/gmi-video-models.json (made by sync_gmi_catalog.py). The `map`
in each entry says which real parameter plays each normalized role; this module
turns a VideoRequest into that model's payload and a list-price estimate.
The TypeScript Worker adapter should port these same rules (they only read the
JSON, no per-model code).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CATALOG = Path(__file__).resolve().parent.parent / "src" / "data" / "gmi-video-models.json"


@dataclass
class VideoRequest:
    prompt: str
    duration: int = 5
    aspect: str = "9:16"
    resolution: str = "720p"
    negative_prompt: str | None = None
    first_frame: str | None = None  # public URL
    last_frame: str | None = None
    audio_url: str | None = None  # drives lip sync where supported (Wan 3.0, wan2.6/2.7)
    audio: bool = True  # generate an audio track where the model has a switch
    seed: int | None = None
    video: str | None = None  # public URL of a source video to edit / extend / transform
    video_task: str | None = None  # "edit" or "extend", for models that switch modes with `task`
    reference_videos: list[str] | None = None  # public URLs guiding motion, style or character


@dataclass
class Built:
    model: str
    payload: dict[str, Any]
    duration: float  # what the model will actually produce
    est_usd: float
    price_source: str
    warnings: list[str] = field(default_factory=list)

    @property
    def body(self) -> dict[str, Any]:
        return {"model": self.model, "payload": self.payload}


def load_catalog(path: Path = CATALOG) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"{path} missing: run `uv run scripts/sync_gmi_catalog.py` first")
    return json.loads(path.read_text())


def px(v: Any) -> int | None:
    """Short side in pixels for '720p', '768P', '2K', '1280*720', 'std', 'pro'..."""
    s = str(v).strip().lower()
    named = {"std": 720, "fast": 720, "pro": 1080, "4k": 2160, "2k": 1440, "8k": 4320}
    if s in named:
        return named[s]
    if m := re.fullmatch(r"(\d+)\s*[*x×]\s*(\d+)", s):
        return min(int(m[1]), int(m[2]))
    if m := re.fullmatch(r"(\d+)\s*p", s):
        return int(m[1])
    if m := re.fullmatch(r"(\d)\s*k", s):
        return {2: 1440, 4: 2160}.get(int(m[1]))
    return None


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _nearest(options: list[Any], target: float, key) -> Any:
    scored = [(abs(k - target), i, o) for i, o in enumerate(options) if (k := key(o)) is not None]
    return min(scored)[2] if scored else None


def _aspect_of(s: str) -> float | None:
    w, _, h = s.partition(":")
    return float(w) / float(h) if _num(w) and _num(h) else None


def build(entry: dict[str, Any], req: VideoRequest) -> Built:
    m: dict[str, Any] = entry["map"]
    p: dict[str, Any] = {}
    warn: list[str] = []
    want_px = px(req.resolution) or 720
    duration: float = req.duration

    def name(slot: str) -> str | None:
        return m[slot]["name"] if slot in m else None

    if "prompt" not in m:
        raise ValueError(f"{entry['id']}: no prompt parameter")
    p[name("prompt")] = req.prompt
    if req.negative_prompt and "negative_prompt" in m:
        p[name("negative_prompt")] = req.negative_prompt

    # duration
    if "duration" in m:
        d = m["duration"]
        if d.get("options"):
            opt = _nearest(d["options"], req.duration, _num)
            if opt is not None:
                p[d["name"]] = opt
                duration = _num(opt) or req.duration
        else:
            lo, hi = d.get("min_value", 1), d.get("max_value", 60)
            duration = max(lo, min(hi, req.duration))
            p[d["name"]] = int(duration) if d.get("type") == "integer" else duration
    elif "num_frames" in m:
        fps = _num(m.get("fps", {}).get("default_value")) or 24
        nf = m["num_frames"]
        frames = int(round(req.duration * fps)) + 1
        frames = max(int(nf.get("min_value") or 1), min(int(nf.get("max_value") or frames), frames))
        p[nf["name"]] = frames
        if "fps" in m:
            p[m["fps"]["name"]] = int(fps) if m["fps"].get("type") == "integer" else fps
        duration = (frames - 1) / fps
    if abs(duration - req.duration) > 0.01:
        warn.append(f"duration {req.duration}s -> {duration:g}s")

    # aspect ratio / size / raw pixels
    target_ar = _aspect_of(req.aspect) or 9 / 16
    if "aspect" in m:
        opts = [str(o) for o in m["aspect"].get("options") or []]
        if req.aspect in opts:
            p[m["aspect"]["name"]] = req.aspect
        elif req.first_frame and "adaptive" in opts:
            p[m["aspect"]["name"]] = "adaptive"
        else:
            warn.append(f"aspect {req.aspect} not offered ({opts}); output may need crop")
    if "size" in m:
        def size_key(o: Any) -> float | None:
            w, _, h = str(o).partition("*")
            if not (w.isdigit() and h.isdigit()):
                return None
            off = abs(int(w) / int(h) - target_ar) * 10_000  # aspect first, then resolution
            return off + abs(min(int(w), int(h)) - want_px)
        opt = _nearest(m["size"].get("options") or [], 0, size_key)
        if opt:
            p[m["size"]["name"]] = opt
    elif "width" in m and "height" in m:
        short = want_px
        long_ = int(round(short / min(target_ar, 1 / target_ar) / 16) * 16)
        w, h = (short, long_) if target_ar < 1 else (long_, short)
        w = min(w, int(m["width"].get("max_value") or w))
        h = min(h, int(m["height"].get("max_value") or h))
        p[m["width"]["name"]], p[m["height"]["name"]] = w, h
    elif "aspect" not in m and not (req.video and "video" in m):  # an edit follows the source framing
        warn.append("model has no aspect control; output is likely 16:9")

    # resolution (or Kling-style quality tier)
    if "resolution" in m and m["resolution"].get("options"):
        opt = _nearest(m["resolution"]["options"], want_px, px)
        if opt is not None:
            p[m["resolution"]["name"]] = opt
            if px(opt) != want_px:
                warn.append(f"resolution {req.resolution} -> {opt}")
    elif "tier" in m and m["tier"].get("options"):
        opt = _nearest(m["tier"]["options"], want_px, px)
        if opt is not None:
            p[m["tier"]["name"]] = opt

    # media inputs
    for slot, val in (("first_frame", req.first_frame), ("last_frame", req.last_frame),
                      ("audio_drive", req.audio_url)):
        if not val:
            continue
        if slot in m:
            p[name(slot)] = val
        elif slot == "first_frame" and "reference_images" in m:
            p[name("reference_images")] = [val]
        else:
            warn.append(f"{slot} not supported by this model; ignored")

    def put_videos(slot: str, urls: list[str]) -> None:
        q = m[slot]
        cap = q.get("max_value")
        if cap and len(urls) > int(cap):
            warn.append(f"{q['name']} takes at most {cap} video(s); extra ones dropped")
            urls = urls[: int(cap)]
        many = (cap is None and q.get("type") == "json") or (cap is not None and int(cap) > 1)
        p[q["name"]] = urls if many else urls[0]

    refs = list(req.reference_videos or [])
    if req.video:
        if "video" in m:
            put_videos("video", [req.video])
        elif "reference_videos" in m:
            refs = [req.video, *refs]
            warn.append("model has no source-video input; `video` used as a reference video instead")
        else:
            warn.append("video not supported by this model; ignored")
    if refs:
        if "reference_videos" in m:
            put_videos("reference_videos", refs)
        else:
            warn.append("reference_videos not supported by this model; ignored")

    if "task" in m:
        opts = [str(o) for o in m["task"].get("options") or []]
        if req.video and "video" in m:
            want = req.video_task or "edit"
        elif req.first_frame:
            want = "image_to_video"
        else:
            want = "text_to_video"
        if want in opts:
            p[name("task")] = want
        elif req.video_task:
            warn.append(f"video_task '{req.video_task}' not offered ({opts}); left to the model")

    # switches
    if "audio_gen" in m:
        a = m["audio_gen"]
        opts = [str(o) for o in a.get("options") or []]
        p[a["name"]] = ("on" if req.audio else "off") if "on" in opts else req.audio
    if "watermark" in m:
        p[name("watermark")] = False
    if req.seed is not None and "seed" in m:
        p[name("seed")] = req.seed

    missing = [q["name"] for q in entry["params"]
               if q.get("required") and q["name"] not in p and q.get("default_value") in (None, "")]
    if missing:
        vids = [q for q in missing if q in (m.get("video", {}).get("name"), m.get("reference_videos", {}).get("name"))]
        if vids:
            raise ValueError(f"{entry['id']} needs a source video: pass `video` (a public URL or an upload id)")
        raise ValueError(f"{entry['id']}: required params not covered: {missing}")

    est, src = estimate(entry, p, duration, req.audio)
    return Built(entry["id"], p, duration, est, src, warn)


def estimate(entry: dict[str, Any], payload: dict[str, Any], duration: float, audio: bool) -> tuple[float, str]:
    """List-price estimate in USD. Conservative where the catalog is ambiguous."""
    price = entry["price"]
    unit = (price.get("unit") or "second").lower()
    per_clip = unit in ("request", "video", "clip")
    mult = 1 if per_clip else math.ceil(duration)
    res_vals = [str(payload[s["name"]]) for k in ("resolution", "tier", "size") if (s := entry["map"].get(k)) and s["name"] in payload]
    res_px = px(res_vals[0]) if res_vals else None

    chart = price.get("chart")
    if chart and chart.get("rates"):
        node: Any = chart["rates"]
        for dim in chart.get("dimensions", []):
            if not isinstance(node, dict):
                break
            if dim["name"] == "resolution":
                key = next((k for k in node if res_px and px(k) == res_px), None) or dim.get("default")
            elif dim["name"] == "audio":
                key = "true" if audio else "false"
            else:
                key = dim.get("default")
            node = node.get(str(key).lower(), node.get(str(key)))
        if isinstance(node, (int, float)):
            return round(node / 1_000_000 * mult, 4), "price_chart"

    by_res = price.get("by_resolution_usd_per_s") or {}
    rate = next((v for k, v in by_res.items() if res_px and px(k) == res_px), None)
    src = "pricing_details"
    if rate is None:
        rate, src = price.get("base_usd") or 0.0, "base_price"
    # "$0.252 if audio is on", "$0.14 if 1080p"
    for usd, cond in re.findall(r"\$\s*(\d+(?:\.\d+)?)\s+if\s+([\w.]+)", price.get("details") or ""):
        c = cond.lower()
        if (c in ("audio", "sound") and audio) or (px(c) and px(c) == res_px):
            rate, src = max(rate, float(usd)), f"pricing_details ({cond})"
    return round(rate * mult, 4), src


def resolve(catalog: dict[str, Any], selectors: list[str]) -> list[dict[str, Any]]:
    """Selectors are model ids (case-insensitive) or featured tier names (fast/default/quality)."""
    by_id = {e["id"].lower(): e for e in catalog["models"]}
    out: list[dict[str, Any]] = []
    for s in selectors:
        ids = catalog["featured"].get(s, [s])
        for i in ids:
            e = by_id.get(i.lower())
            if not e:
                raise SystemExit(f"unknown model '{i}'. Run with --list to see ids.")
            if e not in out:
                out.append(e)
    return out
