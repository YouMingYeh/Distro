import seedFile from "../../fixtures/hook-patterns-seed.json";
import { chatJson, CostMeter } from "../adapters/gmi";
import { DarkUgcClient, DarkUgcUnavailable } from "../adapters/darkugc";
import { assetsBlock, listAssets } from "../db/client";
import { newId, nowIso, ToolError, usd, utcDay, type Env } from "../env";
import { commit, guard, release, reserve } from "../guardrails/spend";
import { MODELS } from "../models";
import { researchDistillPrompt, seedAdaptPrompt } from "../prompts";
import { brandBrief, getBrand, NO_BRAND_ERROR } from "./brand";

type SeedPattern = { id: string; hook_type: string; format_family: string; why: string; how_to_adapt: string };
const SEEDS = (seedFile as { patterns: SeedPattern[] }).patterns;

export type ResearchInput = {
  brief?: string;
  platform?: "TikTok" | "Instagram";
  posted_within_days?: number;
  max_calls?: number;
  competitor_brands?: string[];
};

type Pattern = {
  pattern_id: string;
  hook_type: string;
  format_family: string;
  why: string;
  brand_angle: string;
  evidence: { view_band?: string; recency?: string; n_examples?: number; source?: string };
};

/** Shrink an upstream payload to a bounded string for the LLM. Held in memory only. */
function compact(label: string, data: unknown, max = 5000): string {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return `## ${label}\n${text.slice(0, max)}`;
}

const RESEARCH_RESERVE_CENTS = 5;

