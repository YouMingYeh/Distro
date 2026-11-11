/**
 * Distro video model Worker: the same HTTP API as model_server/ (see model_server/README.md),
 * running serverless on Cloudflare.
 *
 *   POST /generate            start a job (any catalog model id, or a tier: fast / default / quality)
 *   POST /generate?wait=true  wait until the video is ready (or wait_timeout seconds), then return the job
 *   GET  /jobs/{id}           job status, cost, video_url
 *   GET  /jobs/{id}/video     the finished mp4 (from R2)
 *   GET  /models              selectable models with flags and a 5s estimate
 *   GET  /spend               spend cap, reserved, committed
 *   GET  /health              no auth
 *
 * Every route except /health needs `Authorization: Bearer $MODEL_SERVER_TOKEN`.
 */
import { BuildError, build, CATALOG, HttpError, resolveModel, type VideoRequest } from "./gmiVideo";
import { nowS, TERMINAL, type Env, type Job } from "./env";

export { JobDO } from "./job";
export { LedgerDO } from "./ledger";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
// Same error shape as the FastAPI server: {"detail": "..."}
const detail = (status: number, msg: string) => json({ detail: msg }, status);

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  if (!env.MODEL_SERVER_TOKEN) return false; // fail closed: a public URL that spends money
  return timingSafeEqual(req.headers.get("authorization") ?? "", `Bearer ${env.MODEL_SERVER_TOKEN}`);
}

const ledger = (env: Env) => env.LEDGER.get(env.LEDGER.idFromName("global"));
const jobStub = (env: Env, id: string) => env.JOB.get(env.JOB.idFromName(id));

function publicJob(job: Job, req: Request, env: Env) {
  const out = { ...job };
  if (job.status === "ready") {
    const base = (env.PUBLIC_BASE_URL || new URL(req.url).origin).replace(/\/$/, "");
    out.video_url = `${base}/jobs/${job.job_id}/video`;
  }
  return out;
}

/** Parse and validate the POST /generate body; defaults match the Python server. */
function parseBody(raw: any): { model: string; dry_run: boolean; req: VideoRequest } {
  if (!raw || typeof raw !== "object") throw new HttpError(422, "body must be a JSON object");
  if (typeof raw.prompt !== "string" || !raw.prompt.trim()) throw new HttpError(422, "prompt is required");
  const duration = raw.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new HttpError(422, "duration must be an integer 1-30");
  const optStr = (k: string) => {
    const v = raw[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new HttpError(422, `${k} must be a string`);
    return v;
  };
  return {
    model: typeof raw.model === "string" ? raw.model : "default",
    dry_run: raw.dry_run === true,
    req: {
      prompt: raw.prompt,
      duration,
      aspect: optStr("aspect") ?? "9:16",
      resolution: optStr("resolution") ?? "720p",
      negative_prompt: optStr("negative_prompt"),
      first_frame: optStr("first_frame"),
      last_frame: optStr("last_frame"),
      audio_url: optStr("audio_url"),
      audio: raw.audio === undefined ? true : raw.audio === true,
      seed: Number.isInteger(raw.seed) ? raw.seed : null,
    },
  };
}

async function generate(request: Request, env: Env, url: URL): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return detail(422, "body must be valid JSON");
  }
  const { model, dry_run, req } = parseBody(raw);
  const entry = resolveModel(model);
  let b;
  try {
    b = build(entry, req);
  } catch (e) {
    if (e instanceof BuildError) return detail(400, e.message);
    throw e;
  }
  const maxRender = Number(env.MAX_RENDER_USD ?? "1");
  if (b.est_usd > maxRender) return detail(402, `${b.model} estimate $${b.est_usd.toFixed(2)} exceeds MAX_RENDER_USD $${maxRender.toFixed(2)}`);
  if (dry_run) {
    return json({ dry_run: true, model: b.model, payload: b.payload, est_usd: b.est_usd, duration_s: b.duration, price_source: b.price_source, warnings: b.warnings });
  }

  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const jobId = `job_${[...bytes].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  const reserved = await ledger(env).reserve(jobId, b.est_usd, `${b.model} ${b.duration}s`);
  if (!reserved.ok) return detail(402, reserved.error);

  const job: Job = {
    job_id: jobId,
    model: b.model,
    status: "queued",
    est_usd: b.est_usd,
    duration_s: b.duration,
    warnings: b.warnings,
    payload: b.payload,
    gmi_request_id: null,
    gmi_status: null,
    gmi_video_url: null,
    video_url: null,
    created_at: nowS(),
    finished_at: null,
    elapsed_s: null,
    error: null,
  };
  const stub = jobStub(env, jobId);
  let current = await stub.start(job);

  if (url.searchParams.get("wait") === "true") {
    const waitS = Math.min(Number(url.searchParams.get("wait_timeout") ?? "600") || 600, 900);
    const deadline = Date.now() + waitS * 1000;
    while (!TERMINAL.has(current.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      current = (await stub.get()) ?? current;
    }
  }
  return json(publicJob(current, request, env));
}

function listModels(url: URL) {
  const all = url.searchParams.get("all") === "true";
  const probe: VideoRequest = { prompt: "x", duration: 5, aspect: "9:16", resolution: "720p", audio: true };
  const models = CATALOG.models
    .filter((e) => all || (e.selectable && e.text_to_video && e.supports_9_16))
    .map((e) => {
      let est: number | null = null;
      try {
        est = build(e, probe).est_usd;
      } catch {
        /* not buildable */
      }
      return {
        id: e.id,
        tier: e.featured,
        provider: e.provider,
        est_usd_5s_720p: est,
        text_to_video: e.text_to_video,
        image_to_video: e.image_to_video,
        supports_9_16: e.supports_9_16,
        audio_drive: "audio_drive" in e.map,
        description: e.description,
      };
    });
  return json({ tiers: CATALOG.featured, models });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/health" && request.method === "GET") {
        return json({ ok: true, models: CATALOG.models.length, catalog_generated_at: CATALOG.generated_at, storage: "r2" });
      }
      if (!authorized(request, env)) return detail(401, "missing or bad bearer token");

      if (path === "/generate" && request.method === "POST") return await generate(request, env, url);
      if (path === "/models" && request.method === "GET") return listModels(url);
      if (path === "/spend" && request.method === "GET") return json(await ledger(env).summary());

      const m = path.match(/^\/jobs\/(job_[0-9a-f]{12})(\/video)?$/);
      if (m && request.method === "GET") {
        const job = await jobStub(env, m[1]).get();
        if (!job) return detail(404, "unknown job");
        if (!m[2]) return json(publicJob(job, request, env));
        if (job.status !== "ready") return detail(404, "video not ready");
        const obj = await env.BUCKET.get(`videos/${job.job_id}.mp4`);
        if (!obj) return detail(404, "video file missing");
        return new Response(obj.body, {
          headers: {
            "content-type": "video/mp4",
            "content-length": String(obj.size),
            "content-disposition": `inline; filename="${job.job_id}.mp4"`,
          },
        });
      }
      return detail(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return detail(e.status, e.message);
      console.error(e);
      return detail(500, `${(e as Error).name}: ${(e as Error).message}`);
    }
  },
} satisfies ExportedHandler<Env>;
