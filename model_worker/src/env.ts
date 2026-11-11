import type { JobDO } from "./job";
import type { LedgerDO } from "./ledger";

export interface Env {
  GMI_API_KEY: string;
  GMI_ORG_ID?: string;
  /** Required: every call can spend money, so the Worker refuses requests without it. */
  MODEL_SERVER_TOKEN: string;
  SPEND_CAP_USD: string;
  MAX_RENDER_USD: string;
  /** Spend already committed before this Worker existed (carried over from the Python server). */
  INITIAL_COMMITTED_USD?: string;
  PUBLIC_BASE_URL?: string;
  BUCKET: R2Bucket;
  LEDGER: DurableObjectNamespace<LedgerDO>;
  JOB: DurableObjectNamespace<JobDO>;
}

export const QUEUE_URL = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests";
export const POLL_MS = 10_000;
export const JOB_TIMEOUT_S = 900;

export type Status = "queued" | "submitted" | "processing" | "downloading" | "ready" | "failed" | "timeout";
export const TERMINAL: ReadonlySet<Status> = new Set(["ready", "failed", "timeout"]);

export type Job = {
  job_id: string;
  model: string;
  status: Status;
  est_usd: number;
  duration_s: number;
  warnings: string[];
  payload: Record<string, unknown>;
  gmi_request_id: string | null;
  gmi_status: string | null;
  gmi_video_url: string | null;
  video_url: string | null;
  created_at: number; // unix seconds, same as the Python server
  finished_at: number | null;
  elapsed_s: number | null;
  error: string | null;
};

export function gmiHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${env.GMI_API_KEY}`, "Content-Type": "application/json" };
  if (env.GMI_ORG_ID) h["X-Organization-ID"] = env.GMI_ORG_ID;
  return h;
}

/** First non-empty value among dotted paths (tolerant of GMI response shape drift). */
export function pick(d: unknown, ...paths: string[]): any {
  for (const path of paths) {
    let cur: any = d;
    for (const part of path.split(".")) {
      if (Array.isArray(cur)) cur = /^\d+$/.test(part) ? cur[Number(part)] : undefined;
      else if (cur && typeof cur === "object") cur = cur[part];
      else cur = undefined;
      if (cur === undefined || cur === null) break;
    }
    if (cur) return cur;
  }
  return undefined;
}

export const nowS = () => Date.now() / 1000;
