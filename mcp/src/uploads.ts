import { env } from "./env";

// Files a user hands to the tools: a clip to edit, a first frame, a voice track. A tool call cannot
// carry a file, so create_upload reserves a link instead. Whoever holds the link may PUT the file
// once; after that the same link serves it to anyone for a day (R2 bucket UPLOADS).

export const UPLOAD_TYPES = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
} as const;
export type UploadType = keyof typeof UPLOAD_TYPES;

/** Cloudflare's request body limit on the Free and Pro plans. Larger files need multipart or presigned uploads. */
const MAX_BYTES = 100 * 1024 * 1024;
const RESERVED_S = 900;
/** The bucket's lifecycle rule deletes objects after a day too, but only roughly on time; this is exact. */
const KEPT_MS = 86_400_000;
export const FILE_PATH = /^\/files\/(up_[0-9a-f]{32}\.(?:mp4|mov|webm|png|jpg|webp|mp3|wav))$/;

const cap = () => Number(env.FREE_DAILY_UPLOADS ?? 20);
const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const refuse = (status: number, message: string) => Response.json({ error: message }, { status });

export async function createUpload(workspaceId: string, contentType: UploadType) {
  if (!env.UPLOADS) throw new Error("Uploads are not configured on this server (no UPLOADS bucket).");
  const day = `uploads:${workspaceId}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await env.OAUTH_KV.get(day)) ?? 0);
  if (used >= cap()) throw new Error(`Daily limit reached: ${cap()} uploads a day per workspace. Try again tomorrow (UTC).`);
  // ponytail: read-then-write, so parallel calls can slip a few past the cap. Count in a Durable Object if it must be exact.
  await env.OAUTH_KV.put(day, String(used + 1), { expirationTtl: 172_800 });

  const name = `up_${hex(16)}.${UPLOAD_TYPES[contentType]}`;
  await env.OAUTH_KV.put(`upload:${name}`, contentType, { expirationTtl: RESERVED_S });
  const url = `${env.ORIGIN}/files/${name}`;
  return {
    upload_url: url,
    method: "PUT",
    content_type: contentType,
    curl: `curl -T <path-to-file> -H 'Content-Type: ${contentType}' ${url}`,
    max_mb: MAX_BYTES / 1024 / 1024,
    upload_within_s: RESERVED_S,
    url,
    note: "After the upload, `url` is public for 24 hours, then the file is deleted.",
    uploads_left_today: cap() - used - 1,
  };
}

/** PUT /files/<name>: store the file a create_upload link was reserved for. GET or HEAD: serve it.
 *  No token on either: the name (128 random bits) is the credential, so a model or a platform can fetch it. */
export async function fileRoute(req: Request, name: string): Promise<Response> {
  const bucket = env.UPLOADS;
  if (!bucket) return new Response("Not found", { status: 404 });

  if (req.method === "PUT") {
    const type = await env.OAUTH_KV.get(`upload:${name}`);
    if (!type) return refuse(403, "This upload link is unknown, expired or already used. Call create_upload for a new one.");
    const size = Number(req.headers.get("content-length"));
    if (!req.body || !(size > 0)) return refuse(411, "Send the file as the request body, with a Content-Length.");
    if (size > MAX_BYTES) return refuse(413, `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    // The type stored is the one reserved, not the one sent, so a link for a video can only ever serve a video type.
    await bucket.put(name, req.body, { httpMetadata: { contentType: type } });
    await env.OAUTH_KV.delete(`upload:${name}`);
    return Response.json({ url: `${env.ORIGIN}/files/${name}`, bytes: size, content_type: type, expires_in_s: KEPT_MS / 1000 });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, PUT" } });
  const found =
    req.method === "HEAD" ? await bucket.head(name) : await bucket.get(name, { range: req.headers, onlyIf: req.headers });
  if (!found || Date.now() - found.uploaded.getTime() > KEPT_MS) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    ETag: found.httpEtag,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  found.writeHttpMetadata(headers);
  if (req.method === "HEAD") {
    headers.set("Content-Length", String(found.size));
    return new Response(null, { headers });
  }
  if (!("body" in found)) return new Response(null, { status: 304, headers }); // If-None-Match matched
  const { body } = found as R2ObjectBody;
  const range = req.headers.has("range") ? (found.range as { offset?: number; length?: number } | undefined) : undefined;
  if (!range) return new Response(body, { headers });
  const offset = range.offset ?? 0;
  const length = range.length ?? found.size - offset;
  headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${found.size}`);
  return new Response(body, { status: 206, headers });
}
