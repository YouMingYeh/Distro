import { chatJson, CostMeter } from "../adapters/gmi";
import { assetsBlock, listAssets } from "../db/client";
import { newId, nowIso, safeJson, ToolError, usd, type Env } from "../env";
import { commit, release, reserve } from "../guardrails/spend";
import { MODELS } from "../models";
import { hookGenPrompt, pairwisePrompt, pointwisePrompt, POINTWISE_CRITERIA } from "../prompts";
import { brandBrief, getBrand, NO_BRAND_ERROR, type Brand } from "./brand";

export type RankInput = { research_id?: string; brief?: string; n?: number; seed_hooks?: string[] };

type Candidate = {
  hook: string;
  body: string;
  cta: string;
  pattern_id: string | null;
  want_talking_head: boolean;
  footage_hints: string[];
  pointwise_avg?: number;
  elo?: number;
  reasons: string[];
};

/** How many finalists enter the pairwise tournament (each pair is judged in both orders). */
const PAIRWISE_FINALISTS = 6;
const RANK_RESERVE_CENTS = 15;

const BANNED_PATTERNS: RegExp[] = [
  /\b(cure[sd]?|diagnos\w*|heals?|treats?|therap(y|ist) replacement|clinically proven)\b/i,
  /\bsav(e|es|ed|ing) (your|my|our|the) (relationship|marriage)\b/i,
  /\b(spy(ing)? on|stalk\w*|track (your|their|his|her) (partner|boyfriend|girlfriend|ex|location)|always watching|secretly (watch|see|read))\b/i,
  /\bguarantee[ds]?\b/i,
];

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function defaultCta(brand: Brand | null): string {
  if (brand?.cta) return brand.cta;
  if (brand?.name) return `Try ${brand.name} today.`;
  return "Link in bio to try it.";
}

const scriptText = (c: Candidate) => `Hook: ${c.hook}\nBody: ${c.body}\nCTA: ${c.cta}`;