export async function researchHooks(env: Env, input: ResearchInput) {
  const brand = await getBrand(env);
  if (!brand && !input.brief?.trim()) throw new ToolError(NO_BRAND_ERROR);
  const brief = brandBrief(brand, input.brief);
  const platform = input.platform ?? (brand?.platform === "Instagram" ? "Instagram" : "TikTok");
  const days = Math.min(90, Math.max(7, input.posted_within_days ?? 45));
  const competitors = (input.competitor_brands?.length ? input.competitor_brands : brand?.competitors ?? []).slice(0, 10);
  const researchId = newId("rsh");
  const assets = await listAssets(env);
  const aBlock = assetsBlock(assets);
  const validAssetIds = new Set(assets.map((a) => a.id));
  const notes: string[] = [];

  // ---- 1. Live research (DarkUGC), bounded by max_calls and the daily cap.
  const state = await guard(env).getState(utcDay());
  const remainingToday = Math.max(0, state.darkugc_daily_cap - state.darkugc_today);
  const budget = Math.min(Math.max(1, input.max_calls ?? 12), 30, remainingToday);
  const summaries: string[] = [];
  let callsUsed = 0;

  if (!DarkUgcClient.configured(env)) {
    notes.push("Live research is not connected on this server, so generic seed patterns were used.");
  } else if (budget < 1) {
    notes.push("Daily research call cap reached, so generic seed patterns were used.");
  } else {
    const client = new DarkUgcClient(env, budget);
    try {
      const niche = brand?.niche ?? undefined;
      const query = (brand?.niche || brand?.name || input.brief || "").slice(0, 100) || undefined;
      const steps: [string, string, Record<string, unknown>][] = [
        ["trending now", "trending_now", { days: 7, platform }],
        competitors.length
          ? ["competitors by hook type", "query_library", { brands: competitors, posted_within_days: days, platform, group_by: "hook_type", sort_by: "median_views", limit: 12 }]
          : ["niche by hook type", "query_library", { query, posted_within_days: days, platform, group_by: "hook_type", sort_by: "median_views", limit: 12 }],
        competitors.length
          ? ["top hooks (competitors)", "top_hooks", { brands: competitors, posted_within_days: days, platform, sort: "views" }]
          : ["top hooks (niche)", "top_hooks", { query, posted_within_days: days, platform, sort: "views" }],
        ["formats", "query_library", { query: competitors.length ? undefined : query, brands: competitors, posted_within_days: days, platform, group_by: "format_family", sort_by: "median_views", limit: 10 }],
        ["hook techniques", "query_library", { query: competitors.length ? undefined : query, brands: competitors, posted_within_days: days, platform, group_by: "hook_technique", sort_by: "median_views", limit: 10 }],
        ["niche analysis", "analyze_niche", { brand_category: niche, platform, posted_within_days: days }],
      ];
      for (const [label, tool, args] of steps) {
        if (client.budgetLeft < 1) break;
        if (tool === "analyze_niche" && !niche) continue;
        const data = await client.call(tool, args);
        if (data !== null && data !== undefined && data !== "") summaries.push(compact(label, data));
      }
    } catch (e) {
      if (!(e instanceof DarkUgcUnavailable)) throw e;
      notes.push(`Live research was unavailable (${e.message}) so generic seed patterns were used.`);
    }
    callsUsed = client.callsUsed;
    if (callsUsed > 0 && !summaries.length) notes.push("Live research returned nothing usable, so generic seed patterns were used.");
  }

  // ---- 2. Distill into original patterns + original lines for this brand.
  const useLive = summaries.length > 0;
  const reserveKey = `research:${researchId}`;
  const meter = new CostMeter();
  let patterns: Pattern[] = [];
  let seedHooks: { text: string; pattern_id: string | null; footage_hints: string[] }[] = [];
  let llmNote: string | undefined;
  let reserved = false;

  try {
    await reserve(env, { cents: RESEARCH_RESERVE_CENTS, key: reserveKey, model: MODELS.script, note: "research distill" });
    reserved = true;
    if (useLive) {
      const out = await chatJson<{
        patterns?: { hook_type?: string; format_family?: string; why?: string; brand_angle?: string; evidence?: Pattern["evidence"] }[];
        seed_hooks?: { text?: string; pattern_index?: number; footage_hints?: string[] }[];
        notes?: string;
      }>(env, [MODELS.script, MODELS.scriptAlt], [{ role: "user", content: `${researchDistillPrompt(brief, platform, aBlock)}\n\nResearch summaries:\n${summaries.join("\n\n").slice(0, 24_000)}` }], {
        temperature: 0.6,
        max_tokens: 2500,
        meter,
      });
      patterns = (out.patterns ?? []).slice(0, 8).map((p) => ({
        pattern_id: newId("pat"),
        hook_type: String(p.hook_type ?? "other").slice(0, 40),
        format_family: String(p.format_family ?? "").slice(0, 80),
        why: String(p.why ?? "").slice(0, 400),
        brand_angle: String(p.brand_angle ?? "").slice(0, 400),
        evidence: { view_band: p.evidence?.view_band, recency: p.evidence?.recency ?? `last_${days}d`, n_examples: p.evidence?.n_examples, source: "live" },
      }));
      seedHooks = (out.seed_hooks ?? [])
        .filter((h) => h.text)
        .slice(0, 10)
        .map((h) => ({
          text: String(h.text).slice(0, 200),
          pattern_id: patterns[Number(h.pattern_index)]?.pattern_id ?? null,
          footage_hints: (h.footage_hints ?? []).filter((id) => validAssetIds.has(id)),
        }));
      if (out.notes) llmNote = String(out.notes).slice(0, 300);
    }
    if (!patterns.length) {
      const block = SEEDS.map((s) => `- ${s.id} [${s.hook_type} / ${s.format_family}]: ${s.why} How to adapt: ${s.how_to_adapt}`).join("\n");
      const out = await chatJson<{
        patterns?: { seed_id?: string; brand_angle?: string }[];
        seed_hooks?: { text?: string; seed_id?: string; footage_hints?: string[] }[];
      }>(env, [MODELS.script, MODELS.scriptAlt], [{ role: "user", content: seedAdaptPrompt(brief, platform, block, aBlock) }], { temperature: 0.7, max_tokens: 2000, meter });
      const bySeed = new Map<string, Pattern>();
      for (const p of out.patterns ?? []) {
        const seed = SEEDS.find((s) => s.id === p.seed_id);
        if (!seed || bySeed.has(seed.id)) continue;
        bySeed.set(seed.id, {
          pattern_id: newId("pat"),
          hook_type: seed.hook_type,
          format_family: seed.format_family,
          why: seed.why,
          brand_angle: String(p.brand_angle ?? seed.how_to_adapt).slice(0, 400),
          evidence: { source: "seed" },
        });
      }
      patterns = [...bySeed.values()].slice(0, 8);
      seedHooks = (out.seed_hooks ?? [])
        .filter((h) => h.text)
        .slice(0, 10)
        .map((h) => ({
          text: String(h.text).slice(0, 200),
          pattern_id: (h.seed_id && bySeed.get(h.seed_id)?.pattern_id) || null,
          footage_hints: (h.footage_hints ?? []).filter((id) => validAssetIds.has(id)),
        }));
    }
  } catch (e) {
    if (e instanceof ToolError && !reserved) throw e;
    notes.push(`Could not draft brand lines (${String(e instanceof Error ? e.message : e).slice(0, 140)}).`);
  }

  if (!patterns.length) {
    // Last resort: generic seed patterns with their generic adaptation note.
    patterns = SEEDS.slice(0, 8).map((s) => ({
      pattern_id: newId("pat"),
      hook_type: s.hook_type,
      format_family: s.format_family,
      why: s.why,
      brand_angle: s.how_to_adapt,
      evidence: { source: "seed" },
    }));
  }
  if (reserved) {
    if (meter.calls > 0) await commit(env, reserveKey, meter.cents, { model: MODELS.script, note: "research distill" });
    else await release(env, reserveKey, { note: "research distill (no LLM call)" });
  }

  const usedSeed = patterns.every((p) => p.evidence.source === "seed");
  if (usedSeed && !notes.some((n) => n.includes("seed patterns"))) notes.push("Generic seed patterns were used.");
  if (llmNote) notes.push(llmNote);
  const noteText = notes.join(" ");

  // ---- 3. Persist derived data only (no source content).
  const now = nowIso();
  const stmts = [
    env.DB.prepare(`INSERT INTO research_runs (id,created_at,platform,posted_within_days,calls_used,notes) VALUES (?,?,?,?,?,?)`).bind(researchId, now, platform, days, callsUsed, noteText || null),
    ...patterns.map((p) =>
      env.DB.prepare(`INSERT INTO patterns (id,research_id,hook_type,format_family,why,brand_angle,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(
        p.pattern_id,
        researchId,
        p.hook_type,
        p.format_family,
        p.why,
        p.brand_angle,
        JSON.stringify(p.evidence),
        now,
      ),
    ),
    env.DB.prepare(`INSERT INTO kv (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(
      `seed_hooks:${researchId}`,
      JSON.stringify(seedHooks),
      now,
    ),
  ];
  await env.DB.batch(stmts);

  const after = await guard(env).getState(utcDay());
  return {
    research_id: researchId,
    source: usedSeed ? "seed_patterns" : "live",
    patterns,
    seed_hooks: seedHooks,
    calls_used: callsUsed,
    calls_remaining_today: Math.max(0, after.darkugc_daily_cap - after.darkugc_today),
    cost_usd: usd(meter.cents),
    notes: noteText || "Patterns distilled from live research.",
  };
}
