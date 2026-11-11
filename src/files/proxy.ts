import type { Env } from "../env";

const DEFAULT_TTL_S = 15 * 60;

/** Decode and normalize an R2 key taken from a URL path. Returns null for anything suspicious. */
export function normalizeKey(raw: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  key = key.replace(/^\/+/, "");
  if (!key || key.length > 512) return null;
  if (key.includes("\\") || key.includes("\0")) return null;
  if (key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return key;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Public URL for an R2 object through the Worker proxy; signed when FILES_SIGNING_SECRET is set. */
export async function fileUrl(env: Env, baseUrl: string, key: string, ttlS = DEFAULT_TTL_S): Promise<string> {
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = `${baseUrl}/files/${path}`;
  if (!env.FILES_SIGNING_SECRET) return url;
  const exp = Math.floor(Date.now() / 1000) + ttlS;
  const sig = await hmacHex(env.FILES_SIGNING_SECRET, `${exp}.${key}`);
  return `${url}?exp=${exp}&sig=${sig}`;
}

const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  json: "application/json",
};

export function contentTypeFor(key: string, stored?: string): string {
  if (stored && stored !== "application/octet-stream") return stored;
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** GET/HEAD /files/<r2_key> — streams a private R2 object, with Range support. */
export async function handleFiles(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const key = normalizeKey(url.pathname.slice("/files/".length));
  if (!key) return new Response("Bad key", { status: 400 });

  if (env.FILES_SIGNING_SECRET) {
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return new Response("Link expired", { status: 403 });
    const want = await hmacHex(env.FILES_SIGNING_SECRET, `${exp}.${key}`);
    if (!timingSafeEqual(want, sig)) return new Response("Bad signature", { status: 403 });
  }

  const cors = { "Access-Control-Allow-Origin": "*" };
  if (request.method === "HEAD") {
    const head = await env.BUCKET.head(key);
    if (!head) return new Response("Not found", { status: 404, headers: cors });
    return new Response(null, {
      headers: { ...cors, "Content-Type": contentTypeFor(key, head.httpMetadata?.contentType), "Content-Length": String(head.size), "Accept-Ranges": "bytes" },
    });
  }

  const rangeHeader = request.headers.get("Range");
  const obj = await env.BUCKET.get(key, rangeHeader ? { range: request.headers } : undefined);
  if (!obj) return new Response("Not found", { status: 404, headers: cors });

  const headers = new Headers(cors);
  headers.set("Content-Type", contentTypeFor(key, obj.httpMetadata?.contentType));
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "private, max-age=60");
  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (rangeHeader && range) {
    const offset = range.offset ?? (range.suffix !== undefined ? Math.max(0, obj.size - range.suffix) : 0);
    const length = range.length ?? obj.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}
