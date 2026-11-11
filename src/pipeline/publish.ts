import { bufferAdapter } from "../adapters/schedulers/buffer";
import { dryrunAdapter } from "../adapters/schedulers/dryrun";
import { tiktokAdapter } from "../adapters/schedulers/tiktok";
import { AdapterNotConfigured, type SchedulerAdapter } from "../adapters/schedulers/types";
import { zernioAdapter } from "../adapters/schedulers/zernio";
import { getHook, getJob } from "../db/client";
import { newId, nowIso, ToolError, type Env } from "../env";
import { fileUrl } from "../files/proxy";
import { getBrand } from "./brand";
import { latestSanity } from "./sanity";

export type PublishToolInput = { job_id: string; adapter?: "dryrun" | "buffer" | "zernio" | "tiktok"; dry_run?: boolean; caption?: string; schedule_at?: string };

export async function publish(env: Env, baseUrl: string, input: PublishToolInput) {
  const job = await getJob(env, input.job_id);
  if (!job) throw new ToolError(`Unknown job_id ${input.job_id}.`);
  if (job.status !== "ready" || !job.final_r2_key) {
    throw new ToolError(`Job ${job.id} is not ready to publish (status: ${job.status}). Only a finished video with a passing or auto-fixed sanity check can be handed to a scheduler.`);
  }
  const sanity = await latestSanity(env, job.id);
  if (!sanity || sanity.verdict === "discard") throw new ToolError(`Job ${job.id} did not pass its sanity check, so it cannot be published. Run sanity_check to see why.`);

  const adapterId = input.adapter ?? "dryrun";
  // Dry-run is the default. The built-in dryrun adapter can never post.
  const dryRun = adapterId === "dryrun" ? true : input.dry_run !== false;
  if (input.schedule_at && Number.isNaN(Date.parse(input.schedule_at))) throw new ToolError("schedule_at must be an ISO-8601 date-time.");

  const brand = await getBrand(env);
  const hook = job.hook_id ? await getHook(env, job.hook_id) : null;
  const caption = (input.caption?.trim() || [hook?.hook, brand?.cta ?? hook?.cta].filter(Boolean).join(" ")).slice(0, 2000);
  // Long-lived link so a scheduler can still download the file later.
  const videoUrl = await fileUrl(env, baseUrl, job.final_r2_key, 7 * 24 * 3600);

  const adapters: Record<string, SchedulerAdapter> = { dryrun: dryrunAdapter, buffer: bufferAdapter(env), zernio: zernioAdapter(env), tiktok: tiktokAdapter };
  const adapter = adapters[adapterId];
  if (!adapter) throw new ToolError(`Unknown adapter ${adapterId}.`);

  let result;
  try {
    result = await adapter.publish({ jobId: job.id, videoUrl, caption, dryRun, scheduleAt: input.schedule_at, aiGeneratedLabel: true });
  } catch (e) {
    if (e instanceof AdapterNotConfigured) throw new ToolError(e.message);
    throw new ToolError(`The ${adapterId} adapter failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}. Nothing is confirmed as posted.`);
  }

  const draftId = newId("pub");
  await env.DB.prepare(`INSERT INTO publish_drafts (id,job_id,adapter,dry_run,payload_json,result_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(draftId, job.id, adapterId, result.dryRun ? 1 : 0, JSON.stringify(result.payload), JSON.stringify({ accepted: result.accepted, external_id: result.externalId ?? null, message: result.message }), nowIso())
    .run();

  return {
    draft_id: draftId,
    job_id: job.id,
    adapter: adapterId,
    dry_run: result.dryRun,
    accepted: result.accepted,
    external_id: result.externalId ?? null,
    payload: result.payload,
    message: result.message,
    ai_label_note: 'The video already shows a burned-in "AI-generated" label. When posting on TikTok, also turn on the AI-generated content setting for the post.',
  };
}

export function adaptersConfigured(env: Env) {
  return { dryrun: true, buffer: Boolean(env.BUFFER_ACCESS_TOKEN), zernio: Boolean(env.ZERNIO_API_KEY), tiktok: false };
}
