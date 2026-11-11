#!/usr/bin/env node
// Distro ffmpeg HTTP service.
//
// A small HTTP server that edits short-form vertical videos with ffmpeg.
// The deployed Worker calls it at FFMPEG_SERVICE_URL (must be a public HTTPS
// URL, e.g. a tunnel in front of this process — the Worker cannot reach
// localhost).
//
//   GET  /health  -> 200 "ok"
//   POST /probe   -> { width, height, duration_ms, has_audio, content_type }
//   POST /frames  -> { duration_ms, width, height, frames: [{ at_ms, jpeg_base64 }] }
//   POST /edit    -> video/mp4 bytes (+ X-* headers) or JSON error
//
// Node built-ins only. Requires ffmpeg and ffprobe on PATH.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile, stat, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const HELP = `Distro ffmpeg service

Usage:
  node scripts/ffmpeg-service.mjs [--port 8788] [--host 127.0.0.1] [--allow-private]

Options:
  --port <n>        Port to listen on (default: $PORT or 8788)
  --host <h>        Interface to bind (default: 127.0.0.1). A non-loopback host
                    requires FFMPEG_SERVICE_TOKEN; the service refuses to start
                    without it.
  --allow-private   LOCAL DEVELOPMENT ONLY (for example next to "wrangler dev").
                    Lets the service download from loopback and private
                    addresses. Never use it behind a public tunnel.
  --help            Show this help

Environment:
  PORT                  Port, if --port is not given
  FFMPEG_SERVICE_TOKEN  If set, every request except GET /health must send
                        "Authorization: Bearer <token>"
  FFMPEG_ALLOWED_ORIGINS  Comma-separated origins the service may download
                        from and call back to, e.g.
                        "https://distro.example.workers.dev". When set, any
                        other origin (including redirect hops) is rejected.
                        Recommended whenever the service is publicly reachable.
  FFMPEG_ALLOW_PRIVATE  "1" is the same as --allow-private (local dev only)
  FFMPEG_FONT           Path to a .ttf/.otf/.ttc font used for burned-in text
  FFMPEG_BIN / FFPROBE_BIN   Override binary paths

Endpoints:
  GET  /health   200 "ok"
  POST /probe    {"url": "https://..."} -> {width,height,duration_ms,has_audio,content_type}
  POST /frames   {"url": "...", "count": 4, "width": 360} -> {duration_ms,width,height,frames:[{at_ms,jpeg_base64}]}
  POST /edit     see the build spec; returns video/mp4 with X-* headers

Downloads are restricted: http(s) only, no loopback / private / link-local
addresses (unless --allow-private), redirects re-checked hop by hop.

Expose it publicly for a deployed Worker, for example (set a token first):
  FFMPEG_SERVICE_TOKEN=... FFMPEG_ALLOWED_ORIGINS=https://<worker>.workers.dev \\
    node scripts/ffmpeg-service.mjs --port 8788
  npx cloudflared tunnel --url http://127.0.0.1:8788
`;

// ---------------------------------------------------------------- config

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}

const PORT = Number(argValue("--port") || process.env.PORT || 8788);
const HOST = argValue("--host") || process.env.HOST || "127.0.0.1";
const TOKEN = process.env.FFMPEG_SERVICE_TOKEN || "";
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN || "ffprobe";
const ALLOW_PRIVATE = process.argv.includes("--allow-private") || process.env.FFMPEG_ALLOW_PRIVATE === "1";
const ALLOWED_ORIGINS = new Set(
  (process.env.FFMPEG_ALLOWED_ORIGINS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      try {
        return new URL(x).origin;
      } catch {
        process.stderr.write(`FFMPEG_ALLOWED_ORIGINS: "${x}" is not a valid origin (expected e.g. https://host).\n`);
        process.exit(1);
      }
    }),
);
const MAX_REDIRECTS = 3;
// ffmpeg/ffprobe may only open local files for downloaded inputs, so a crafted
// playlist or container cannot make them fetch network resources.
const FILE_ONLY = ["-protocol_whitelist", "file"];

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const FFMPEG_TIMEOUT_MS = 240_000;
const FPS = 30;
const END_CARD_S = 2.5;
const AI_LABEL_TEXT = "AI-generated";

