import { safeJson, type Env } from "../env";

export type AssetRow = {
  id: string;
  r2_key: string;
  kind: string;
  original_filename: string | null;
  source: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  has_audio: number;
  banned: number;
  ban_reason: string | null;
  warnings_json: string | null;
  notes: string | null;
  created_at: string;
};

export type HookRow = {
  id: string;
  run_id: string | null;
  pattern_id: string | null;
  hook: string;
  body: string | null;
  cta: string | null;
  footage_hints_json: string | null;
  want_talking_head: number;
  created_at: string;
};

export type JobRow = {
  id: string;
  hook_id: string | null;
  status: string;
  step: string | null;
  params_json: string | null;
  estimated_cents: number | null;
  reserved_cents: number | null;
  actual_cents: number | null;
  gmi_request_id: string | null;
  final_r2_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export function isVideoKey(key: string): boolean {
  return /\.(mp4|mov|webm|m4v)$/i.test(key);
}

export async function listAssets(env: Env, opts: { includeBanned?: boolean; limit?: number } = {}): Promise<AssetRow[]> {
  const where = opts.includeBanned ? "" : "WHERE banned=0";
  const res = await env.DB.prepare(`SELECT * FROM assets ${where} ORDER BY created_at DESC LIMIT ?`)
    .bind(opts.limit ?? 40)
    .all<AssetRow>();
  return res.results ?? [];
}

/** Resolve asset ids or r2 keys to rows. */
export async function resolveAssets(env: Env, refs: string[]): Promise<AssetRow[]> {
  const out: AssetRow[] = [];
  for (const ref of refs.slice(0, 20)) {
    const row = await env.DB.prepare(`SELECT * FROM assets WHERE id=? OR r2_key=? LIMIT 1`).bind(ref, ref).first<AssetRow>();
    if (row) out.push(row);
  }
  return out;
}

/** Compact, prompt-friendly list of usable footage. */
export function assetsBlock(assets: AssetRow[]): string {
  return assets
    .filter((a) => a.banned === 0 && a.kind !== "final" && a.kind !== "thumb")
    .slice(0, 20)
    .map((a) => {
      const dims = a.width && a.height ? `${a.width}x${a.height}` : "unknown size";
      const dur = a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)}s` : "";
      const type = isVideoKey(a.r2_key) ? "video" : "image";
      const note = a.notes ? ` — ${a.notes.slice(0, 120)}` : "";
      return `- ${a.id}: ${type} "${a.original_filename ?? a.r2_key.split("/").pop()}" ${dims} ${dur}${note}`;
    })
    .join("\n");
}

export async function getHook(env: Env, hookId: string): Promise<(HookRow & { footage_hints: string[] }) | null> {
  const row = await env.DB.prepare(`SELECT * FROM hooks WHERE id=?`).bind(hookId).first<HookRow>();
  if (!row) return null;
  return { ...row, footage_hints: safeJson<string[]>(row.footage_hints_json, []) };
}

export async function getJob(env: Env, jobId: string): Promise<JobRow | null> {
  return env.DB.prepare(`SELECT * FROM jobs WHERE id=?`).bind(jobId).first<JobRow>();
}

export async function updateJob(env: Env, jobId: string, patch: Partial<Omit<JobRow, "id" | "created_at">>): Promise<void> {
  const entries = Object.entries({ ...patch, updated_at: new Date().toISOString() });
  const sets = entries.map(([k]) => `${k}=?`).join(", ");
  await env.DB.prepare(`UPDATE jobs SET ${sets} WHERE id=?`)
    .bind(...entries.map(([, v]) => v ?? null), jobId)
    .run();
}

/** Merge keys into jobs.params_json (pipeline state the next step and get_job need). */
export async function mergeJobParams(env: Env, jobId: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  const job = await getJob(env, jobId);
  const merged = { ...safeJson<Record<string, unknown>>(job?.params_json, {}), ...extra };
  await updateJob(env, jobId, { params_json: JSON.stringify(merged) });
  return merged;
}
