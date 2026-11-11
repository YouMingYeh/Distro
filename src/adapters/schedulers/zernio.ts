import type { Env } from "../../env";
import { AdapterNotConfigured, type PublishInput, type PublishResult, type SchedulerAdapter } from "./types";

const BASE = "https://zernio.com/api/v1";

/**
 * Zernio (REST). A dry run only builds the payload and skips the network.
 * publishNow is never set: a live call creates a scheduled post when
 * schedule_at is given, otherwise a draft. The live path is best-effort and
 * unverified against a real account.
 */
export function zernioAdapter(env: Env): SchedulerAdapter {
  return {
    id: "zernio",
    async publish(input: PublishInput): Promise<PublishResult> {
      const body = {
        content: input.caption,
        mediaItems: [{ type: "video", url: input.videoUrl }],
        platforms: [{ platform: "tiktok" }],
        ...(input.scheduleAt ? { scheduledFor: input.scheduleAt } : { is_draft: true }),
        tiktokSettings: { video_made_with_ai: true },
      };
      const payload = { endpoint: `${BASE}/posts`, method: "POST", body };
      if (input.dryRun) {
        return { adapter: "zernio", dryRun: true, accepted: true, payload, message: "Dry-run only; this is the request that would be sent to Zernio. Nothing was posted." };
      }
      if (!env.ZERNIO_API_KEY) throw new AdapterNotConfigured("Zernio adapter not configured: set ZERNIO_API_KEY on the server.");
      const res = await fetch(`${BASE}/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ZERNIO_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json().catch(() => ({}))) as { post?: { _id?: string; id?: string }; id?: string; error?: string; message?: string };
      const id = data.post?._id ?? data.post?.id ?? data.id;
      return {
        adapter: "zernio",
        dryRun: false,
        accepted: res.ok,
        externalId: id,
        payload,
        message: res.ok ? (input.scheduleAt ? "Scheduled in Zernio." : "Saved as a draft in Zernio.") : `Zernio did not accept the post: ${data.error ?? data.message ?? `HTTP ${res.status}`}`,
      };
    },
  };
}
