import { env } from "./env";

// ponytail: mock. Jobs live in KV and "finish" on a timer; nothing is rendered or billed.
// Swap generateVideo/getJob for calls to the real inference endpoint when it exists;
// the tool contracts in tools.ts do not need to change.

export const MODELS = [
  { id: "mock/text-to-video", kind: "video", input: "prompt" },
  { id: "mock/image-to-video", kind: "video", input: "prompt + image_url" },
  { id: "mock/text-to-speech", kind: "audio", input: "prompt" },
] as const;

type Job = { job_id: string; model: string; prompt: string; created_at: number };

export async function generateVideo(workspaceId: string, input: { model: string; prompt: string }) {
  const job: Job = { job_id: `job_${crypto.randomUUID().slice(0, 12)}`, ...input, created_at: Date.now() };
  await env.OAUTH_KV.put(`job:${workspaceId}:${job.job_id}`, JSON.stringify(job), { expirationTtl: 86_400 });
  return { job_id: job.job_id, status: "queued", mock: true, poll: "get_job" };
}

export async function getJob(workspaceId: string, jobId: string) {
  const job = await env.OAUTH_KV.get<Job>(`job:${workspaceId}:${jobId}`, "json");
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  const age = (Date.now() - job.created_at) / 1000;
  const status = age < 5 ? "queued" : age < 20 ? "running" : "ready";
  return {
    job_id: job.job_id,
    model: job.model,
    status,
    mock: true,
    video_url: status === "ready" ? `https://example.com/mock/${job.job_id}.mp4` : null,
  };
}