const FONT_CANDIDATES = [
  process.env.FFMPEG_FONT,
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  "C:\\Windows\\Fonts\\arialbd.ttf",
].filter(Boolean);
const FONT_PATH = FONT_CANDIDATES.find((p) => existsSync(p)) || null;

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "Request JSON is larger than 1 MB.");
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
}

function run(bin, args, { cwd, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new HttpError(500, `Could not start ${bin}: ${e.message}. Is it installed and on PATH?`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function stderrTail(s, n = 900) {
  const t = String(s || "").trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}

const EXT_BY_TYPE = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-m4v": ".m4v",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};
const SAFE_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".png", ".jpg", ".jpeg", ".webp"]);

// ------------------------------------------------- outbound request guard
//
// Every URL this service fetches comes from a request body, so each one is
// checked before any connection is made: http(s) only, optional origin
// allowlist, and no loopback / private / link-local / CGNAT / unique-local /
// multicast / unspecified destination. The addresses that passed the check
// are the ones the socket connects to (pinned lookup), so a hostname cannot
// resolve differently between check and connect. Redirects are followed by
// hand and every hop goes through the same checks.

function ipv4Blocked(a, b) {
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 192 && b === 0) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return null;
}

// Expand an IPv6 literal to 8 16-bit groups, or null if it is not valid.
function ipv6Groups(addr) {
  let s = addr.split("%")[0];
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return null;
    s = s.slice(0, v4.index) + ((n[0] << 8) | n[1]).toString(16) + ":" + ((n[2] << 8) | n[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

// Returns a reason string when the address must not be contacted, else null.
function blockedAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return ipv4Blocked(a, b);
  }
  if (kind !== 6) return "not an IP address";
  const g = ipv6Groups(address);
  if (!g) return "unparseable IPv6 address";
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  // Addresses that embed an IPv4 address are judged by that IPv4 address.
  const embedded = () => ipv4Blocked(g[6] >> 8, g[6] & 0xff);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return embedded() ? `IPv4-mapped ${embedded()}` : null; // ::ffff:a.b.c.d
  }
  if (g.slice(0, 6).every((x) => x === 0)) return "reserved"; // ::a.b.c.d (deprecated IPv4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return embedded() ? `NAT64 ${embedded()}` : null; // 64:ff9b::a.b.c.d
  }
  if ((g[0] & 0xfe00) === 0xfc00) return "unique-local";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xff00) === 0xff00) return "multicast";
  return null;
}

