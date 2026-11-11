import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

type Entry = { at: string; kind: "seed" | "reserve" | "commit" | "release"; job_id: string; usd: number; note: string };
type State = { committed: number; reserved: Record<string, number>; entries: Entry[] };

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Global spend ledger: one instance (idFromName("global")). A Durable Object runs one
 * request at a time, so reserve/settle need no extra locking. Reserve before every GMI
 * submit; commit on success, release on failure (GMI refunds failed jobs).
 */
export class LedgerDO extends DurableObject<Env> {
  private async state(): Promise<State> {
    let s = await this.ctx.storage.get<State>("state");
    if (!s) {
      const seed = Number(this.env.INITIAL_COMMITTED_USD ?? "0") || 0;
      s = { committed: seed, reserved: {}, entries: [] };
      if (seed) s.entries.push({ at: new Date().toISOString(), kind: "seed", job_id: "", usd: seed, note: "carried over" });
      await this.ctx.storage.put("state", s);
    }
    return s;
  }

  private cap(): number {
    return Number(this.env.SPEND_CAP_USD ?? "9");
  }

  async summary() {
    const s = await this.state();
    const reserved = r4(Object.values(s.reserved).reduce((a, b) => a + b, 0));
    return {
      cap_usd: this.cap(),
      committed_usd: r4(s.committed),
      reserved_usd: reserved,
      remaining_usd: r4(this.cap() - s.committed - reserved),
      entries: s.entries.slice(-50),
    };
  }

  async reserve(jobId: string, usd: number, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = await this.state();
    const reserved = Object.values(s.reserved).reduce((a, b) => a + b, 0);
    if (s.committed + reserved + usd > this.cap() + 1e-9) {
      return {
        ok: false,
        error: `spend cap: $${usd.toFixed(2)} would exceed cap $${this.cap().toFixed(2)} (committed $${s.committed.toFixed(2)}, reserved $${reserved.toFixed(2)})`,
      };
    }
    s.reserved[jobId] = usd;
    s.entries.push({ at: new Date().toISOString(), kind: "reserve", job_id: jobId, usd: r4(usd), note });
    await this.ctx.storage.put("state", s);
    return { ok: true };
  }

  async settle(jobId: string, commit: boolean, note = ""): Promise<void> {
    const s = await this.state();
    if (!(jobId in s.reserved)) return;
    const usd = s.reserved[jobId];
    delete s.reserved[jobId];
    if (commit) s.committed += usd;
    s.entries.push({ at: new Date().toISOString(), kind: commit ? "commit" : "release", job_id: jobId, usd: r4(usd), note });
    if (s.entries.length > 500) s.entries = s.entries.slice(-500);
    await this.ctx.storage.put("state", s);
  }
}
