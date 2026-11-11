#!/usr/bin/env python3
"""Upload local files to Distro upload URLs with a streamed HTTP PUT.

Get an upload URL from the Distro MCP tool `create_upload`, then run this
script. The file is streamed from disk (never read fully into memory) and a
Content-Length header is always sent.

Single file:
  upload_footage.py --file clip.mp4 --url "https://..." \\
      --content-type video/mp4 --asset-id ast_123

Several files:
  upload_footage.py --manifest uploads.json
  where uploads.json is a JSON list of objects:
    {"file": "clip.mp4", "url": "https://...", "content_type": "video/mp4",
     "asset_id": "ast_123", "headers": {"X-Optional": "value"}}

Output (stdout) is one JSON object.
  Single file: {"ok": true, "status": 200, "asset_id": "ast_123",
                "bytes": 12345, "error": null}
  Manifest:    {"ok": true, "results": [ ...one object per file... ]}

Exit code is 0 when every upload succeeded, 1 otherwise, 2 on bad arguments.
After a successful upload, call the MCP tool `analyze_footage` with the
asset ids.
"""

import argparse
import http.client
import json
import mimetypes
import os
import ssl
import sys
from urllib.parse import urlsplit

CHUNK = 1024 * 1024

EXTRA_TYPES = {
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
    if ext in EXTRA_TYPES:
        return EXTRA_TYPES[ext]
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def put_file(path, url, content_type=None, asset_id=None, headers=None, timeout=600):
    result = {"ok": False, "status": None, "asset_id": asset_id, "bytes": 0, "error": None}
    if asset_id is None:
        result["file"] = path
    try:
        if not os.path.isfile(path):
            raise FileNotFoundError("file not found: %s" % path)
        size = os.path.getsize(path)
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("url must be http(s): %s" % url)
        target = parts.path or "/"
        if parts.query:
            target += "?" + parts.query
        if parts.scheme == "https":
            conn = http.client.HTTPSConnection(
                parts.hostname, parts.port or 443, timeout=timeout,
                context=ssl.create_default_context())
        else:
            conn = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=timeout)
        try:
            conn.putrequest("PUT", target)
            sent = {"content-length", "host"}
            conn.putheader("Content-Length", str(size))
            merged = {"Content-Type": content_type or guess_type(path)}
            for key, value in (headers or {}).items():
                merged[key] = value
            for key, value in merged.items():
                if key.lower() in sent:
                    continue
                sent.add(key.lower())
                conn.putheader(key, value)
            conn.endheaders()
            total = 0
            with open(path, "rb") as handle:
                while True:
                    chunk = handle.read(CHUNK)
                    if not chunk:
                        break
                    conn.send(chunk)
                    total += len(chunk)
            response = conn.getresponse()
            body = response.read(2000).decode("utf-8", "replace").strip()
            result["status"] = response.status
            result["bytes"] = total
            if 200 <= response.status < 300:
                result["ok"] = True
            else:
                result["error"] = "HTTP %d %s: %s" % (response.status, response.reason, body[:500])
        finally:
            conn.close()
    except Exception as exc:  # report every failure as JSON
        result["error"] = "%s: %s" % (type(exc).__name__, exc)
    return result


def parse_headers(items):
    headers = {}
    for item in items or []:
        if ":" not in item:
            raise ValueError('header must look like "Key: Value": %s' % item)
        key, value = item.split(":", 1)
        headers[key.strip()] = value.strip()
    return headers


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Stream local files to Distro upload URLs with HTTP PUT. Prints JSON.",
        epilog="After a successful upload, call the MCP tool analyze_footage with the asset ids.",
    )
    parser.add_argument("--file", help="Local path of the file to upload.")
    parser.add_argument("--url", help="upload_url returned by create_upload.")
    parser.add_argument("--content-type", help="Content-Type to send. Guessed from the extension if omitted.")
    parser.add_argument("--asset-id", help="asset_id returned by create_upload; echoed in the output.")
    parser.add_argument("--header", action="append", default=[], metavar='"K: V"',
                        help="Extra request header. May be repeated.")
    parser.add_argument("--manifest", help="JSON file with a list of {file,url,content_type,asset_id} objects.")
    parser.add_argument("--timeout", type=int, default=600, help="Socket timeout in seconds (default 600).")
    args = parser.parse_args(argv)

    try:
        extra = parse_headers(args.header)
    except ValueError as exc:
        print(json.dumps({"ok": False, "status": None, "asset_id": args.asset_id, "bytes": 0, "error": str(exc)}))
        return 2

    if args.manifest:
        try:
            with open(args.manifest, "r", encoding="utf-8") as handle:
                entries = json.load(handle)
            if isinstance(entries, dict):
                entries = entries.get("uploads") or entries.get("files") or []
            if not isinstance(entries, list) or not entries:
                raise ValueError("manifest must be a non-empty JSON list")
        except Exception as exc:
            print(json.dumps({"ok": False, "results": [], "error": "%s: %s" % (type(exc).__name__, exc)}))
            return 2
        base = os.path.dirname(os.path.abspath(args.manifest))
        results = []
        for entry in entries:
            path = str(entry.get("file", ""))
            if path and not os.path.isabs(path) and not os.path.exists(path):
                path = os.path.join(base, path)
            headers = dict(extra)
            headers.update(entry.get("headers") or {})
            results.append(put_file(
                path, str(entry.get("url", "")),
                content_type=entry.get("content_type"),
                asset_id=entry.get("asset_id"),
                headers=headers, timeout=args.timeout))
        ok = all(item["ok"] for item in results)
        print(json.dumps({"ok": ok, "results": results}))
        return 0 if ok else 1

    if not args.file or not args.url:
        print(json.dumps({"ok": False, "status": None, "asset_id": args.asset_id, "bytes": 0,
                          "error": "provide --file and --url, or --manifest"}))
        return 2

    result = put_file(args.file, args.url, content_type=args.content_type,
                      asset_id=args.asset_id, headers=extra, timeout=args.timeout)
    result.pop("file", None)
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
