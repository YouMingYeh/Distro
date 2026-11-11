import type { PublishInput, PublishResult, SchedulerAdapter } from "./types";

/** Always succeeds and never touches the network. */
export const dryrunAdapter: SchedulerAdapter = {
  id: "dryrun",
  async publish(input: PublishInput): Promise<PublishResult> {
    return {
      adapter: "dryrun",
      dryRun: true,
      accepted: true,
      payload: {
        video_url: input.videoUrl,
        caption: input.caption,
        schedule_at: input.scheduleAt ?? null,
        ai_generated_label: true,
      },
      message: "Dry-run only; nothing was posted.",
    };
  },
};
