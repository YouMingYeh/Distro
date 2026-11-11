#!/usr/bin/env python3
"""Describe local footage files before uploading them to Distro.

Prints one JSON object with a "files" list. Each entry has the values the
`create_upload` MCP tool needs (filename, size_bytes, content_type, sha256)
plus width, height, duration_ms and has_audio when ffprobe is installed.

Without ffprobe the media fields are null and "probed" is false; the Distro
server probes the file after upload, so this script is optional.

Example:
  prep_footage.py --files clip1.mp4 clip2.mov icon.png

Exit code is 0 when every file was readable, 1 otherwise.
"""

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys

TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def guess_type(path):
    ext = os.path.splitext(path)[1].lower()
    return TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path, ffprobe):
    out = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:300] or "ffprobe failed")
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = any(s.get("codec_type") == "audio" for s in streams)
    width = height = None
    if video:
        width, height = video.get("width"), video.get("height")
        rotation = 0
        for side in video.get("side_data_list") or []:
            if "rotation" in side:
                try:
                    rotation = int(float(side["rotation"]))
                except (TypeError, ValueError):
                    rotation = 0
        tag = (video.get("tags") or {}).get("rotate")
        if tag and not rotation:
            try:
                rotation = int(float(tag))
            except ValueError:
                rotation = 0
        if abs(rotation) % 180 == 90 and width and height:
            width, height = height, width
    duration = (data.get("format") or {}).get("duration")
    if duration is None and video:
        duration = video.get("duration")
    try:
        duration_ms = int(round(float(duration) * 1000))
    except (TypeError, ValueError):
        duration_ms = None
    return {"width": width, "height": height, "duration_ms": duration_ms, "has_audio": audio}


def describe(path, ffprobe, want_hash):
    entry = {
        "path": path,
        "filename": os.path.basename(path),
        "size_bytes": None,
        "content_type": guess_type(path),
        "sha256": None,
        "width": None,
        "height": None,
        "duration_ms": None,
        "has_audio": None,
        "probed": False,
        "warnings": [],
        "error": None,
    }
    if not os.path.isfile(path):
        entry["error"] = "file not found"
        return entry
    try:
        entry["size_bytes"] = os.path.getsize(path)
        if want_hash:
            entry["sha256"] = sha256_of(path)
    except OSError as exc:
        entry["error"] = str(exc)
        return entry
    if os.path.splitext(path)[1].lower() not in TYPES:
        entry["warnings"].append("unsupported_type")
    if not ffprobe:
        return entry
    try:
        entry.update(probe(path, ffprobe))
        entry["probed"] = True
        width, height = entry["width"], entry["height"]
        if width and height and abs(width / height - 9 / 16) > 0.01:
            entry["warnings"].append("not_9_16")
        if entry["content_type"].startswith("video/") and entry["has_audio"] is False:
            entry["warnings"].append("no_audio_track")
    except Exception as exc:  # keep going; the server probes again
        entry["warnings"].append("probe_failed: %s" % str(exc)[:200])
    return entry


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Describe local footage (size, type, sha256, and ffprobe facts). Prints JSON.",
        epilog="ffprobe is optional. Without it the media fields are null.",
    )
    parser.add_argument("--files", nargs="+", required=True, help="One or more local file paths.")
    parser.add_argument("--no-sha256", action="store_true", help="Skip hashing (faster on large files).")
    parser.add_argument("--ffprobe", default=None, help="Path to ffprobe (default: look on PATH).")
    args = parser.parse_args(argv)

    ffprobe = args.ffprobe or shutil.which("ffprobe")
    files = [describe(path, ffprobe, not args.no_sha256) for path in args.files]
    ok = all(item["error"] is None for item in files)
    print(json.dumps({"ok": ok, "ffprobe": bool(ffprobe), "files": files}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
