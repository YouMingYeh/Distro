/**
 * GMI model ids and list prices, pinned from the live catalog on 2026-11-11.
 * Re-pin with `GET https://api.gmi-serving.com/v1/models` if an id disappears.
 * Prices are LIST prices in USD (before any org discount); the spend cap
 * always reserves list price.
 */
export const MODELS = {
  /** Hook / script generation. */
  script: "deepseek-ai/deepseek-v4.1-flash-1017",
  /** Second generator used when the first one fails. */
  scriptAlt: "zai-org/GLM-5.3-Flash",
  /** Judge: a different model family from the generator. */
  judge: "Qwen/Qwen3.8-27B",
  judgeAlt: "MiniMaxAI/MiniMax-M3",
  /** Vision model for footage and frame checks. */
  vision: "Qwen/Qwen3.5-35B-A3B",
  tts: "minimax-tts-speech-2.8-turbo",
  video: "wan3.0-video",
} as const;

/** USD per token: [prompt, completion]. */
export const LLM_PRICES: Record<string, [number, number]> = {
  "deepseek-ai/deepseek-v4.1-flash-1017": [0.3e-6, 1.2e-6],
  "zai-org/GLM-5.3-Flash": [0.15e-6, 0.5e-6],
  "Qwen/Qwen3.8-27B": [0.45e-6, 3.2e-6],
  "MiniMaxAI/MiniMax-M3": [0.3e-6, 1.2e-6],
  "Qwen/Qwen3.5-35B-A3B": [0.25e-6, 2.0e-6],
};
/** Conservative fallback for an unlisted model. */
export const LLM_PRICE_FALLBACK: [number, number] = [2e-6, 8e-6];

/** Wan 3.0 list price, USD per second of output. */
export const WAN_USD_PER_S: Record<"480P" | "720P" | "1080P", number> = {
  "480P": 0.05,
  "720P": 0.1,
  "1080P": 0.2,
};

/** MiniMax TTS turbo: USD per 1,000 characters. */
export const TTS_USD_PER_1K_CHARS = 0.06;
export const TTS_VOICE_DEFAULT = "English_expressive_narrator";

export function llmCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const [p, c] = LLM_PRICES[model] ?? LLM_PRICE_FALLBACK;
  return promptTokens * p + completionTokens * c;
}

export function wanCostCents(resolution: "480P" | "720P", durationS: number): number {
  return Math.ceil(WAN_USD_PER_S[resolution] * durationS * 100);
}

export function ttsCostCents(chars: number): number {
  return Math.max(1, Math.ceil((chars / 1000) * TTS_USD_PER_1K_CHARS * 100));
}
