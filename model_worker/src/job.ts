import { DurableObject } from "cloudflare:workers";
import { gmiHeaders, JOB_TIMEOUT_S, nowS, pick, POLL_MS, QUEUE_URL, TERMINAL, type Env, type Job, type Status } from "./env";

/**
 * One Durable Object per job (idFromName(job_id)). start() submits to GMI and sets an
 * alarm; alarm() polls GMI and re-arms itself until the video is in R2 or the job ends.
 * Between alarms the object sleeps, so waiting on a 5-minute render costs nothing.
 */
export class JobDO extends DurableObject<Env> {
  private ledger() {
    return this.env.LEDGER.get(this.env.LEDGER.idFromName("global"));
  }

  private async save(job: Job) {
    await this.ctx.storage.put("job", job);
  }

  async get(): Promise<Job | null> {
    return (await this.ctx.storage.get<Job>("job")) ?? null;
  }

  private async finish(job: Job, status: Status, commit: boolean | null, error: string | null = null) {
    job.status = status;
    job.error = error;
    job.finished_at = nowS();
    job.elapsed_s = Math.round((job.finished_at - job.created_at) * 10) / 10;
    // commit=null keeps the reserve: GMI may still bill (timeouts, unknown submit outcome).
    if (commit !== null) await this.ledger().settle(job.job_id, commit, error ?? status);
    await this.save(job);
  }

  /** Called once by POST /generate after the ledger reserve succeeded. */
  async start(job: Job): Promise<Job> {
    await this.save(job);
    try {
      const r = await fetch(QUEUE_URL, {
        method: "POST",
        headers: gmiHeaders(this.env),
        body: JSON.stringify({ model: job.model, payload: job.payload }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await r.text();
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text.slice(0, 300) };
      }
      if (!r.ok) {
        await this.finish(job, "failed", false, `GMI submit HTTP ${r.status}: ${pick(body, "error", "message") ?? JSON.stringify(body).slice(0, 300)}`);
        return job;
      }
      job.gmi_request_id = pick(body, "request_id", "id", "data.request_id", "data.id") ?? null;
      if (!job.gmi_request_id) {
        await this.finish(job, "failed", false, `GMI submit returned no request_id: ${JSON.stringify(body).slice(0, 300)}`);
        return job;
      }
      job.status = "submitted";
      await this.save(job);
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    } catch (e) {
      // Unknown whether GMI accepted it: keep the reserve rather than under-count.
      await this.finish(job, "failed", null, `submit ${(e as Error).name}: ${(e as Error).message}`);
    }
    return job;
  }

  async alarm(): Promise<void> {
    const job = await this.get();
    if (!job || TERMINAL.has(job.status)) return;
    if (nowS() - job.created_at > JOB_TIMEOUT_S) {
      await this.finish(job, "timeout", null, `no result after ${JOB_TIMEOUT_S}s; reserve kept (may bill)`);
      return;
    }
    try {
      const r = await fetch(`${QUEUE_URL}/${job.gmi_request_id}`, { headers: gmiHeaders(this.env), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) {
        // Transient GMI error: try again next tick.
        await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
        return;
      }
      const pb = await r.json();
      const st = String(pick(pb, "status", "data.status") ?? "unknown").toLowerCase();
      job.gmi_status = st;
      if (["processing", "dispatched", "running"].includes(st)) job.status = "processing";

      if (["failed", "cancelled", "canceled", "error"].includes(st)) {
        const why = pick(pb, "error", "message", "outcome");
        await this.finish(job, "failed", false, `GMI ${st}: ${(typeof why === "string" ? why : JSON.stringify(why ?? "")).slice(0, 300)}`);
        return;
      }
      if (st !== "success") {
        await this.save(job);
        await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
        return;
      }

      job.gmi_video_url = pick(pb, "outcome.media_urls.0.url", "outcome.video_url", "data.outcome.media_urls.0.url", "data.outcome.video_url") ?? null;
      if (!job.gmi_video_url) {
        await this.finish(job, "failed", true, "GMI success without a video URL");
        return;
      }
      job.status = "downloading";
      await this.save(job);
      // Plain fetch: never send the GMI bearer to the storage host.
      const vid = await fetch(job.gmi_video_url, { signal: AbortSignal.timeout(120_000) });
      if (!vid.ok) throw new Error(`download HTTP ${vid.status}`);
      await this.env.BUCKET.put(`videos/${job.job_id}.mp4`, await vid.arrayBuffer(), {
        httpMetadata: { contentType: "video/mp4" },
      });
      await this.finish(job, "ready", true);
    } catch (e) {
      // GMI accepted the request, so we may be billed: commit rather than release.
      await this.finish(job, "failed", true, `${(e as Error).name}: ${(e as Error).message}`);
    }
  }
}
