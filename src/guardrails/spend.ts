import { nowIso, ToolError, usd, type Env } from "../env";
import type { ReserveInput } from "./GuardrailsDO";

export function guard(env: Env) {
  return env.GUARDRAILS.get(env.GUARDRAILS.idFromName("global"));
}

async function audit(env: Env, kind: string, cents: number, r: { job_id?: string | null; model?: string | null; note?: string | null }) {
  try {
    await env.DB.prepare(`INSERT INTO spend_ledger (at,kind,cents,job_id,model,note) VALUES (?,?,?,?,?,?)`)
      .bind(nowIso(), kind, cents, r.job_id ?? null, r.model ?? null, r.note ?? null)
      .run();
  } catch (e) {
    console.warn("spend_ledger audit write failed", String(e));
  }
}

/** Reserve before a paid call. Throws a ToolError with an actionable message when the cap would be exceeded. */
export async function reserve(env: Env, input: ReserveInput) {
  const res = await guard(env).reserve(input);
  if (!res.ok) {
    throw new ToolError(
      `Would exceed spend cap: est $${usd(input.cents).toFixed(2)} > remaining $${usd(res.remaining_cents).toFixed(2)} ` +
        `(cap $${usd(res.cap_cents).toFixed(2)}). Use a shorter hook_duration_s or resolution=480P, or raise SPEND_CAP_USD on the server.`,
    );
  }
  if (!res.existing) await audit(env, "reserve", res.reservation.cents, input);
  return res;
}

export async function commit(env: Env, key: string, actualCents: number, meta: { job_id?: string; model?: string; note?: string } = {}) {
  const res = await guard(env).commit({ key, actual_cents: actualCents, note: meta.note });
  if (res.over_reserve) console.error(`spend commit exceeded reserve for ${key}: actual ${res.actual_cents}c`);
  if (res.ok) await audit(env, "commit", res.actual_cents, meta);
  return res;
}

export async function release(env: Env, key: string, meta: { job_id?: string; model?: string; note?: string } = {}) {
  const res = await guard(env).release({ key, note: meta.note });
  if (res.ok) await audit(env, "release", res.released_cents, meta);
  return res;
}
