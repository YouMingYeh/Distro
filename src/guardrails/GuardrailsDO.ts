import { DurableObject } from "cloudflare:workers";
import { config, type Env } from "../env";

export type ReserveInput = {
  cents: number;
  key: string;
  job_id?: string;
  model?: string;
  note?: string;
};

export type Reservation = {
  key: string;
  cents: number;
  status: "reserved" | "committed" | "released";
  actual_cents: number | null;
  job_id: string | null;
  model: string | null;
  note: string | null;
};

export type ReserveResult =
  | { ok: true; existing: boolean; reservation: Reservation; remaining_cents: number }
  | { ok: false; error: "cap_exceeded"; remaining_cents: number; cap_cents: number };

export type LedgerEntry = {
  at: string;
  kind: "reserve" | "commit" | "release";
  cents: number;
  job_id: string | null;
  model: string | null;
  note: string | null;
};

export type GuardState = {
  cap_cents: number;
  spent_cents: number;
  reserved_cents: number;
  remaining_cents: number;
  max_render_cents: number;
  darkugc_today: number;
  darkugc_daily_cap: number;
  day: string;
};

/**
 * Single named instance ("global") that owns the spend cap and the DarkUGC
 * daily call counter. It is the source of truth; D1 `spend_ledger` and
 * `darkugc_calls` are audit copies. Durable Object calls are serialized and
 * the SQLite writes below are synchronous, so two parallel reserves can never
 * overshoot the cap.
 *
 * Rebuild after a reset: replay D1 `spend_ledger` in id order (reserve adds a
 * reservation, commit/release settle it) and count today's `darkugc_calls`.
 */
