import type { Env } from "../env";

export class FfmpegUnavailable extends Error {}

function base(env: Env): string {
  const url = (env.FFMPEG_SERVICE_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) throw new FfmpegUnavailable("FFMPEG_SERVICE_URL is not set on the server.");
  // ALLOW_LOCAL_FFMPEG=1 is for `wrangler dev` only, where the Worker runs on the same machine.
  if (env.ALLOW_LOCAL_FFMPEG !== "1" && /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url)) {
    throw new FfmpegUnavailable("FFMPEG_SERVICE_URL points at localhost, which a deployed Worker cannot reach. Use a public HTTPS URL (for example a cloudflared tunnel).");
  }
  return url;
}

function headers(env: Env): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (env.FFMPEG_SERVICE_TOKEN) h.Authorization = `Bearer ${env.FFMPEG_SERVICE_TOKEN}`;
  return h;
}

async function post(env: Env, path: string, body: unknown, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${base(env)}${path}`, { method: "POST", headers: headers(env), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof FfmpegUnavailable) throw e;
    throw new FfmpegUnavailable(`ffmpeg service unreachable at FFMPEG_SERVICE_URL (${String(e).slice(0, 120)}).`);
  }
  if (res.status === 502 || res.status === 503 || res.status === 530 || res.status === 1033) {
    const t = await res.text();
    // A 502 from the service itself (input download failed) carries JSON; a tunnel error does not.
    if (!t.trim().startsWith("{")) throw new FfmpegUnavailable(`ffmpeg service unreachable (HTTP ${res.status}).`);
    throw new Error(`ffmpeg service error: ${t.slice(0, 400)}`);
  }
  return res;
}

export type Probe = { width: number | null; height: number | null; duration_ms: number; has_audio: boolean; content_type?: string; size_bytes?: number };

export async function probe(env: Env, url: string): Promise<Probe> {
  const res = await post(env, "/probe", { url }, 60_000);
  if (!res.ok) throw new Error(`probe failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as Probe;
}

export type Frames = { duration_ms: number; width: number; height: number; frames: { at_ms: number; jpeg_base64: string }[] };

export async function frames(env: Env, url: string, count = 4, width = 360): Promise<Frames> {
  const res = await post(env, "/frames", { url, count, width }, 60_000);
  if (!res.ok) throw new Error(`frames failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as Frames;
}

export type Caption = { start_ms: number; end_ms: number; text: string };

export type EditRequest = {
  job_id: string;
  output_key: string;
  width: number;
  height: number;
  hook?: { url: string; r2_key?: string };
  hook_text?: string;
  hook_duration_ms?: number;
  body: { url: string; r2_key?: string; max_ms?: number }[];
  body_max_ms: number;
  audio?: { url: string; start_ms?: number }[];
  captions: Caption[];
  ai_label: boolean;
  cta?: string;
  end_card_icon_url?: string;
};

export type EditMeta = {
  width: number;
  height: number;
  duration_ms: number;
  has_audio: boolean;
  has_captions: boolean;
  has_ai_label: boolean;
  bytes: number;
};

/** Calls POST /edit and streams the returned mp4 into R2 at output_key. */
export async function edit(env: Env, req: EditRequest): Promise<EditMeta> {
  const res = await post(env, "/edit", req, 280_000);
  const type = res.headers.get("Content-Type") ?? "";
  if (!res.ok || !type.startsWith("video/")) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`ffmpeg edit failed: HTTP ${res.status} ${text}`);
  }
  if (!res.body) throw new Error("ffmpeg edit returned an empty body");
  const length = Number(res.headers.get("Content-Length"));
  let size: number;
  if (Number.isFinite(length) && length > 0) {
    const put = await env.BUCKET.put(req.output_key, res.body, { httpMetadata: { contentType: "video/mp4" } });
    size = put.size;
  } else {
    // No Content-Length (chunked through a tunnel): finals are a few MB, safe to buffer.
    const buf = await res.arrayBuffer();
    await env.BUCKET.put(req.output_key, buf, { httpMetadata: { contentType: "video/mp4" } });
    size = buf.byteLength;
  }
  const n = (h: string) => Number(res.headers.get(h) ?? 0);
  const b = (h: string) => res.headers.get(h) === "1";
  return {
    width: n("X-Width"),
    height: n("X-Height"),
    duration_ms: n("X-Duration-Ms"),
    has_audio: b("X-Has-Audio"),
    has_captions: b("X-Has-Captions"),
    has_ai_label: b("X-Has-Ai-Label"),
    bytes: size,
  };
}

/** Split narration into caption chunks spread evenly (by character weight) over [startMs, startMs+durationMs]. */
export function timedCaptions(text: string, startMs: number, durationMs: number, wordsPerChunk = 5): Caption[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length || durationMs <= 0) return [];
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= wordsPerChunk || /[.!?]$/.test(w)) {
      chunks.push(cur.join(" "));
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur.join(" "));
  const total = chunks.reduce((s, c) => s + c.length + 2, 0);
  const out: Caption[] = [];
  let t = startMs;
  for (const c of chunks) {
    const d = Math.round(((c.length + 2) / total) * durationMs);
    out.push({ start_ms: Math.round(t), end_ms: Math.round(t + d), text: c });
    t += d;
  }
  return out;
}

/** Rough speech length when a real probe is not available (about 2.6 words per second). */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1200, Math.round((words / 2.6) * 1000));
}