// Validate a URL and resolve it. Returns { url, addresses } with the addresses
// the connection must use. Throws HttpError(400) for anything not allowed.
async function checkDestination(rawUrl, what) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new HttpError(400, `Invalid URL for ${what}.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new HttpError(400, `URL for ${what} must be http(s).`);
  }
  if (u.username || u.password) throw new HttpError(400, `URL for ${what} must not contain credentials.`);
  if (ALLOWED_ORIGINS.size && !ALLOWED_ORIGINS.has(u.origin)) {
    throw new HttpError(400, `Blocked URL for ${what}: origin ${u.origin} is not in FFMPEG_ALLOWED_ORIGINS.`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await dns.promises.lookup(host, { all: true });
    } catch (e) {
      throw new HttpError(502, `Could not resolve host for ${what} (${u.hostname}): ${e.code || e.message}`);
    }
    if (!addresses.length) throw new HttpError(502, `Host for ${what} (${u.hostname}) has no addresses.`);
  }
  if (!ALLOW_PRIVATE) {
    for (const a of addresses) {
      const why = blockedAddress(a.address);
      if (why) {
        throw new HttpError(
          400,
          `Blocked URL for ${what}: ${u.hostname} resolves to a ${why} address. This service only fetches public URLs` +
            ` (start it with --allow-private for local development only).`,
        );
      }
    }
  }
  return { url: u, addresses };
}

// One HTTP(S) request to an already-checked destination, connecting only to
// the checked addresses. Resolves with the IncomingMessage (not consumed).
function pinnedRequest({ url, addresses }, { method = "GET", headers = {}, bodyStream = null, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const lookup = (_hostname, opts, cb) => {
      if (opts && opts.all) cb(null, addresses);
      else cb(null, addresses[0].address, addresses[0].family);
    };
    const req = mod.request(url, { method, headers, lookup, agent: false }, resolve);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (bodyStream) {
      bodyStream.on("error", (e) => req.destroy(e));
      bodyStream.pipe(req);
    } else {
      req.end();
    }
  });
}

// GET with manual, re-validated redirects. Resolves with { resp, finalUrl }.
async function guardedGet(rawUrl, what) {
  let target = await checkDestination(rawUrl, what);
  for (let hop = 0; ; hop++) {
    const resp = await pinnedRequest(target);
    const status = resp.statusCode || 0;
    if (status >= 300 && status < 400 && resp.headers.location) {
      resp.resume();
      if (hop >= MAX_REDIRECTS) throw new HttpError(400, `Too many redirects (more than ${MAX_REDIRECTS}) while fetching ${what}.`);
      let next;
      try {
        next = new URL(resp.headers.location, target.url);
      } catch {
        throw new HttpError(502, `${what} redirected to an invalid Location.`);
      }
      target = await checkDestination(next.href, `${what} (redirect hop ${hop + 1})`);
      continue;
    }
    return { resp, finalUrl: target.url };
  }
}

async function download(url, dir, name) {
  let resp;
  let u;
  for (let attempt = 1; ; attempt++) {
    try {
      const got = await guardedGet(url, name);
      resp = got.resp;
      u = got.finalUrl;
      if ((resp.statusCode || 0) < 500 || attempt >= 3) break;
      resp.resume();
    } catch (e) {
      // Policy and validation failures are final; only network errors retry.
      if (e instanceof HttpError && e.status === 400) throw e;
      if (attempt >= 3) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, `Could not download ${name}: ${e?.code || e?.message || e}`);
      }
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  const status = resp.statusCode || 0;
  if (status < 200 || status >= 300) {
    resp.resume();
    throw new HttpError(502, `Could not download ${name}: HTTP ${status} from ${u.origin}${u.pathname}`);
  }
  const declared = Number(resp.headers["content-length"] || 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    resp.destroy();
    throw new HttpError(413, `${name} is larger than the download limit.`);
  }
  const contentType = String(resp.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const urlExt = path.extname(u.pathname).toLowerCase();
  const ext = SAFE_EXTS.has(urlExt) ? urlExt : EXT_BY_TYPE[contentType] || ".bin";
  const file = path.join(dir, `${name}${ext}`);
  let size = 0;
  resp.on("data", (c) => {
    size += c.length;
    if (size > MAX_DOWNLOAD_BYTES) resp.destroy(new Error("download limit exceeded"));
  });
  try {
    await pipeline(resp, createWriteStream(file));
  } catch (e) {
    throw new HttpError(502, `Download of ${name} failed: ${e.message}`);
  }
  if (size === 0) throw new HttpError(502, `${name} downloaded as an empty file.`);
  return { file, base: path.basename(file), contentType, size };
}

// Run async jobs with a small concurrency limit, keeping result order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function probeFile(file) {
  const r = await run(
    FFPROBE,
    ["-v", "error", ...FILE_ONLY, "-print_format", "json", "-show_format", "-show_streams", file],
    { timeoutMs: 30_000 },
  );
  if (r.code !== 0) {
    const detail = stderrTail(r.stderr, 300).split(path.dirname(file) + path.sep).join("");
    throw new HttpError(422, `ffprobe could not read the file: ${detail}`);
  }
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new HttpError(500, "ffprobe returned unreadable output.");
  }
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === "audio");
  let width = v ? Number(v.width) || 0 : 0;
  let height = v ? Number(v.height) || 0 : 0;
  if (v) {
    let rot = Number(v.tags?.rotate || 0);
    for (const sd of v.side_data_list || []) {
      if (sd.rotation !== undefined) rot = Number(sd.rotation);
    }
    if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  }
  const durS = Number(j.format?.duration || v?.duration || a?.duration || 0);
  return {
    width,
    height,
    duration_ms: Number.isFinite(durS) ? Math.round(durS * 1000) : 0,
    has_audio: Boolean(a),
    has_video: Boolean(v),
  };
}

// Greedy word wrap. drawtext does not wrap, so every line is its own filter.
function wrapText(text, maxChars, maxLines) {
  const words = String(text || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let cur = "";
  for (let w of words) {
    while (w.length > maxChars) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…";
    return kept;
  }
  return lines;
}

const num = (n) => Number(n).toFixed(3);

// Scale/crop any input to exactly W x H.
// Returns filter text that consumes `inLabel` and produces `outLabel`.
function fitFilter(inLabel, outLabel, meta, W, H, uid) {
  const target = W / H;
  const ar = meta.width > 0 && meta.height > 0 ? meta.width / meta.height : target;
  const tail = `setsar=1,fps=${FPS},format=yuv420p`;
  if (ar <= target * 1.001) {
    // Taller than target (typical phone screen recording): fill the width,
    // crop height. Trim a little more off the top (status bar) than the bottom.
    return `${inLabel}scale=${W}:-2,crop=${W}:${H}:0:(ih-${H})*0.6,${tail}${outLabel}`;
  }
  if (ar <= target * 1.35) {
    // Slightly wider than target: fill the height and center-crop the sides.
    return `${inLabel}scale=-2:${H},crop=${W}:${H}:(iw-${W})/2:0,${tail}${outLabel}`;
  }
  // Landscape or square: fit to width over a blurred, darkened copy.
  return (
    `${inLabel}split=2[fbg${uid}][ffg${uid}];` +
    `[fbg${uid}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.25[fbb${uid}];` +
    `[ffg${uid}]scale=${W}:-2[ffs${uid}];` +
    `[fbb${uid}][ffs${uid}]overlay=(W-w)/2:(H-h)/2,${tail}${outLabel}`
  );
}

// ---------------------------------------------------------------- edit

async function buildEdit(reqBody, dir) {
  const W = Math.round(Number(reqBody.width) || 1080);
  const H = Math.round(Number(reqBody.height) || 1920);
  if (W < 180 || H < 320 || W > 2160 || H > 3840 || W % 2 || H % 2) {
    throw new HttpError(400, "width/height must be even and between 180x320 and 2160x3840.");
  }
  const bodyList = (Array.isArray(reqBody.body) ? reqBody.body : [reqBody.body])
    .filter((b) => b && b.url)
    .slice(0, 12);
  if (!bodyList.length) {
    throw new HttpError(400, "body.url is required (the footage clip to cut from). body may also be an array of {url, max_ms}.");
  }
  const audioList = (Array.isArray(reqBody.audio) ? reqBody.audio : [reqBody.audio])
    .filter((a) => a && a.url)
    .slice(0, 24);
  const hookText = typeof reqBody.hook_text === "string" ? reqBody.hook_text.trim() : "";
  const hasHookClip = Boolean(reqBody.hook && reqBody.hook.url);
  if (!hasHookClip && !hookText) {
    throw new HttpError(400, "Provide hook.url (a hook clip) or hook_text (for a text hook card).");
  }
  const S = W / 1080; // layout scale

  // --- downloads
  const hookDl = hasHookClip ? await download(reqBody.hook.url, dir, "hook") : null;
  const bodyDls = await mapLimit(bodyList, 3, (b, i) => download(b.url, dir, `body${i}`));
  const audioDls = await mapLimit(audioList, 3, (a, i) => download(a.url, dir, `tts${i}`));
  let iconDl = null;
  if (reqBody.end_card_icon_url) {
    try {
      iconDl = await download(reqBody.end_card_icon_url, dir, "icon");
    } catch {
      iconDl = null; // the icon is decorative; never fail the edit over it
    }
  }

  // --- probes
  const hookMeta = hookDl ? await probeFile(hookDl.file) : null;
  if (hookMeta && !hookMeta.has_video) throw new HttpError(422, "hook has no video stream.");

  // Body segments: each trimmed to its own max_ms, the sum capped by body_max_ms.
  let bodyBudget = Math.max(1, (Number(reqBody.body_max_ms) || 15000) / 1000);
  const bodies = [];
  for (let i = 0; i < bodyDls.length; i++) {
    const meta = await probeFile(bodyDls[i].file);
    if (!meta.has_video) throw new HttpError(422, `body[${i}] has no video stream.`);
    let d = meta.duration_ms / 1000;
    const own = Number(bodyList[i].max_ms);
    if (own > 0) d = Math.min(d, own / 1000);
    d = Math.min(d, bodyBudget);
    if (!(d > 0.2)) continue; // still image, too short, or budget used up
    bodies.push({ dl: bodyDls[i], meta, d });
    bodyBudget -= d;
  }
  if (!bodies.length) {
    throw new HttpError(422, "body must contain at least one video clip longer than 0.2s (still images are not supported).");
  }
  const bodyD = bodies.reduce((n, b) => n + b.d, 0);

  // Audio clips: placed at start_ms, or back to back from 0.
  const audios = [];
  let audioCursor = 0;
  for (let i = 0; i < audioDls.length; i++) {
    const meta = await probeFile(audioDls[i].file);
    if (!meta.has_audio) throw new HttpError(422, `audio[${i}] has no audio stream.`);
    const given = Number(audioList[i].start_ms);
    const start = Number.isFinite(given) && given >= 0 && audioList[i].start_ms != null ? given : audioCursor;
    audios.push({ dl: audioDls[i], start_ms: Math.round(start) });
    audioCursor = start + meta.duration_ms;
  }

  let hookD;
  if (hookMeta) {
    hookD = hookMeta.duration_ms / 1000;
    if (!(hookD > 0.2)) throw new HttpError(422, "hook clip is too short to use.");
    hookD = Math.min(hookD, 30);
  } else {
    hookD = Math.min(Math.max((Number(reqBody.hook_duration_ms) || 4000) / 1000, 1), 15);
  }
  const total = hookD + bodyD + END_CARD_S;

  // --- font
  let fontOpt = "";
  if (FONT_PATH) {
    const fontName = "font" + (path.extname(FONT_PATH).toLowerCase() || ".ttf");
    await copyFile(FONT_PATH, path.join(dir, fontName));
    fontOpt = `fontfile=${fontName}:`;
  }

  // --- text files (user text never enters the filter string)
  let textN = 0;
  async function textFile(text) {
    const name = `t${textN++}.txt`;
    await writeFile(path.join(dir, name), text, "utf8");
    return name;
  }
  // One centered drawtext per line, stacked from yTop.
  async function drawLines(lines, { size, yTop, lineGap = 1.28, color = "white", box = false, enable = "", border = 3 }) {
    const parts = [];
    for (let i = 0; i < lines.length; i++) {
      const f = await textFile(lines[i]);
      const y = Math.round(yTop + i * size * lineGap);
      parts.push(
        `drawtext=${fontOpt}textfile=${f}:expansion=none:fontsize=${size}:fontcolor=${color}` +
          `:x=(w-text_w)/2:y=${y}:borderw=${border}:bordercolor=black@0.9` +
          (box ? `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(size * 0.28)}` : "") +
          (enable ? `:enable='${enable}'` : ""),
      );
    }
    return parts;
  }

  // --- inputs
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  let nIn = 0;
  const addInput = (...a) => {
    args.push(...a);
    return nIn++;
  };
  const hookIdx = hookDl
    ? addInput(...FILE_ONLY, "-i", hookDl.base)
    : addInput("-f", "lavfi", "-i", `color=c=0x111318:s=${W}x${H}:r=${FPS}:d=${num(hookD)}`);
  for (const b of bodies) b.idx = addInput(...FILE_ONLY, "-i", b.dl.base);
  const endIdx = addInput("-f", "lavfi", "-i", `color=c=0x111318:s=${W}x${H}:r=${FPS}:d=${num(END_CARD_S)}`);
  for (const a of audios) a.idx = addInput(...FILE_ONLY, "-i", a.dl.base);
  const iconIdx = iconDl ? addInput(...FILE_ONLY, "-loop", "1", "-t", num(END_CARD_S), "-i", iconDl.base) : -1;
  // Quiet generated bed: a soft low chord with slow tremolo. No third-party audio.
  const bedIdx = addInput(
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=exprs='(0.050*sin(2*PI*110*t)+0.036*sin(2*PI*164.81*t)+0.028*sin(2*PI*220*t))*(0.75+0.25*sin(2*PI*0.2*t))':s=48000:d=${num(total)}`,
  );

  const fc = [];

  // --- hook video
  if (hookDl) {
    fc.push(fitFilter(`[${hookIdx}:v]`, "[hfit]", hookMeta, W, H, "h"));
    fc.push(`[hfit]trim=duration=${num(hookD)},setpts=PTS-STARTPTS[hv]`);
  } else {
    const size = Math.round(84 * S);
    const lines = wrapText(hookText, 20, 7);
    const blockH = lines.length * size * 1.28;
    const dt = await drawLines(lines, { size, yTop: (H - blockH) / 2, border: 0 });
    fc.push(`[${hookIdx}:v]${dt.join(",")},setsar=1,fps=${FPS},format=yuv420p[hv]`);
  }

  // --- body video
  bodies.forEach((b, i) => {
    fc.push(fitFilter(`[${b.idx}:v]`, `[bfit${i}]`, b.meta, W, H, `b${i}`));
    fc.push(`[bfit${i}]trim=duration=${num(b.d)},setpts=PTS-STARTPTS[bv${i}]`);
  });

  // --- end card
  const cta = typeof reqBody.cta === "string" ? reqBody.cta.trim() : "";
  const wantLabel = reqBody.ai_label !== false && reqBody.ai_label !== 0;
  {
    const chain = [];
    const ctaSize = Math.round(72 * S);
    const ctaLines = cta ? wrapText(cta, 24, 5) : [];
    const ctaBlockH = ctaLines.length * ctaSize * 1.28;
    const iconSize = Math.round(280 * S);
    const iconGap = Math.round(70 * S);
    const groupH = (iconDl ? iconSize + iconGap : 0) + ctaBlockH;
    const top = Math.round((H - groupH) / 2);
    let cur = `[${endIdx}:v]`;
    if (iconDl) {
      fc.push(
        `[${iconIdx}:v]scale=${iconSize}:${iconSize}:force_original_aspect_ratio=decrease,format=rgba[icn]`,
      );
      fc.push(`${cur}[icn]overlay=(W-w)/2:${top}+(${iconSize}-h)/2:shortest=0:eof_action=repeat[ecb]`);
      cur = "[ecb]";
    }
    if (ctaLines.length) {
      chain.push(
        ...(await drawLines(ctaLines, {
          size: ctaSize,
          yTop: top + (iconDl ? iconSize + iconGap : 0),
          border: 0,
        })),
      );
    }
    if (wantLabel) {
      // Larger, unmistakable label on the end card itself.
      chain.push(
        ...(await drawLines([AI_LABEL_TEXT], {
          size: Math.round(44 * S),
          yTop: H - Math.round(260 * S),
          color: "white@0.85",
          border: 0,
        })),
      );
    }
    chain.push(`trim=duration=${num(END_CARD_S)}`, "setpts=PTS-STARTPTS", "setsar=1", `fps=${FPS}`, "format=yuv420p");
    fc.push(`${cur}${chain.join(",")}[ev]`);
  }

  // --- concat + overlays
  fc.push(`[hv]${bodies.map((_, i) => `[bv${i}]`).join("")}[ev]concat=n=${bodies.length + 2}:v=1:a=0[vc]`);
  const overlay = [];
  let captionCount = 0;
  const capSize = Math.round(62 * S);
  for (const c of Array.isArray(reqBody.captions) ? reqBody.captions.slice(0, 80) : []) {
    if (!c || typeof c.text !== "string" || !c.text.trim()) continue;
    const s = Math.max(0, Number(c.start_ms) / 1000);
    const e = Math.min(total, Number(c.end_ms) / 1000);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const lines = wrapText(c.text, 24, 4);
    overlay.push(
      ...(await drawLines(lines, {
        size: capSize,
        yTop: Math.round(H * 0.68),
        lineGap: 1.5,
        box: true,
        enable: `between(t,${num(s)},${num(e)})`,
      })),
    );
    captionCount++;
  }
  if (wantLabel) {
    // Persistent corner label for the whole video.
    const f = await textFile(AI_LABEL_TEXT);
    const sz = Math.round(34 * S);
    overlay.push(
      `drawtext=${fontOpt}textfile=${f}:expansion=none:fontsize=${sz}:fontcolor=white` +
        `:x=w-text_w-${Math.round(36 * S)}:y=${Math.round(120 * S)}` +
        `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(14 * S)}`,
    );
  }
  fc.push(`[vc]${overlay.length ? overlay.join(",") : "null"}[vout]`);

  // --- audio
  const AFMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const mix = [];
  if (audios.length) {
    audios.forEach((a, i) => {
      fc.push(
        `[${a.idx}:a]${AFMT},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,adelay=${a.start_ms}:all=1[asp${i}]`,
      );
      mix.push(`[asp${i}]`);
    });
  } else if (hookMeta && hookMeta.has_audio) {
    fc.push(
      `[${hookIdx}:a]${AFMT},atrim=duration=${num(hookD)},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[asp]`,
    );
    mix.push("[asp]");
  }
  let bodyOffset = hookD;
  bodies.forEach((b, i) => {
    if (b.meta.has_audio) {
      fc.push(
        `[${b.idx}:a]${AFMT},atrim=duration=${num(b.d)},asetpts=PTS-STARTPTS,volume=0.25,adelay=${Math.round(bodyOffset * 1000)}:all=1[abd${i}]`,
      );
      mix.push(`[abd${i}]`);
    }
    bodyOffset += b.d;
  });
  fc.push(`[${bedIdx}:a]${AFMT},afade=t=in:d=0.4,afade=t=out:st=${num(Math.max(0, total - 0.6))}:d=0.6[abed]`);
  mix.push("[abed]");
  fc.push(
    `${mix.join("")}amix=inputs=${mix.length}:duration=longest:dropout_transition=0:normalize=0,` +
      `alimiter=limit=0.95,atrim=duration=${num(total)},asetpts=PTS-STARTPTS[aout]`,
  );

  args.push(
    "-filter_complex", fc.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-t", num(total),
    "-r", String(FPS),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    "out.mp4",
  );

  const r = await run(FFMPEG, args, { cwd: dir });
  const outFile = path.join(dir, "out.mp4");
  if (r.code !== 0 || !existsSync(outFile)) {
    const why = r.signal ? `timed out or was killed (${r.signal})` : `exited with code ${r.code}`;
    throw new HttpError(500, `ffmpeg ${why}. Check that the inputs are valid video/audio files. stderr: ${stderrTail(r.stderr)}`);
  }
  const outMeta = await probeFile(outFile);
  const outStat = await stat(outFile);
  return {
    outFile,
    size: outStat.size,
    meta: outMeta,
    hasCaptions: captionCount > 0,
    hasLabel: wantLabel,
  };
}

