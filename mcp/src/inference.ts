import { env } from "./env";

// The video tools are a thin door onto the model server (docs/MODEL_SERVER.md). It holds the GMI
// key, the model catalog and the total spend cap; this file adds who owns a job, a daily allowance
// per workspace, and a video link that needs no token.

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!env.MODEL_SERVER_URL || !env.MODEL_SERVER_TOKEN) {
    throw new Error("Video models are not configured on this server (MODEL_SERVER_URL or MODEL_SERVER_TOKEN is unset).");
  }
  const res = await fetch(env.MODEL_SERVER_URL + path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${env.MODEL_SERVER_TOKEN}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    const detail = (() => { try { return JSON.parse(text).detail; } catch { return undefined; } })();
    throw new Error(`Model server ${res.status}: ${typeof detail === "string" ? detail : text.slice(0, 300)}`);
  }
  return res.json();
}

export const listModels = () => call<{ tiers: unknown; models: unknown[] }>("/models");

export type VideoInput = {
  model: string;
  prompt: string;
  duration?: number;
  aspect?: string;
  resolution?: string;
  negative_prompt?: string;
  first_frame?: string;
  audio_url?: string;
  dry_run?: boolean;
};
type ServerJob = { job_id: string; model: string; status: string; est_usd: number; duration_s: number; warnings: string[]; error: string | null };

const cap = () => Number(env.FREE_DAILY_VIDEOS ?? 5);
const view = (j: ServerJob) => ({ job_id: j.job_id, model: j.model, status: j.status, est_usd: j.est_usd, duration_s: j.duration_s, warnings: j.warnings });

export async function generateVideo(workspaceId: string, input: VideoInput) {
  if (input.dry_run) return call<Record<string, unknown>>("/generate", { method: "POST", body: JSON.stringify(input) });

  const day = `videos:${workspaceId}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await env.OAUTH_KV.get(day)) ?? 0);
  if (used >= cap()) throw new Error(`Daily limit reached: ${cap()} videos a day per workspace. Try again tomorrow (UTC).`);
  // ponytail: read-then-write, so parallel calls can slip a few past the cap. The model server's
  // total spend cap still holds. Count in a Durable Object if it must be exact.
  await env.OAUTH_KV.put(day, String(used + 1), { expirationTtl: 172_800 });

  let job: ServerJob;
  try {
    job = await call<ServerJob>("/generate", { method: "POST", body: JSON.stringify(input) });
  } catch (e) {
    await env.OAUTH_KV.put(day, String(used), { expirationTtl: 172_800 }); // nothing was started: give the slot back
    throw e;
  }
  await env.OAUTH_KV.put(`job:${workspaceId}:${job.job_id}`, "1", { expirationTtl: 30 * 86_400 });
  return { ...view(job), videos_left_today: cap() - used - 1, poll: "get_job" };
}

export async function getJob(workspaceId: string, jobId: string) {
  // Jobs on the model server are shared by every workspace; this record says whose it is.
  if (!(await env.OAUTH_KV.get(`job:${workspaceId}:${jobId}`))) throw new Error(`Unknown job: ${jobId}`);
  const job = await call<ServerJob>(`/jobs/${jobId}`);
  return {
    ...view(job),
    error: job.error,
    video_url: job.status === "ready" ? `${env.ORIGIN}/videos/${jobId}.mp4` : null,
  };
}

/** GET /videos/job_<id>.mp4: the finished mp4 without a token, so a browser or `publish` can fetch it.
 *  The job id (48 random bits) is the only thing that guards it. */
export async function videoFile(jobId: string): Promise<Response> {
  if (!env.MODEL_SERVER_URL || !env.MODEL_SERVER_TOKEN) return new Response("Not found", { status: 404 });
  const res = await fetch(`${env.MODEL_SERVER_URL}/jobs/${jobId}/video`, { headers: { Authorization: `Bearer ${env.MODEL_SERVER_TOKEN}` } });
  if (!res.ok) return new Response("Not found", { status: 404 });
  return new Response(res.body, { headers: { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=86400" } });
}
