import { AwsClient } from "aws4fetch";
import { config, newId, nowIso, ToolError, type Env } from "../env";

const TTL_MS = 15 * 60 * 1000;

const ALLOWED_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "image/jpeg", "image/png", "image/webp"]);
const EXT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export type CreateUploadInput = { filename: string; size_bytes: number; content_type: string; sha256?: string };

function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(-80);
  return cleaned || "file";
}

function presignConfigured(env: Env): boolean {
  return Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CLOUDFLARE_ACCOUNT_ID);
}

async function presignPut(env: Env, key: string, contentType: string, ttlS: number): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
  });
  const bucket = env.R2_BUCKET_NAME || "distro";
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${path}`);
  url.searchParams.set("X-Amz-Expires", String(ttlS));
  const signed = await client.sign(new Request(url, { method: "PUT", headers: { "Content-Type": contentType } }), {
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}

export async function createUpload(env: Env, baseUrl: string, input: CreateUploadInput) {
  const cfg = config(env);
  const filename = safeFilename(input.filename);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const declared = (input.content_type || "").toLowerCase().split(";")[0].trim();
  const contentType = ALLOWED_TYPES.has(declared) ? declared : EXT_TYPES[ext];
  if (!contentType || !EXT_TYPES[ext]) {
    throw new ToolError(
      `Unsupported file type (${input.content_type || "unknown"}, .${ext || "?"}). Allowed: mp4, mov, webm, m4v, jpg, jpeg, png, webp.`,
    );
  }
  const mode: "presigned" | "worker" = presignConfigured(env) ? "presigned" : "worker";
  const maxBytes = mode === "presigned" ? cfg.uploadMaxPresign : cfg.uploadMaxWorker;
  if (!Number.isInteger(input.size_bytes) || input.size_bytes < 1) throw new ToolError("size_bytes must be a positive integer.");
  if (input.size_bytes > maxBytes) {
    const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
    throw new ToolError(
      `File is ${mb(input.size_bytes)}, above the ${mb(maxBytes)} limit for ${mode} uploads. ` +
        (mode === "worker" ? "Trim or compress the clip, or configure R2 API tokens on the server for presigned uploads up to 512 MB." : "Trim or compress the clip."),
    );
  }

  // Reuse a still-valid pending slot for the same file.
  if (input.sha256) {
    const prior = await env.DB.prepare(
      `SELECT token,asset_id,r2_key,mode,expires_at FROM uploads
       WHERE sha256=? AND filename=? AND declared_size=? AND status='pending' AND mode=? AND expires_at > ? LIMIT 1`,
    )
      .bind(input.sha256.toLowerCase(), filename, input.size_bytes, mode, new Date(Date.now() + 60_000).toISOString())
      .first<{ token: string; asset_id: string; r2_key: string; mode: string; expires_at: string }>();
    if (prior && prior.mode === "worker") {
      return shape(prior.asset_id, prior.r2_key, `${baseUrl}/upload/${prior.token}`, contentType, "worker", maxBytes, prior.expires_at);
    }
  }

  const assetId = newId("ast");
  const key = `uploads/${assetId}/${filename}`;
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const uploadUrl = mode === "presigned" ? await presignPut(env, key, contentType, TTL_MS / 1000) : `${baseUrl}/upload/${token}`;

  await env.DB.prepare(
    `INSERT INTO uploads (token,asset_id,r2_key,filename,content_type,declared_size,sha256,mode,status,expires_at,created_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)`,
  )
    .bind(token, assetId, key, filename, contentType, input.size_bytes, input.sha256?.toLowerCase() ?? null, mode, expiresAt, nowIso())
    .run();

  return shape(assetId, key, uploadUrl, contentType, mode, maxBytes, expiresAt);
}

function shape(assetId: string, key: string, uploadUrl: string, contentType: string, mode: string, maxBytes: number, expiresAt: string) {
  return {
    asset_id: assetId,
    r2_key: key,
    upload_url: uploadUrl,
    method: "PUT",
    headers: { "Content-Type": contentType },
    mode,
    max_bytes: maxBytes,
    expires_at: expiresAt,
    complete: "After a 2xx PUT, call analyze_footage with this asset_id.",
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** PUT /upload/<token> — streams the request body straight into R2 (never buffers the file). */
export async function handleUploadPut(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "POST") return json(405, { ok: false, error: "Use PUT." });
  const token = url.pathname.slice("/upload/".length);
  if (!/^[0-9a-f-]{36}$/i.test(token)) return json(404, { ok: false, error: "Unknown upload token." });

  const row = await env.DB.prepare(`SELECT * FROM uploads WHERE token=?`)
    .bind(token)
    .first<{ asset_id: string; r2_key: string; content_type: string; declared_size: number; mode: string; status: string; expires_at: string }>();
  if (!row || row.mode !== "worker") return json(404, { ok: false, error: "Unknown upload token." });
  if (row.status !== "pending") return json(409, { ok: false, error: "This upload URL was already used. Call create_upload again." });
  if (row.expires_at < nowIso()) {
    await env.DB.prepare(`UPDATE uploads SET status='expired' WHERE token=?`).bind(token).run();
    return json(410, { ok: false, error: "Upload URL expired. Call create_upload again." });
  }

  const max = config(env).uploadMaxWorker;
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isFinite(length) || length < 1) return json(411, { ok: false, error: "Content-Length is required." });
  if (length > max || length > row.declared_size * 1.02 + 1024) {
    return json(413, { ok: false, error: `Body is larger than allowed (${Math.round(max / 1048576)} MB max, declared ${row.declared_size} bytes).` });
  }
  const sent = (request.headers.get("Content-Type") ?? "").toLowerCase().split(";")[0].trim();
  if (sent && sent !== row.content_type && sent !== "application/octet-stream") {
    return json(415, { ok: false, error: `Content-Type must be ${row.content_type}.` });
  }
  if (!request.body) return json(400, { ok: false, error: "Empty body." });

  // Claim the token first so it is single-use even under concurrent PUTs.
  const claim = await env.DB.prepare(`UPDATE uploads SET status='uploading' WHERE token=? AND status='pending'`).bind(token).run();
  if (!claim.meta.changes) return json(409, { ok: false, error: "This upload URL was already used." });

  try {
    const put = await env.BUCKET.put(row.r2_key, request.body, { httpMetadata: { contentType: row.content_type } });
    await env.DB.prepare(`UPDATE uploads SET status='complete' WHERE token=?`).bind(token).run();
    return json(200, { ok: true, asset_id: row.asset_id, r2_key: row.r2_key, bytes: put.size });
  } catch (e) {
    await env.DB.prepare(`UPDATE uploads SET status='pending' WHERE token=?`).bind(token).run();
    return json(500, { ok: false, error: `Upload failed while writing to storage: ${String(e).slice(0, 200)}` });
  }
}