export async function rankHooks(env: Env, input: RankInput) {
  const brand = await getBrand(env);
  if (!brand && !input.brief?.trim()) throw new ToolError(NO_BRAND_ERROR);
  const brief = brandBrief(brand, input.brief);
  const platform = brand?.platform ?? "TikTok";
  const n = Math.min(40, Math.max(5, input.n ?? 20));
  const cta = defaultCta(brand);

  // Patterns: the given research run, else the most recent one.
  let researchId = input.research_id ?? null;
  if (researchId) {
    const exists = await env.DB.prepare(`SELECT id FROM research_runs WHERE id=?`).bind(researchId).first();
    if (!exists) throw new ToolError(`Unknown research_id ${researchId}. Call research_hooks first or omit research_id.`);
  } else {
    researchId = (await env.DB.prepare(`SELECT id FROM research_runs ORDER BY created_at DESC LIMIT 1`).first<{ id: string }>())?.id ?? null;
  }
  const patterns = researchId
    ? ((await env.DB.prepare(`SELECT id,hook_type,format_family,why,brand_angle FROM patterns WHERE research_id=?`).bind(researchId).all<{ id: string; hook_type: string; format_family: string; why: string; brand_angle: string }>()).results ?? [])
    : [];
  const patternIds = new Set(patterns.map((p) => p.id));
  const patternsBlock = patterns.map((p) => `- ${p.id} [${p.hook_type} / ${p.format_family}]: ${p.why} Angle: ${p.brand_angle}`).join("\n");

  const storedSeeds = researchId
    ? safeJson<{ text: string }[]>((await env.DB.prepare(`SELECT value FROM kv WHERE key=?`).bind(`seed_hooks:${researchId}`).first<{ value: string }>())?.value, [])
    : [];
  const seedBlock = [...(input.seed_hooks ?? []), ...storedSeeds.map((s) => s.text)]
    .slice(0, 14)
    .map((s) => `- ${s}`)
    .join("\n");

  const assets = await listAssets(env);
  const aBlock = assetsBlock(assets);
  const validAssetIds = new Set(assets.map((a) => a.id));

  const runId = newId("rnk");
  const reserveKey = `rank:${runId}`;
  await reserve(env, { cents: RANK_RESERVE_CENTS, key: reserveKey, model: MODELS.judge, note: `rank run (${n} hooks)` });
  const meter = new CostMeter();

  try {
    // ---- 1. Generate with two model families in parallel for diversity.
    const half = Math.ceil(n / 2) + 2;
    const gen = async (model: string, alt: string) => {
      try {
        const out = await chatJson<{ candidates?: Partial<Candidate>[] }>(env, [model, alt], [{ role: "user", content: hookGenPrompt(brief, platform, half, patternsBlock, seedBlock, aBlock, cta) }], {
          temperature: 0.95,
          max_tokens: 3200,
          timeoutMs: 45_000,
          meter,
        });
        return out.candidates ?? [];
      } catch (e) {
        if (e instanceof ToolError) throw e;
        console.warn(`hook generation with ${model} failed: ${String(e).slice(0, 160)}`);
        return [];
      }
    };
    const [g1, g2] = await Promise.all([gen(MODELS.script, MODELS.scriptAlt), gen(MODELS.scriptAlt, MODELS.script)]);
    const raw: Candidate[] = [...g1, ...g2]
      .filter((c) => typeof c?.hook === "string" && c.hook.trim())
      .map((c) => ({
        hook: String(c.hook).trim().replace(/^["“]|["”]$/g, "").slice(0, 220),
        body: String(c.body ?? "").trim().slice(0, 400),
        cta: String(c.cta ?? cta).trim().slice(0, 160) || cta,
        pattern_id: c.pattern_id && patternIds.has(String(c.pattern_id)) ? String(c.pattern_id) : null,
        want_talking_head: c.want_talking_head !== false,
        footage_hints: (Array.isArray(c.footage_hints) ? c.footage_hints : []).map(String).filter((id) => validAssetIds.has(id)),
        reasons: [],
      }));
    if (!raw.length) throw new ToolError("The script models returned no usable hooks. Try again in a moment, or pass a more specific brief.");

    // ---- 2. Rule filter.
    const avoid = (brand?.avoid_claims ?? []).map((a) => a.toLowerCase()).filter((a) => a.length > 3);
    let ruleFiltered = 0;
    const passed = raw.filter((c) => {
      const text = `${c.hook} ${c.body} ${c.cta}`;
      const words = c.hook.split(/\s+/).length;
      const bad = words < 3 || words > 24 || BANNED_PATTERNS.some((re) => re.test(text)) || avoid.some((a) => text.toLowerCase().includes(a));
      if (bad) ruleFiltered++;
      return !bad;
    });

    // ---- 3. Dedupe (exact + lexical near-duplicates).
    let nearDupes = 0;
    const unique: (Candidate & { _t: Set<string> })[] = [];
    for (const c of passed) {
      const t = tokens(c.hook);
      if (unique.some((u) => jaccard(u._t, t) >= 0.6)) {
        nearDupes++;
        continue;
      }
      unique.push({ ...c, _t: t });
    }
    const cands: Candidate[] = unique.slice(0, n).map(({ _t, ...c }) => c);
    if (!cands.length) throw new ToolError("Every generated hook was filtered out by the safety rules. Loosen avoid_claims or add more product detail with set_brand.");

    // ---- 4. Pointwise scoring (reason first, criteria order shuffled).
    const criteria = shuffle(POINTWISE_CRITERIA);
    const block = cands.map((c, i) => `#${i + 1}\n${scriptText(c)}\nFootage hints: ${c.footage_hints.join(", ") || "none"}`).join("\n\n");
    try {
      const out = await chatJson<{ scores?: Record<string, unknown>[] }>(env, [MODELS.judge, MODELS.judgeAlt], [{ role: "user", content: pointwisePrompt(brief, platform, criteria, block, aBlock) }], {
        temperature: 0.2,
        max_tokens: 3500,
        timeoutMs: 50_000,
        meter,
      });
      for (const s of out.scores ?? []) {
        const c = cands[Number(s.i) - 1];
        if (!c) continue;
        const vals = POINTWISE_CRITERIA.map((k) => Number(s[k.key])).filter((v) => Number.isFinite(v) && v >= 1 && v <= 5);
        if (vals.length) c.pointwise_avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
        if (s.reason) c.reasons.push(String(s.reason).slice(0, 220));
      }
    } catch (e) {
      console.warn(`pointwise judge failed: ${String(e).slice(0, 160)}`);
    }
    const scored = cands.some((c) => c.pointwise_avg !== undefined);
    cands.sort((a, b) => (b.pointwise_avg ?? 0) - (a.pointwise_avg ?? 0));

    // ---- 5. Pairwise tournament among the finalists, both orders, Elo K=32.
    const strong = cands.filter((c) => (c.pointwise_avg ?? 0) >= 3.5);
    const finalists = (strong.length >= 3 ? strong : cands).slice(0, PAIRWISE_FINALISTS);
    for (const f of finalists) f.elo = 1000;
    if (finalists.length >= 2) {
      const matches: [number, number][] = [];
      for (let i = 0; i < finalists.length; i++) for (let j = 0; j < finalists.length; j++) if (i !== j) matches.push([i, j]);
      const results = await pool(shuffle(matches), 12, async ([a, b]) => {
        try {
          const out = await chatJson<{ winner?: string; reason?: string }>(env, [MODELS.judge], [{ role: "user", content: pairwisePrompt(brief, platform, scriptText(finalists[a]), scriptText(finalists[b])) }], {
            temperature: 0.1,
            max_tokens: 160,
            timeoutMs: 25_000,
            meter,
          });
          const w = String(out.winner ?? "").trim().toUpperCase();
          if (w !== "A" && w !== "B") return null;
          return { a, b, aWon: w === "A", reason: out.reason ? String(out.reason).slice(0, 200) : null };
        } catch {
          return null;
        }
      });
      for (const r of results) {
        if (!r) continue;
        const A = finalists[r.a];
        const B = finalists[r.b];
        const expA = 1 / (1 + 10 ** ((B.elo! - A.elo!) / 400));
        const sA = r.aWon ? 1 : 0;
        A.elo = A.elo! + 32 * (sA - expA);
        B.elo = B.elo! + 32 * (1 - sA - (1 - expA));
        const winner = r.aWon ? A : B;
        if (r.reason && winner.reasons.length < 3) winner.reasons.push(r.reason);
      }
      for (const f of finalists) f.elo = Math.round(f.elo!);
    }

    const finalSet = new Set(finalists);
    const ordered = [...finalists].sort((a, b) => b.elo! - a.elo! || (b.pointwise_avg ?? 0) - (a.pointwise_avg ?? 0)).concat(cands.filter((c) => !finalSet.has(c)));

    // ---- 6. Persist.
    const now = nowIso();
    const rows = ordered.map((c, i) => ({ ...c, hook_id: newId("hk"), rank: i + 1 }));
    const discarded = { rule_filter: ruleFiltered, near_dupes: nearDupes };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO rank_runs (id,research_id,brand,n,cost_cents,discarded_json,created_at) VALUES (?,?,?,?,?,?,?)`).bind(runId, researchId, brand?.name ?? null, rows.length, meter.cents, JSON.stringify(discarded), now),
      ...rows.flatMap((r) => [
        env.DB.prepare(`INSERT INTO hooks (id,run_id,pattern_id,hook,body,cta,footage_hints_json,want_talking_head,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
          r.hook_id,
          runId,
          r.pattern_id,
          r.hook,
          r.body,
          r.cta,
          JSON.stringify(r.footage_hints),
          r.want_talking_head ? 1 : 0,
          now,
        ),
        env.DB.prepare(`INSERT INTO hook_scores (hook_id,pointwise_avg,elo,reasons_json,rank) VALUES (?,?,?,?,?)`).bind(r.hook_id, r.pointwise_avg ?? null, r.elo ?? null, JSON.stringify(r.reasons), r.rank),
      ]),
    ]);

    await commit(env, reserveKey, meter.cents, { model: MODELS.judge, note: `rank run (${rows.length} hooks, ${meter.calls} LLM calls)` });

    return {
      run_id: runId,
      research_id: researchId,
      hooks: rows.slice(0, 5).map((r) => ({
        hook_id: r.hook_id,
        rank: r.rank,
        hook: r.hook,
        body: r.body,
        cta: r.cta,
        pattern_id: r.pattern_id,
        footage_hints: r.footage_hints,
        want_talking_head: r.want_talking_head,
        scores: { pointwise_avg: r.pointwise_avg ?? null, elo: r.elo ?? null },
        reasons: r.reasons.slice(0, 3),
      })),
      leaderboard: rows.slice(5).map((r) => ({ hook_id: r.hook_id, rank: r.rank, hook: r.hook, elo: r.elo ?? null })),
      discarded,
      judged: { pointwise: scored, pairwise_finalists: finalists.length },
      cost_usd: usd(meter.cents),
    };
  } catch (e) {
    if (meter.calls > 0) await commit(env, reserveKey, meter.cents, { model: MODELS.judge, note: "rank run (failed part-way)" });
    else await release(env, reserveKey, { note: "rank run failed before any LLM call" });
    throw e;
  }
}
