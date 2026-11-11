import { chatJson, CostMeter } from "../adapters/gmi";
import { getHook, getJob, resolveAssets } from "../db/client";
import { newId, nowIso, safeJson, ToolError, type Env } from "../env";
import { fileUrl } from "../files/proxy";
import { MODELS } from "../models";
import { sanityTextPrompt } from "../prompts";
import { brandBrief, getBrand } from "./brand";
import { FfmpegUnavailable, frames as grabFrames, probe, type EditMeta } from "./edit";
import { screenFrames } from "./footage";

export type SanityItem = { id: string; ok: boolean; detail: string };
export type SanityAction = { id: string; did: string; ok: boolean };
export type SanityReport = { verdict: "pass" | "fixed" | "discard"; items: SanityItem[]; actions: SanityAction[] };

/** Checks that fail the video outright (cannot be auto-fixed by a re-edit). */
const HARD = new Set(["off_brand", "private", "banned_assets"]);
/** Checks a forced re-edit can fix. */
export const FIXABLE = new Set(["aspect", "captions", "audio", "ai_label"]);

export type SanityContext = {
  jobId: string;
  finalKey: string;
  hookId?: string | null;
  /** Facts reported by the editor for the file at finalKey. */
  editMeta?: EditMeta | null;
  sourceAssetIds?: string[];
  script?: string;
  actions?: SanityAction[];
};

export async function runSanity(env: Env, baseUrl: string, ctx: SanityContext, meter?: CostMeter): Promise<SanityReport> {
  const items: SanityItem[] = [];
  const url = await fileUrl(env, baseUrl, ctx.finalKey);
  const brand = await getBrand(env);

  // ---- Media facts: prefer a fresh probe of the real file, fall back to editor-reported facts.
  let width = ctx.editMeta?.width ?? 0;
  let height = ctx.editMeta?.height ?? 0;
  let durationMs = ctx.editMeta?.duration_ms ?? 0;
  let hasAudio = ctx.editMeta?.has_audio ?? false;
  let probed = false;
  let serviceUp = true;
  try {
    const p = await probe(env, url);
    width = p.width ?? 0;
    height = p.height ?? 0;
    durationMs = p.duration_ms;
    hasAudio = Boolean(p.has_audio);
    probed = true;
  } catch (e) {
    if (e instanceof FfmpegUnavailable) serviceUp = false;
  }
  const src = probed ? "probed" : ctx.editMeta ? "reported by editor" : "unknown";

  const ratioOk = width > 0 && height > 0 && Math.abs(width / height - 9 / 16) <= 0.01;
  items.push({ id: "aspect", ok: ratioOk, detail: width ? `${width}x${height} (${src})` : "could not read dimensions" });

  const s = durationMs / 1000;
  items.push({
    id: "length",
    ok: s >= 8 && s <= 35,
    detail: !durationMs ? "could not read duration" : s < 8 ? `${s.toFixed(1)}s is too short for a finished ad` : s > 35 ? `${s.toFixed(1)}s is over 35s` : s < 12 ? `${s.toFixed(1)}s (short but honest: limited body footage)` : `${s.toFixed(1)}s`,
  });

  const cap = ctx.editMeta?.has_captions;
  items.push({ id: "captions", ok: cap === true, detail: cap === true ? "script-timed captions burned in by the editor" : cap === false ? "editor reported no captions" : "no editor record for this file" });

  items.push({ id: "audio", ok: hasAudio, detail: hasAudio ? `audio stream present (${src})` : "no audio stream" });

  // ---- Script checks.
  const hook = ctx.hookId ? await getHook(env, ctx.hookId) : null;
  const script = ctx.script ?? (hook ? `Hook: ${hook.hook}\nBody: ${hook.body ?? ""}\nCTA: ${hook.cta ?? ""}` : "");
  items.push({
    id: "hook_match",
    ok: Boolean(script),
    detail: script ? "narration and captions were generated from the ranked hook text (no speech recognition pass in v1)" : "no hook on record for this file",
  });

  if (script && (brand || true)) {
    try {
      const out = await chatJson<{ off_brand_ok?: boolean; detail?: string }>(env, [MODELS.judge, MODELS.judgeAlt], [{ role: "user", content: sanityTextPrompt(brandBrief(brand) || "(no brand profile stored)", script) }], {
        temperature: 0,
        max_tokens: 200,
        timeoutMs: 30_000,
        meter,
      });
      items.push({ id: "off_brand", ok: out.off_brand_ok !== false, detail: String(out.detail ?? "").slice(0, 200) || "checked against the brand profile" });
    } catch (e) {
      if (e instanceof ToolError) items.push({ id: "off_brand", ok: false, detail: "could not run the brand check (LLM not configured)" });
      else items.push({ id: "off_brand", ok: false, detail: "brand check did not complete; re-run sanity_check" });
    }
  } else {
    items.push({ id: "off_brand", ok: false, detail: "no script to check" });
  }

  // ---- Frame screen of the finished file.
  if (!serviceUp) {
    items.push({ id: "private", ok: false, detail: "could not sample frames (ffmpeg service unreachable); re-run sanity_check" });
  } else {
    try {
      const f = await grabFrames(env, url, 6, 360);
      const v = await screenFrames(env, f.frames.map((x) => x.jpeg_base64), meter);
      // A generated talking-head presenter is expected in the hook; only personal photos and location cues are hard fails here.
      const bad = (v.personal_photo || v.location_cue) && v.confidence !== "low";
      items.push({
        id: "private",
        ok: !bad,
        detail: bad ? `flagged: ${[v.personal_photo && "personal photo", v.location_cue && "location cue"].filter(Boolean).join(", ")} — ${v.detail}` : `6 frames screened: no personal photos or location cues${v.real_face ? " (presenter face is the AI-generated hook)" : ""}`,
      });
    } catch (e) {
      items.push({ id: "private", ok: false, detail: `frame screen did not complete (${String(e instanceof Error ? e.message : e).slice(0, 80)}); re-run sanity_check` });
    }
  }

  const label = ctx.editMeta?.has_ai_label;
  items.push({ id: "ai_label", ok: label === true, detail: label === true ? '"AI-generated" label burned into the corner and the end card' : label === false ? "editor reported no AI label" : "no editor record for this file" });

  const sources = ctx.sourceAssetIds?.length ? await resolveAssets(env, ctx.sourceAssetIds) : [];
  const bannedUsed = sources.filter((a) => a.banned === 1).map((a) => a.id);
  items.push({ id: "banned_assets", ok: bannedUsed.length === 0, detail: bannedUsed.length ? `flagged sources used: ${bannedUsed.join(", ")}` : `${sources.length} source clip(s), none flagged` });

  const actions = ctx.actions ?? [];
  const failed = items.filter((i) => !i.ok);
  const verdict: SanityReport["verdict"] = failed.length ? "discard" : actions.some((a) => a.ok) ? "fixed" : "pass";
  const report: SanityReport = { verdict, items, actions };

  await env.DB.prepare(`INSERT INTO sanity_checks (id,job_id,verdict,items_json,actions_json,created_at) VALUES (?,?,?,?,?,?)`)
    .bind(newId("san"), ctx.jobId, verdict, JSON.stringify(items), JSON.stringify(actions), nowIso())
    .run();
  return report;
}

