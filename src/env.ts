import type { GuardrailsDO } from "./guardrails/GuardrailsDO";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  GUARDRAILS: DurableObjectNamespace<GuardrailsDO>;
  MAKE_VIDEO: Workflow;

  GMI_API_KEY?: string;
  GMI_ORG_ID?: string;

  DARKUGC_MCP_URL?: string;
  DARKUGC_ACCESS_TOKEN?: string;
  DARKUGC_REFRESH_TOKEN?: string;
  DARKUGC_TOKEN_ENDPOINT?: string;
  DARKUGC_CLIENT_ID?: string;

  SPEND_CAP_USD?: string;
  MAX_RENDER_USD?: string;
  DARKUGC_DAILY_CALL_CAP?: string;
  CONFIRM_USD_THRESHOLD?: string;
  UPLOAD_MAX_WORKER_BYTES?: string;
  UPLOAD_MAX_PRESIGN_BYTES?: string;

  DISTRO_BEARER_TOKEN?: string;

  FFMPEG_SERVICE_URL?: string;
  FFMPEG_SERVICE_TOKEN?: string;
  /** Local development only: lets `wrangler dev` call an ffmpeg service on localhost. */
  ALLOW_LOCAL_FFMPEG?: string;
  FILES_SIGNING_SECRET?: string;

  CLOUDFLARE_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;

  /** Must be "1" before publish will make a live (non dry-run) post. Off by default. */
  ALLOW_LIVE_PUBLISH?: string;
  BUFFER_ACCESS_TOKEN?: string;
  ZERNIO_API_KEY?: string;

  /** Optional override of the public origin (custom domain). */
  PUBLIC_BASE_URL?: string;
}

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function config(env: Env) {
  return {
    capCents: Math.round(num(env.SPEND_CAP_USD, 9) * 100),
    maxRenderCents: Math.round(num(env.MAX_RENDER_USD, 1) * 100),
    darkUgcDailyCap: Math.round(num(env.DARKUGC_DAILY_CALL_CAP, 30)),
    confirmCents: Math.round(num(env.CONFIRM_USD_THRESHOLD, 0.5) * 100),
    uploadMaxWorker: Math.round(num(env.UPLOAD_MAX_WORKER_BYTES, 83886080)),
    uploadMaxPresign: Math.round(num(env.UPLOAD_MAX_PRESIGN_BYTES, 536870912)),
  };
}

export const usd = (cents: number) => Math.round(cents) / 100;
export const nowIso = () => new Date().toISOString();
export const utcDay = () => new Date().toISOString().slice(0, 10);

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An error whose message is safe and useful to show to the calling agent. */
export class ToolError extends Error {}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
