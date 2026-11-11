import { getHook, getJob, isVideoKey, listAssets, resolveAssets, type AssetRow, type JobRow } from "../db/client";
import { config, nowIso, safeJson, sha256Hex, ToolError, usd, type Env } from "../env";
import { fileUrl } from "../files/proxy";
import { guard, release, reserve } from "../guardrails/spend";
import { MODELS, ttsCostCents, wanCostCents } from "../models";
import { getBrand, NO_BRAND_ERROR } from "./brand";
import { estimateSpeechMs } from "./edit";
import { latestSanity } from "./sanity";

export type MakeVideoInput = {
  hook_id: string;
  footage_keys?: string[];
  body_asset?: string;
  resolution?: "480P" | "720P";
  hook_duration_s?: number;
  confirm_usd?: number;
};

export type JobParams = {
  hook_id: string;
  base_url: string;
  resolution: "480P" | "720P";
  hook_duration_s: number;
  want_talking_head: boolean;
  body_assets: string[];
  estimate: { wan_cents: number; tts_cents: number; llm_cents: number };
  idem_key: string;
};

/** Allowance for the sanity-check LLM calls on each job. */
const LLM_ALLOWANCE_CENTS = 3;
const MAX_CONCURRENT_RENDERS = 2;

export async function startVideo(env: Env, baseUrl: string, input: MakeVideoInput) {
  const cfg = config(env);
  const hook = await getHook(env, input.hook_id);
  if (!hook) throw new ToolError(`Unknown hook_id ${input.hook_id}. Call rank_hooks and use a hook_id it returned.`);
  if (!(await getBrand(env))) throw new ToolError(NO_BRAND_ERROR);

  // ---- Footage selection: explicit keys > body_asset > hook hints > recent uploads. Flagged assets never qualify.
  const explicit = [...(input.body_asset && input.body_asset !== "auto" ? [input.body_asset] : []), ...(input.footage_keys ?? [])];
  let pool: AssetRow[];
  if (explicit.length) {
    const found = await resolveAssets(env, explicit);
    const flagged = found.filter((a) => a.banned === 1);
    pool = found.filter((a) => a.banned === 0 && isVideoKey(a.r2_key));
    if (!pool.length) {
      throw new ToolError(
        found.length
          ? `None of the requested footage can be used (${flagged.length} flagged as private/sensitive, ${found.length - flagged.length} not video). Pick other clips, or re-run analyze_footage with override_flags: true if the user confirms the flagged clips are fine.`
          : "None of the requested footage_keys exist. Upload with create_upload, then call analyze_footage.",
      );
    }
  } else {
    const hinted = hook.footage_hints.length ? (await resolveAssets(env, hook.footage_hints)).filter((a) => a.banned === 0 && isVideoKey(a.r2_key)) : [];
    const recent = (await listAssets(env, { limit: 40 })).filter((a) => a.kind === "footage" && isVideoKey(a.r2_key));
    const seen = new Set(hinted.map((a) => a.id));
    pool = [...hinted, ...recent.filter((a) => !seen.has(a.id))];
    if (!pool.length) throw new ToolError("No usable footage on the server yet. Upload the user's clips with create_upload, PUT them, then call analyze_footage.");
  }
  const bodyAssets = pool.slice(0, 3).map((a) => a.id);

  // ---- Estimate (list prices).
  const resolution = input.resolution ?? "480P";
  const wantHead = hook.want_talking_head === 1;
  const speechS = estimateSpeechMs(hook.hook) / 1000;
  const hookDuration = Math.min(8, Math.max(3, Math.round(input.hook_duration_s ?? Math.ceil(speechS + 0.8))));
  const narration = `${hook.hook} ${hook.body ?? ""} ${hook.cta ?? ""}`;
  const wanCents = wantHead ? wanCostCents(resolution, hookDuration) : 0;
  const ttsCents = ttsCostCents(narration.length) + 1;
  const estCents = wanCents + ttsCents + LLM_ALLOWANCE_CENTS;

  if (wanCents > cfg.maxRenderCents) {
    throw new ToolError(`This render would cost $${usd(wanCents).toFixed(2)}, above the per-render limit of $${usd(cfg.maxRenderCents).toFixed(2)}. Use a shorter hook_duration_s or resolution=480P.`);
  }

  // ---- Idempotency: same hook + footage + model + params maps to the same job id.
  const idemKey = await sha256Hex(JSON.stringify([hook.id, bodyAssets, MODELS.video, MODELS.tts, resolution, hookDuration]));
  const baseId = `job_${idemKey.slice(0, 12)}`;
  const priors = (await env.DB.prepare(`SELECT * FROM jobs WHERE id LIKE ? ORDER BY created_at DESC`).bind(`${baseId}%`).all<JobRow>()).results ?? [];
  const existingView = (j: JobRow) => ({
    job_id: j.id,
    status: j.status,
    estimated_usd: usd(j.estimated_cents ?? 0),
    reserved_usd: usd(j.reserved_cents ?? 0),
    poll: "get_job",
    note: "An identical job already exists; returning it instead of spending again.",
  });
  const live = priors.find((j) => j.status !== "failed" && j.status !== "discarded");
  if (live) return existingView(live);

  if (estCents >= cfg.confirmCents) {
    const ok = typeof input.confirm_usd === "number" && Math.abs(Math.round(input.confirm_usd * 100) - estCents) <= 1;
    if (!ok) {
      throw new ToolError(`Estimated cost is $${usd(estCents).toFixed(2)}, which needs confirmation. Tell the user the estimate, then call make_video again with confirm_usd=${usd(estCents)}.`);
    }
  }
  if (wantHead && (await guard(env).activeCount(MODELS.video)) >= MAX_CONCURRENT_RENDERS) {
    throw new ToolError(`${MAX_CONCURRENT_RENDERS} renders are already in progress. Wait for one to finish (poll get_job), then try again.`);
  }

  // A retry after a failed or discarded attempt gets a new suffix.
  const jobId = priors.length ? `${baseId}r${priors.length}` : baseId;
  const reservation = await reserve(env, { cents: estCents, key: jobId, job_id: jobId, model: MODELS.video, note: `${wantHead ? `${hookDuration}s ${resolution} hook` : "text hook"} + voice + edit` });

  const params: JobParams = {
    hook_id: hook.id,
    base_url: baseUrl,
    resolution,
    hook_duration_s: hookDuration,
    want_talking_head: wantHead,
    body_assets: bodyAssets,
    estimate: { wan_cents: wanCents, tts_cents: ttsCents, llm_cents: LLM_ALLOWANCE_CENTS },
    idem_key: idemKey,
  };
  const now = nowIso();
  try {
    const ins = await env.DB.prepare(`INSERT OR IGNORE INTO jobs (id,hook_id,status,step,params_json,estimated_cents,reserved_cents,created_at,updated_at) VALUES (?,?, 'queued', NULL, ?,?,?,?,?)`)
      .bind(jobId, hook.id, JSON.stringify(params), estCents, estCents, now, now)
      .run();
    if (!ins.meta.changes) {
      // A concurrent identical call won the race; the reservation is shared (same key).
      const winner = await getJob(env, jobId);
      if (winner) return existingView(winner);
    }
    await env.MAKE_VIDEO.create({ id: jobId, params: { job_id: jobId } });
  } catch (e) {
    if (!reservation.existing) await release(env, jobId, { job_id: jobId, note: "job could not be started" });
    await env.DB.prepare(`UPDATE jobs SET status='failed', error=? WHERE id=? AND status='queued'`).bind("Could not start the pipeline.", jobId).run().catch(() => {});
    throw new ToolError(`Could not start the video pipeline (${String(e instanceof Error ? e.message : e).slice(0, 160)}). Nothing was charged.`);
  }

  return {
    job_id: jobId,
    status: "queued",
    estimated_usd: usd(estCents),
    reserved_usd: usd(estCents),
    poll: "get_job",
    note: wantHead ? "A talking-head render usually takes about 5 minutes. Poll get_job about every 30 seconds." : "Text-hook video; usually ready in under a minute. Poll get_job.",
  };
}

export async function jobView(env: Env, baseUrl: string, jobId: string) {
  const job = await getJob(env, jobId);
  if (!job) throw new ToolError(`Unknown job_id ${jobId}.`);
  const params = safeJson<Record<string, unknown>>(job.params_json, {});
  const sanity = await latestSanity(env, job.id);
  return {
    job_id: job.id,
    status: job.status,
    step: job.step,
    estimated_usd: usd(job.estimated_cents ?? 0),
    actual_usd: job.actual_cents === null ? null : usd(job.actual_cents),
    hook_id: job.hook_id,
    preview_url: job.final_r2_key ? await fileUrl(env, baseUrl, job.final_r2_key, 3600) : null,
    final_r2_key: job.final_r2_key,
    sanity,
    ...(params.cost_breakdown ? { cost_breakdown: params.cost_breakdown } : {}),
    ...(Array.isArray(params.notes) && params.notes.length ? { notes: params.notes } : {}),
    error: job.error,
    updated_at: job.updated_at,
  };
}