// Edits run one at a time; ffmpeg already uses every core.
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function handleEdit(req, res) {
  const body = await readJson(req);
  const outputKey = typeof body.output_key === "string" ? body.output_key : "";
  const started = Date.now();
  const wantsCallback = typeof body.callback_url === "string" && body.callback_url;
  // Reject a disallowed callback before doing any work (it is re-checked and pinned at send time).
  if (wantsCallback) await checkDestination(body.callback_url, "callback_url");
  await enqueue(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "distro-edit-"));
    try {
      const out = await buildEdit(body, dir);
      const facts = {
        width: out.meta.width,
        height: out.meta.height,
        duration_ms: out.meta.duration_ms,
        has_audio: out.meta.has_audio,
        has_captions: out.hasCaptions,
        has_ai_label: out.hasLabel,
      };
      log(`edit ${body.job_id || "-"} ok ${facts.width}x${facts.height} ${facts.duration_ms}ms ${out.size}B in ${Date.now() - started}ms`);

      if (typeof body.callback_url === "string" && body.callback_url) {
        // Alternative response: push the bytes to the Worker, answer with JSON.
        const headers = { "Content-Type": "video/mp4", "Content-Length": String(out.size), "X-Output-Key": outputKey };
        if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
        // Redirects are not followed for the callback (it carries the bearer token).
        const target = await checkDestination(body.callback_url, "callback_url");
        let cb;
        try {
          cb = await pinnedRequest(target, { method: "POST", headers, bodyStream: createReadStream(out.outFile) });
        } catch (e) {
          throw new HttpError(502, `callback_url upload failed: ${e?.code || e?.message || e}`);
        }
        cb.resume();
        const cbStatus = cb.statusCode || 0;
        if (cbStatus < 200 || cbStatus >= 300) throw new HttpError(502, `callback_url rejected the upload: HTTP ${cbStatus}`);
        sendJson(res, 200, { ok: true, output_r2_key: outputKey, ...facts, error: null });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": out.size,
        "X-Output-Key": outputKey.replace(/[^\x20-\x7e]/g, ""),
        "X-Width": String(facts.width),
        "X-Height": String(facts.height),
        "X-Duration-Ms": String(facts.duration_ms),
        "X-Has-Audio": facts.has_audio ? "1" : "0",
        "X-Has-Captions": facts.has_captions ? "1" : "0",
        "X-Has-Ai-Label": facts.has_ai_label ? "1" : "0",
      });
      await pipeline(createReadStream(out.outFile), res);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function handleProbe(req, res) {
  const body = await readJson(req);
  if (!body.url) throw new HttpError(400, "url is required.");
  const dir = await mkdtemp(path.join(tmpdir(), "distro-probe-"));
  try {
    const dl = await download(body.url, dir, "probe");
    const m = await probeFile(dl.file);
    sendJson(res, 200, {
      width: m.has_video ? m.width : null,
      height: m.has_video ? m.height : null,
      duration_ms: m.duration_ms,
      has_audio: m.has_audio,
      content_type: dl.contentType || "application/octet-stream",
      size_bytes: dl.size,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleFrames(req, res) {
  const body = await readJson(req);
  if (!body.url) throw new HttpError(400, "url is required.");
  const count = Math.min(8, Math.max(1, Math.round(Number(body.count) || 4)));
  const width = Math.min(1280, Math.max(64, Math.round((Number(body.width) || 360) / 2) * 2));
  const dir = await mkdtemp(path.join(tmpdir(), "distro-frames-"));
  try {
    const dl = await download(body.url, dir, "src");
    const m = await probeFile(dl.file);
    if (!m.has_video) throw new HttpError(422, "The file has no video stream to sample frames from.");
    const n = m.duration_ms > 0 ? count : 1;
    const frames = [];
    for (let i = 0; i < n; i++) {
      const atMs = m.duration_ms > 0 ? Math.round((m.duration_ms * (i + 0.5)) / n) : 0;
      const name = `f${i}.jpg`;
      const r = await run(
        FFMPEG,
        ["-hide_banner", "-loglevel", "error", "-y", ...FILE_ONLY, "-ss", num(atMs / 1000), "-i", dl.base,
          "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "6", name],
        { cwd: dir, timeoutMs: 60_000 },
      );
      if (r.code !== 0 || !existsSync(path.join(dir, name))) continue;
      frames.push({ at_ms: atMs, jpeg_base64: (await readFile(path.join(dir, name))).toString("base64") });
    }
    if (!frames.length) throw new HttpError(500, "ffmpeg could not extract any frame from the file.");
    sendJson(res, 200, { duration_ms: m.duration_ms, width: m.width, height: m.height, frames });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function log(msg) {
  process.stderr.write(`[ffmpeg-service] ${new Date().toISOString()} ${msg}\n`);
}

function authorized(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || "";
  const expected = `Bearer ${TOKEN}`;
  if (h.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://local");
  const route = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (req.method === "GET" && route === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (!authorized(req)) {
      throw new HttpError(401, "Missing or wrong bearer token. Send Authorization: Bearer <FFMPEG_SERVICE_TOKEN>.");
    }
    if (req.method === "POST" && route === "/probe") return await handleProbe(req, res);
    if (req.method === "POST" && route === "/frames") return await handleFrames(req, res);
    if (req.method === "POST" && route === "/edit") return await handleEdit(req, res);
    throw new HttpError(404, "Not found. Endpoints: GET /health, POST /probe, POST /frames, POST /edit.");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof HttpError ? e.message : `Unexpected error: ${e?.message || e}`;
    log(`${req.method} ${route} -> ${status} ${message.slice(0, 300)}`);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: message });
    else res.destroy();
  }
});

const HOST_IS_LOOPBACK = HOST === "localhost" || HOST === "::1" || HOST === "[::1]" || /^127\./.test(HOST);
if (!TOKEN && !HOST_IS_LOOPBACK) {
  process.stderr.write(
    `Refusing to start: --host ${HOST} is not loopback and FFMPEG_SERVICE_TOKEN is not set.\n` +
      `Set FFMPEG_SERVICE_TOKEN (the Worker sends it as a bearer token) or bind to 127.0.0.1.\n`,
  );
  process.exit(1);
}

server.requestTimeout = 0; // edits can take a couple of minutes
server.headersTimeout = 60_000;
server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (auth ${TOKEN ? "on" : "off"}, font ${FONT_PATH ? "found" : "system default"})`);
  if (!TOKEN) {
    log("WARNING: FFMPEG_SERVICE_TOKEN is not set, so anyone who can reach this port can use the service. Do not expose it through a public tunnel without a token.");
  }
  if (ALLOW_PRIVATE) {
    log("WARNING: --allow-private is ON: downloads from loopback and private addresses are permitted. LOCAL DEVELOPMENT ONLY; never run this way behind a public URL.");
  }
  log(ALLOWED_ORIGINS.size ? `download origins restricted to: ${[...ALLOWED_ORIGINS].join(", ")}` : "download origins: any public http(s) host (set FFMPEG_ALLOWED_ORIGINS to restrict)");
});
