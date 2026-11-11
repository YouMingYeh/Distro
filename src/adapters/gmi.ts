import { ToolError, type Env } from "../env";
import { llmCostUsd } from "../models";

const LLM_BASE = "https://api.gmi-serving.com/v1";
const QUEUE_BASE = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey";

function headers(env: Env): Record<string, string> {
  if (!env.GMI_API_KEY) {
    throw new ToolError("GMI_API_KEY is not set on the server. Run `npx wrangler secret put GMI_API_KEY` and redeploy.");
  }
  const h: Record<string, string> = {
    Authorization: `Bearer ${env.GMI_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (env.GMI_ORG_ID) h["X-Organization-ID"] = env.GMI_ORG_ID;
  return h;
}

export type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ChatPart[] };

export type ChatResult = { text: string; prompt_tokens: number; completion_tokens: number; cost_usd: number; model: string };

/** Tracks LLM spend across a batch of calls so one reservation can be committed at the end. */
export class CostMeter {
  usd = 0;
  calls = 0;
  add(r: ChatResult) {
    this.usd += r.cost_usd;
    this.calls += 1;
  }
  get cents() {
    return Math.ceil(this.usd * 100);
  }
}

export async function chat(
  env: Env,
  model: string,
  messages: ChatMessage[],
  opts: { temperature?: number; max_tokens?: number; json?: boolean; timeoutMs?: number; meter?: CostMeter } = {},
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.max_tokens ?? 1500,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`GMI chat ${model} failed: HTTP ${res.status} ${detail}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  const pt = data.usage?.prompt_tokens ?? 0;
  const ct = data.usage?.completion_tokens ?? 0;
  const out: ChatResult = { text, prompt_tokens: pt, completion_tokens: ct, cost_usd: llmCostUsd(model, pt, ct), model };
  opts.meter?.add(out);
  return out;
}

/** Pull the first JSON object or array out of a model reply (tolerates code fences and stray prose). */
export function extractJson<T>(text: string): T {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through to bracket scan */
  }
  const start = cleaned.search(/[\[{]/);
  if (start >= 0) {
    const open = cleaned[start];
    const close = open === "{" ? "}" : "]";
    const end = cleaned.lastIndexOf(close);
    if (end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
  throw new Error("Model did not return JSON");
}

export async function chatJson<T>(
  env: Env,
  models: string[],
  messages: ChatMessage[],
  opts: { temperature?: number; max_tokens?: number; timeoutMs?: number; meter?: CostMeter } = {},
): Promise<T> {
  let lastErr: unknown;
  for (const model of models) {
    for (const json of [true, false]) {
      try {
        const r = await chat(env, model, messages, { ...opts, json });
        return extractJson<T>(r.text);
      } catch (e) {
        if (e instanceof ToolError) throw e;
        lastErr = e;
      }
    }
  }
  throw new Error(`LLM JSON call failed: ${String(lastErr).slice(0, 300)}`);
}

export async function listModels(env: Env): Promise<string[]> {
  const res = await fetch(`${LLM_BASE}/models`, { headers: headers(env), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GMI models failed: HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

export type QueueStatus = "queued" | "processing" | "dispatched" | "success" | "failed" | "cancelled" | string;
export type QueueRequest = {
  request_id: string;
  status: QueueStatus;
  outcome?: {
    media_urls?: { url?: string }[];
    video_url?: string;
    audio_url?: string;
    thumbnail_image_url?: string;
    [k: string]: unknown;
  } | null;
  error?: string | null;
};

function normalize(raw: Record<string, unknown>): QueueRequest {
  const outcome = (raw.outcome ?? null) as QueueRequest["outcome"];
  const err = (raw.error ?? raw.error_message ?? raw.message ?? (outcome as Record<string, unknown> | null)?.error ?? null) as unknown;
  return {
    request_id: String(raw.request_id ?? raw.id ?? ""),
    status: String(raw.status ?? "queued").toLowerCase(),
    outcome,
    error: err ? String(typeof err === "string" ? err : JSON.stringify(err)).slice(0, 400) : null,
  };
}

export async function queueSubmit(env: Env, model: string, payload: Record<string, unknown>): Promise<QueueRequest> {
  const res = await fetch(`${QUEUE_BASE}/requests`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ model, payload }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GMI submit ${model} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  const req = normalize(JSON.parse(text) as Record<string, unknown>);
  if (!req.request_id) throw new Error(`GMI submit ${model} returned no request_id: ${text.slice(0, 200)}`);
  return req;
}

export async function queueGet(env: Env, requestId: string): Promise<QueueRequest> {
  const res = await fetch(`${QUEUE_BASE}/requests/${encodeURIComponent(requestId)}`, {
    headers: headers(env),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GMI poll failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  return normalize(JSON.parse(text) as Record<string, unknown>);
}

export function outcomeUrl(req: QueueRequest): string | null {
  const o = req.outcome;
  if (!o) return null;
  return o.media_urls?.find((m) => m?.url)?.url ?? o.video_url ?? o.audio_url ?? null;
}

export const isDone = (s: QueueStatus) => s === "success";
export const isFailed = (s: QueueStatus) => s === "failed" || s === "cancelled" || s === "canceled" || s === "error";
