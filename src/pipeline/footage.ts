import { chatJson, CostMeter, type ChatPart } from "../adapters/gmi";
import { isVideoKey, type AssetRow } from "../db/client";
import { nowIso, safeJson, ToolError, type Env } from "../env";
import { fileUrl } from "../files/proxy";
import { commit, release, reserve } from "../guardrails/spend";
import { MODELS } from "../models";
import { VISION_FRAMES_PROMPT } from "../prompts";
import { FfmpegUnavailable, frames as grabFrames, probe } from "./edit";

export type VisionVerdict = { real_face: boolean; personal_photo: boolean; location_cue: boolean; confidence: string; detail: string };

/** Ask the vision model whether frames show faces, personal photos, or location cues. */
export async function screenFrames(env: Env, jpegsBase64: string[], meter?: CostMeter): Promise<VisionVerdict> {
  const content: ChatPart[] = [
    { type: "text", text: VISION_FRAMES_PROMPT },
    ...jpegsBase64.map((b64): ChatPart => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } })),
  ];
  const out = await chatJson<Partial<VisionVerdict>>(env, [MODELS.vision], [{ role: "user", content }], { temperature: 0, max_tokens: 300, timeoutMs: 40_000, meter });
  return {
    real_face: out.real_face === true,
    personal_photo: out.personal_photo === true,
    location_cue: out.location_cue === true,
    confidence: String(out.confidence ?? "low").toLowerCase(),
    detail: String(out.detail ?? "").slice(0, 200),
  };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type AnalyzeInput = { asset_ids: string[]; notes?: string; override_flags?: boolean };

type UploadRow = { token: string; asset_id: string; r2_key: string; filename: string | null; content_type: string | null; status: string };

