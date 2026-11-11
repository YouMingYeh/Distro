import { nowIso, utcDay, type Env } from "../env";
import { guard } from "../guardrails/spend";

/**
 * Minimal MCP client (Streamable HTTP, JSON-RPC) for https://darkugc.com/mcp.
 * The Worker holds the host's DarkUGC token so the user's agent never does.
 * Every tool call is counted against the Durable Object daily cap first.
 * Results are held in memory only long enough to distill patterns; they are
 * never written to D1, R2, or logs.
 */

const PROTOCOL_VERSION = "2025-06-18";

export class DarkUgcUnavailable extends Error {}

type RpcResponse = { result?: any; error?: { code: number; message: string } };

async function kvGet(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT value FROM kv WHERE key=?`).bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

async function kvSet(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO kv (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(key, value, nowIso())
    .run();
}

function parseSse(text: string): any {
  let last: any = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg && (msg.result !== undefined || msg.error !== undefined)) last = msg;
    } catch {
      /* ignore keep-alives */
    }
  }
  return last;
}

export class DarkUgcClient {
  private token: string | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;
  callsUsed = 0;

  constructor(
    private env: Env,
    private maxCalls: number,
  ) {}

  get url(): string {
    return this.env.DARKUGC_MCP_URL || "https://darkugc.com/mcp";
  }

  static configured(env: Env): boolean {
    return Boolean(env.DARKUGC_ACCESS_TOKEN || env.DARKUGC_REFRESH_TOKEN);
  }

  private async loadToken(): Promise<string> {
    if (this.token) return this.token;
    // A refreshed token (stored in D1) wins over the original secret.
    const stored = await kvGet(this.env, "darkugc_access_token").catch(() => null);
    this.token = stored || this.env.DARKUGC_ACCESS_TOKEN || null;
    if (!this.token) {
      if (await this.refresh()) return this.token!;
      throw new DarkUgcUnavailable("DarkUGC is not connected on this server (no access token).");
    }
    return this.token;
  }

  private async refresh(): Promise<boolean> {
    const refreshToken = (await kvGet(this.env, "darkugc_refresh_token").catch(() => null)) || this.env.DARKUGC_REFRESH_TOKEN;
    const endpoint = this.env.DARKUGC_TOKEN_ENDPOINT;
    const clientId = this.env.DARKUGC_CLIENT_ID;
    if (!refreshToken || !endpoint || !clientId) return false;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: this.url }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { access_token?: string; refresh_token?: string };
      if (!data.access_token) return false;
      this.token = data.access_token;
      await kvSet(this.env, "darkugc_access_token", data.access_token);
      if (data.refresh_token) await kvSet(this.env, "darkugc_refresh_token", data.refresh_token);
      return true;
    } catch {
      return false;
    }
  }

  private async rpc(method: string, params: unknown, notification = false, retried = false): Promise<RpcResponse> {
    const token = await this.loadToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    if (!notification) body.id = this.nextId++;

    let res: Response;
    try {
      res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
    } catch (e) {
      throw new DarkUgcUnavailable(`DarkUGC request failed (${String(e).slice(0, 80)}).`);
    }
    if (res.status === 401 && !retried) {
      this.token = null;
      if (await this.refresh()) return this.rpc(method, params, notification, true);
      throw new DarkUgcUnavailable("DarkUGC sign-in expired. Re-run scripts/darkugc-oauth.ts on the server.");
    }
    if (res.status === 429) throw new DarkUgcUnavailable("DarkUGC rate limit reached.");
    const sid = res.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;
    if (notification) {
      await res.body?.cancel().catch(() => {});
      return {};
    }
    if (!res.ok) throw new DarkUgcUnavailable(`DarkUGC returned HTTP ${res.status}.`);
    const text = await res.text();
    const type = res.headers.get("Content-Type") ?? "";
    const msg = type.includes("text/event-stream") ? parseSse(text) : JSON.parse(text);
    if (!msg) throw new DarkUgcUnavailable("DarkUGC returned an empty response.");
    return msg as RpcResponse;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    const res = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "distro", version: "0.1.0" },
    });
    if (res.error) throw new DarkUgcUnavailable(`DarkUGC initialize failed: ${res.error.message}`);
    await this.rpc("notifications/initialized", {}, true).catch(() => {});
    this.initialized = true;
  }

  get budgetLeft(): number {
    return this.maxCalls - this.callsUsed;
  }

  /**
   * Call one DarkUGC tool. Returns parsed data, or null when the budget or a
   * cap is exhausted (callers treat null as "skip this step").
   */
  async call(tool: string, args: Record<string, unknown>): Promise<any | null> {
    if (tool === "get_video") throw new Error("get_video is disabled in v1 (returns verbatim transcripts).");
    if (this.callsUsed >= this.maxCalls) return null;
    await this.init();

    const day = utcDay();
    const g = guard(this.env);
    const slot = await g.consumeDarkUgc({ n: 1, day });
    if (!slot.ok) return null;
    this.callsUsed += 1;

    let ok = 0;
    try {
      const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
      const res = await this.rpc("tools/call", { name: tool, arguments: clean });
      if (res.error) throw new Error(res.error.message);
      const result = res.result ?? {};
      if (result.isError) throw new Error(String(result.content?.[0]?.text ?? "tool error").slice(0, 200));
      ok = 1;
      if (result.structuredContent !== undefined) return result.structuredContent;
      const text = (result.content ?? [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (e) {
      if (e instanceof DarkUgcUnavailable) {
        // The upstream call never completed; give the slot back.
        this.callsUsed -= 1;
        await g.refundDarkUgc({ n: 1, day }).catch(() => {});
        throw e;
      }
      console.warn(`darkugc ${tool} failed: ${String(e).slice(0, 120)}`);
      return null;
    } finally {
      await this.env.DB.prepare(`INSERT INTO darkugc_calls (at,tool,ok,day) VALUES (?,?,?,?)`)
        .bind(nowIso(), tool, ok, day)
        .run()
        .catch(() => {});
    }
  }
}
