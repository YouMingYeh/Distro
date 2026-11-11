export type PublishInput = {
  jobId: string;
  /** Worker /files proxy URL, publicly downloadable. */
  videoUrl: string;
  caption: string;
  /** Defaults to true at the tool layer. */
  dryRun: boolean;
  /** ISO-8601. */
  scheduleAt?: string;
  aiGeneratedLabel: true;
};

export type PublishResult = {
  adapter: string;
  dryRun: boolean;
  accepted: boolean;
  externalId?: string;
  /** Exactly what would be / was sent, minus secrets. */
  payload: unknown;
  message: string;
};

export interface SchedulerAdapter {
  id: "dryrun" | "buffer" | "zernio" | "tiktok";
  publish(input: PublishInput): Promise<PublishResult>;
}

export class AdapterNotConfigured extends Error {}