export async function analyzeFootage(env: Env, baseUrl: string, input: AnalyzeInput) {
  const ids = [...new Set(input.asset_ids)].slice(0, 24);
  if (!ids.length) throw new ToolError("asset_ids is required.");

  const visionOn = Boolean(env.GMI_API_KEY) && !input.override_flags;
  const reserveKey = `analyze:${crypto.randomUUID()}`;
  const meter = new CostMeter();
  let reserved = false;
  if (visionOn) {
    try {
      await reserve(env, { cents: Math.max(2, ids.length), key: reserveKey, model: MODELS.vision, note: `footage screening (${ids.length} files)` });
      reserved = true;
    } catch {
      /* cap reached: skip the vision screen, still ingest the files */
    }
  }

  const one = async (assetId: string) => {
    const up = await env.DB.prepare(`SELECT token,asset_id,r2_key,filename,content_type,status FROM uploads WHERE asset_id=? ORDER BY created_at DESC LIMIT 1`).bind(assetId).first<UploadRow>();
    const existing = await env.DB.prepare(`SELECT * FROM assets WHERE id=?`).bind(assetId).first<AssetRow>();
    const key = up?.r2_key ?? existing?.r2_key;
    if (!key) return { asset_id: assetId, status: "unknown", error: "No upload slot with this asset_id. Call create_upload first." };

    const head = await env.BUCKET.head(key);
    if (!head) return { asset_id: assetId, r2_key: key, status: "missing", error: "The file never arrived. PUT it to the upload_url, or call create_upload again if the URL expired." };
    if (up && up.status !== "complete") await env.DB.prepare(`UPDATE uploads SET status='complete' WHERE token=?`).bind(up.token).run();

    const isVideo = isVideoKey(key);
    const warnings: string[] = [];
    let width: number | null = existing?.width ?? null;
    let height: number | null = existing?.height ?? null;
    let durationMs: number | null = existing?.duration_ms ?? null;
    let hasAudio = existing?.has_audio === 1;
    let status = "ready";
    let banned = input.override_flags ? 0 : (existing?.banned ?? 0);
    let banReason: string | null = input.override_flags ? null : (existing?.ban_reason ?? null);
    let thumbKey: string | null = null;

    const url = await fileUrl(env, baseUrl, key);
    try {
      const p = await probe(env, url);
      width = p.width;
      height = p.height;
      durationMs = isVideo ? p.duration_ms : null;
      hasAudio = Boolean(p.has_audio);
      if (width && height && Math.abs(width / height - 9 / 16) > 0.01) warnings.push("not_9_16");
      if (isVideo && !hasAudio) warnings.push("silent_or_very_quiet");
      if (isVideo && durationMs !== null && durationMs < 2000) warnings.push("very_short");

      try {
        const f = await grabFrames(env, url, isVideo ? 3 : 1, 360);
        if (f.frames[0]) {
          thumbKey = `uploads/${assetId}/thumb.jpg`;
          await env.BUCKET.put(thumbKey, b64ToBytes(f.frames[0].jpeg_base64), { httpMetadata: { contentType: "image/jpeg" } });
        }
        if (reserved && f.frames.length) {
          const v = await screenFrames(env, f.frames.map((x) => x.jpeg_base64), meter);
          const hits = [v.real_face && "possible_real_face", v.personal_photo && "possible_personal_photo", v.location_cue && "possible_location_cue"].filter(Boolean) as string[];
          warnings.push(...hits);
          if (hits.length && v.confidence === "high") {
            banned = 1;
            banReason = `${hits.join(", ")}: ${v.detail}`.slice(0, 240);
          }
        } else if (!input.override_flags) {
          warnings.push("vision_check_skipped");
        }
      } catch (e) {
        if (e instanceof FfmpegUnavailable) throw e;
        warnings.push("vision_check_skipped");
      }
    } catch (e) {
      if (!(e instanceof FfmpegUnavailable)) {
        return { asset_id: assetId, r2_key: key, status: "unreadable", error: `Could not read this file as media (${String(e instanceof Error ? e.message : e).slice(0, 160)}).` };
      }
      status = "probe_pending";
      warnings.push("probe_pending");
    }

    const filename = up?.filename ?? existing?.original_filename ?? key.split("/").pop() ?? null;
    const kind = isVideo ? "footage" : /icon|logo/i.test(filename ?? "") ? "icon" : "screenshot";
    if (kind === "icon") await env.BUCKET.put("brand/icon.png", (await env.BUCKET.get(key))!.body, { httpMetadata: { contentType: head.httpMetadata?.contentType ?? "image/png" } });

    await env.DB.prepare(
      `INSERT INTO assets (id,r2_key,kind,original_filename,source,duration_ms,width,height,has_audio,banned,ban_reason,warnings_json,notes,created_at)
       VALUES (?,?,?,?, 'chat_upload', ?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, duration_ms=excluded.duration_ms, width=excluded.width, height=excluded.height,
         has_audio=excluded.has_audio, banned=excluded.banned, ban_reason=excluded.ban_reason, warnings_json=excluded.warnings_json,
         notes=COALESCE(excluded.notes, assets.notes)`,
    )
      .bind(assetId, key, kind, filename, durationMs, width, height, hasAudio ? 1 : 0, banned, banReason, JSON.stringify(warnings), input.notes ?? null, existing?.created_at ?? nowIso())
      .run();

    return {
      asset_id: assetId,
      r2_key: key,
      status,
      kind,
      filename,
      size_bytes: head.size,
      duration_ms: durationMs,
      width,
      height,
      has_audio: hasAudio,
      banned: banned === 1,
      ...(banReason ? { ban_reason: banReason } : {}),
      warnings,
      thumb_r2_key: thumbKey,
    };
  };

  // Small pool: probing downloads each file on the ffmpeg box.
  const results: Awaited<ReturnType<typeof one>>[] = new Array(ids.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (next < ids.length) {
        const i = next++;
        try {
          results[i] = await one(ids[i]);
        } catch (e) {
          results[i] = { asset_id: ids[i], status: "error", error: String(e instanceof Error ? e.message : e).slice(0, 200) };
        }
      }
    }),
  );

  if (reserved) {
    if (meter.calls > 0) await commit(env, reserveKey, meter.cents, { model: MODELS.vision, note: `footage screening (${meter.calls} checks)` });
    else await release(env, reserveKey, { note: "footage screening (no vision call)" });
  }

  const count = (s: string) => results.filter((r) => r.status === s).length;
  const flagged = results.filter((r) => "banned" in r && r.banned).length;
  const parts = [
    `${count("ready")} ready`,
    count("probe_pending") ? `${count("probe_pending")} stored but not probed (ffmpeg service unreachable)` : "",
    count("missing") ? `${count("missing")} missing (upload never completed)` : "",
    count("unreadable") + count("unknown") + count("error") ? `${count("unreadable") + count("unknown") + count("error")} failed` : "",
    flagged ? `${flagged} flagged and excluded (pass override_flags: true if the user confirms they are fine to use)` : "",
  ].filter(Boolean);
  return { assets: results, notes: parts.join(", ") };
}

export function warningsOf(a: AssetRow): string[] {
  return safeJson<string[]>(a.warnings_json, []);
}