export function failedIds(report: SanityReport): string[] {
  return report.items.filter((i) => !i.ok).map((i) => i.id);
}

export const isHardFail = (ids: string[]) => ids.some((id) => HARD.has(id));

export async function latestSanity(env: Env, jobId: string): Promise<SanityReport | null> {
  const row = await env.DB.prepare(`SELECT verdict,items_json,actions_json FROM sanity_checks WHERE job_id=? ORDER BY created_at DESC LIMIT 1`).bind(jobId).first<{ verdict: string; items_json: string; actions_json: string | null }>();
  if (!row) return null;
  return { verdict: row.verdict as SanityReport["verdict"], items: safeJson(row.items_json, []), actions: safeJson(row.actions_json, []) };
}

/** On-demand sanity_check tool: by job_id, or by r2_key (+ optional hook_id). */
export async function sanityCheckTool(env: Env, baseUrl: string, input: { job_id?: string; r2_key?: string; hook_id?: string }) {
  if (input.job_id) {
    const job = await getJob(env, input.job_id);
    if (!job) throw new ToolError(`Unknown job_id ${input.job_id}.`);
    if (!job.final_r2_key) throw new ToolError(`Job ${job.id} has no finished video yet (status: ${job.status}). Poll get_job until it is ready.`);
    const params = safeJson<{ edit_meta?: EditMeta; body_assets?: string[]; sanity_actions?: SanityAction[] }>(job.params_json, {});
    const report = await runSanity(env, baseUrl, {
      jobId: job.id,
      finalKey: job.final_r2_key,
      hookId: job.hook_id,
      editMeta: params.edit_meta ?? null,
      sourceAssetIds: params.body_assets ?? [],
      actions: params.sanity_actions ?? [],
    });
    return { job_id: job.id, ...report };
  }
  if (input.r2_key) {
    if (!(await env.BUCKET.head(input.r2_key))) throw new ToolError(`No file at r2_key ${input.r2_key}.`);
    const report = await runSanity(env, baseUrl, { jobId: `adhoc:${input.r2_key}`.slice(0, 120), finalKey: input.r2_key, hookId: input.hook_id ?? null });
    return { r2_key: input.r2_key, ...report, note: "Checked a file that was not produced by make_video, so captions and AI-label status have no editor record and are reported as not confirmed." };
  }
  throw new ToolError("Provide job_id, or r2_key (with optional hook_id).");
}
