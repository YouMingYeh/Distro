import type { PublishInput, PublishResult, SchedulerAdapter } from "./types";

/**
 * Stub. The TikTok for Business connector is the Ads / Marketing API, not the
 * organic Content Posting API, so it is not a scheduler for organic posts.
 */
export const tiktokAdapter: SchedulerAdapter = {
  id: "tiktok",
  async publish(input: PublishInput): Promise<PublishResult> {
    return {
      adapter: "tiktok",
      dryRun: true,
      accepted: false,
      payload: { video_url: input.videoUrl, caption: input.caption, ai_generated_label: true },
      message:
        "The tiktok adapter is a stub: TikTok for Business is an ads API, not organic posting. Use adapter=buffer or adapter=zernio for organic TikTok. Nothing was posted.",
    };
  },
};