export class GuardrailsDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        key TEXT PRIMARY KEY,
        cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        actual_cents INTEGER,
        job_id TEXT,
        model TEXT,
        note TEXT,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        cents INTEGER NOT NULL,
        job_id TEXT,
        model TEXT,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS darkugc_days (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS darkugc_minutes (minute TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `);
  }

  private totals() {
    const row = this.sql
      .exec(
        `SELECT
           COALESCE(SUM(CASE WHEN status='committed' THEN actual_cents ELSE 0 END),0) AS spent,
           COALESCE(SUM(CASE WHEN status='reserved' THEN cents ELSE 0 END),0) AS reserved
         FROM reservations`,
      )
      .one() as { spent: number; reserved: number };
    return { spent: Number(row.spent), reserved: Number(row.reserved) };
  }

  private get(key: string): Reservation | null {
    const rows = this.sql
      .exec(`SELECT key,cents,status,actual_cents,job_id,model,note FROM reservations WHERE key=?`, key)
      .toArray() as unknown as Reservation[];
    return rows[0] ?? null;
  }

  private log(kind: LedgerEntry["kind"], cents: number, r: { job_id?: string | null; model?: string | null; note?: string | null }) {
    this.sql.exec(
      `INSERT INTO ledger (at,kind,cents,job_id,model,note) VALUES (?,?,?,?,?,?)`,
      new Date().toISOString(),
      kind,
      cents,
      r.job_id ?? null,
      r.model ?? null,
      r.note ?? null,
    );
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const cap = config(this.env).capCents;
    const cents = Math.max(0, Math.ceil(input.cents));
    const existing = this.get(input.key);
    const { spent, reserved } = this.totals();
    if (existing && existing.status !== "released") {
      return { ok: true, existing: true, reservation: existing, remaining_cents: cap - spent - reserved };
    }
    if (spent + reserved + cents > cap) {
      return { ok: false, error: "cap_exceeded", remaining_cents: Math.max(0, cap - spent - reserved), cap_cents: cap };
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO reservations (key,cents,status,actual_cents,job_id,model,note,at)
       VALUES (?,?,'reserved',NULL,?,?,?,?)`,
      input.key,
      cents,
      input.job_id ?? null,
      input.model ?? null,
      input.note ?? null,
      new Date().toISOString(),
    );
    this.log("reserve", cents, input);
    return { ok: true, existing: false, reservation: this.get(input.key)!, remaining_cents: cap - spent - reserved - cents };
  }

  /** Move a reservation to spent. Returns the cents actually recorded. */
  async commit(input: { key: string; actual_cents: number; note?: string }): Promise<{ ok: boolean; actual_cents: number; over_reserve: boolean }> {
    const r = this.get(input.key);
    if (!r) return { ok: false, actual_cents: 0, over_reserve: false };
    if (r.status === "committed") return { ok: true, actual_cents: r.actual_cents ?? 0, over_reserve: false };
    const actual = Math.max(0, Math.ceil(input.actual_cents));
    // If actual > reserved we still record the truth (money was already spent
    // upstream) and flag it so the caller can log loudly.
    const over = r.status === "reserved" && actual > r.cents;
    this.sql.exec(`UPDATE reservations SET status='committed', actual_cents=? WHERE key=?`, actual, input.key);
    this.log("commit", actual, { job_id: r.job_id, model: r.model, note: input.note ?? r.note });
    return { ok: true, actual_cents: actual, over_reserve: over };
  }

  async release(input: { key: string; note?: string }): Promise<{ ok: boolean; released_cents: number }> {
    const r = this.get(input.key);
    if (!r || r.status !== "reserved") return { ok: false, released_cents: 0 };
    this.sql.exec(`UPDATE reservations SET status='released' WHERE key=?`, input.key);
    this.log("release", r.cents, { job_id: r.job_id, model: r.model, note: input.note ?? r.note });
    return { ok: true, released_cents: r.cents };
  }

  async consumeDarkUgc(input: { n: number; day: string }): Promise<{ ok: boolean; today: number; cap: number; reason?: string }> {
    const cfg = config(this.env);
    const n = Math.max(1, Math.floor(input.n));
    const today = Number(
      (this.sql.exec(`SELECT COALESCE((SELECT n FROM darkugc_days WHERE day=?),0) AS n`, input.day).one() as { n: number }).n,
    );
    if (today + n > cfg.darkUgcDailyCap) return { ok: false, today, cap: cfg.darkUgcDailyCap, reason: "daily_cap" };
    const minute = new Date().toISOString().slice(0, 16);
    const perMin = Number(
      (this.sql.exec(`SELECT COALESCE((SELECT n FROM darkugc_minutes WHERE minute=?),0) AS n`, minute).one() as { n: number }).n,
    );
    if (perMin + n > 10) return { ok: false, today, cap: cfg.darkUgcDailyCap, reason: "per_minute_cap" };
    this.sql.exec(`INSERT INTO darkugc_days (day,n) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n`, input.day, n);
    this.sql.exec(`INSERT INTO darkugc_minutes (minute,n) VALUES (?,?) ON CONFLICT(minute) DO UPDATE SET n=n+excluded.n`, minute, n);
    this.sql.exec(`DELETE FROM darkugc_minutes WHERE minute < ?`, new Date(Date.now() - 3600_000).toISOString().slice(0, 16));
    return { ok: true, today: today + n, cap: cfg.darkUgcDailyCap };
  }

  /** Give back a consumed call when the upstream request never happened. */
  async refundDarkUgc(input: { n: number; day: string }): Promise<void> {
    this.sql.exec(`UPDATE darkugc_days SET n=MAX(0,n-?) WHERE day=?`, Math.max(1, Math.floor(input.n)), input.day);
  }

  async getState(day: string): Promise<GuardState> {
    const cfg = config(this.env);
    const { spent, reserved } = this.totals();
    const today = Number(
      (this.sql.exec(`SELECT COALESCE((SELECT n FROM darkugc_days WHERE day=?),0) AS n`, day).one() as { n: number }).n,
    );
    return {
      cap_cents: cfg.capCents,
      spent_cents: spent,
      reserved_cents: reserved,
      remaining_cents: Math.max(0, cfg.capCents - spent - reserved),
      max_render_cents: cfg.maxRenderCents,
      darkugc_today: today,
      darkugc_daily_cap: cfg.darkUgcDailyCap,
      day,
    };
  }

  async entries(input: { since: string; limit?: number }): Promise<LedgerEntry[]> {
    return this.sql
      .exec(
        `SELECT at,kind,cents,job_id,model,note FROM ledger WHERE at >= ? ORDER BY id DESC LIMIT ?`,
        input.since,
        Math.min(200, input.limit ?? 50),
      )
      .toArray() as unknown as LedgerEntry[];
  }

  /** Count of reservations currently held for a model (used to cap concurrent renders). */
  async activeCount(model: string): Promise<number> {
    return Number(
      (this.sql.exec(`SELECT COUNT(*) AS n FROM reservations WHERE status='reserved' AND model=?`, model).one() as { n: number }).n,
    );
  }
}
