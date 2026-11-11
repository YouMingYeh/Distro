import { env } from "./env";
import { getSealed, putSealed } from "./keys";

// DarkUGC's official agent door: a remote MCP server behind OAuth (https://darkugc.com/mcp).
// Each workspace signs in with its own DarkUGC account, so that account's daily limits apply
// and nobody shares a login. Their terms forbid scraping the site; this is the allowed path.
// Nothing DarkUGC returns is stored here: results pass straight through to the caller.

const AS = "https://darkugc.com";
const MCP = `${AS}/mcp`;
const TIMEOUT_MS = 60_000;
const redirectUri = () => `${env.ORIGIN}/darkugc/callback`;

type Tokens = { access: string; refresh?: string; expires_at: number };
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`DarkUGC ${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Dynamic client registration, once per redirect URI. */
async function clientId(): Promise<string> {
  const key = `dugc:client:${redirectUri()}`;
  const known = await env.OAUTH_KV.get(key);
  if (known) return known;
  const res = await fetch(`${AS}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Distro",
      redirect_uris: [redirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id } = await json<{ client_id: string }>(res, "client registration");
  await env.OAUTH_KV.put(key, client_id);
  return client_id;
}

async function token(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AS}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: await clientId(), resource: MCP }),
  });
  return json<TokenResponse>(res, "sign-in");
}

async function save(ws: string, t: TokenResponse, previous?: Tokens): Promise<Tokens> {
  const tokens: Tokens = {
    access: t.access_token,
    refresh: t.refresh_token ?? previous?.refresh,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
  await putSealed(`dugc:tok:${ws}`, tokens); // encrypted at rest
  return tokens;
}

/** The link the user opens to sign in to DarkUGC and allow this workspace (authorization code + PKCE). */
export async function darkugcConnectUrl(ws: string): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`dugc:state:${state}`, JSON.stringify({ ws, verifier }), { expirationTtl: 600 });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: await clientId(),
    redirect_uri: redirectUri(),
    code_challenge: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    code_challenge_method: "S256",
    scope: "search",
    state,
    resource: MCP,
  });
  return `${AS}/oauth/authorize?${query}`;
}

/** DarkUGC redirects the browser here. Throws with a user-readable reason if the sign-in did not complete. */
export async function darkugcCallback(url: URL): Promise<void> {
  const p = url.searchParams;
  const key = `dugc:state:${p.get("state")}`;
  const pending = await env.OAUTH_KV.get<{ ws: string; verifier: string }>(key, "json");
  if (!pending) throw new Error("This sign-in link expired. Ask your agent for a new one.");
  await env.OAUTH_KV.delete(key); // single use
  if (p.get("iss") && p.get("iss") !== AS) throw new Error("Unexpected issuer.");
  const code = p.get("code");
  if (!code) throw new Error(p.get("error_description") ?? p.get("error") ?? "DarkUGC did not return a code.");
  await save(pending.ws, await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: pending.verifier }));
}

/** Whether this workspace has signed in to DarkUGC. Does not check that the sign-in still works. */
export const darkugcConnected = async (ws: string) => !!(await getSealed(`dugc:tok:${ws}`));

const NOT_CONNECTED = "DarkUGC is not connected. Call connect_darkugc and give the user the link.";

async function accessToken(ws: string): Promise<string> {
  const t = await getSealed<Tokens>(`dugc:tok:${ws}`);
  if (!t) throw new Error(NOT_CONNECTED);
  if (t.expires_at - 60_000 > Date.now()) return t.access;
  if (!t.refresh) throw new Error(NOT_CONNECTED);
  // ponytail: no lock. Two calls refreshing at once can burn a rotating refresh token, and the
  // user reconnects. Move the refresh into a Durable Object if that shows up.
  return (await save(ws, await token({ grant_type: "refresh_token", refresh_token: t.refresh }), t)).access;
}

type Rpc = { result?: any; error?: { message?: string }; id?: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One JSON-RPC message over MCP Streamable HTTP. The reply is plain JSON or a one-message SSE stream. */
async function rpc(access: string, extra: Record<string, string>, method: string, params: unknown, id?: number) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error(NOT_CONNECTED);
  if (!res.ok) throw new Error(`DarkUGC ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (id === undefined) return { result: undefined, session: null }; // notification: no reply body
  let msg: Rpc | undefined;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    // Read until our reply arrives, then hang up: the server may hold the stream open after it.
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (let buf = ""; !msg; ) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (buf + value).split(/\r?\n/);
      buf = lines.pop()!; // keep the unfinished line
      msg = lines.filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)) as Rpc).find((m) => m.id === id);
    }
    void reader.cancel().catch(() => {});
  } else {
    msg = await res.json();
  }
  if (!msg) throw new Error("DarkUGC sent no reply.");
  if (msg.error) throw new Error(`DarkUGC: ${msg.error.message ?? "request failed"}`);
  return { result: msg.result, session: res.headers.get("mcp-session-id") };
}

// ponytail: a fresh MCP session per call (three round-trips). Cache the session id in KV if latency matters.
async function call(ws: string, method: string, params: unknown) {
  const access = await accessToken(ws);
  const init = await rpc(access, {}, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "distro", version: "0.1.0" } }, 1);
  const headers: Record<string, string> = { "MCP-Protocol-Version": init.result?.protocolVersion ?? "2025-06-18" };
  if (init.session) headers["Mcp-Session-Id"] = init.session;
  await rpc(access, headers, "notifications/initialized", undefined);
  return (await rpc(access, headers, method, params, 2)).result;
}

export async function darkugcTools(ws: string) {
  const { tools } = await call(ws, "tools/list", {});
  return { tools: (tools ?? []).map((t: Record<string, unknown>) => ({ name: t.name, description: t.description, input: t.inputSchema })) };
}

export async function darkugcCall(ws: string, name: string, args: Record<string, unknown>) {
  const r = await call(ws, "tools/call", { name, arguments: args });
  const text = (r?.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  if (r?.isError) throw new Error(`DarkUGC: ${text || "tool failed"}`);
  if (r?.structuredContent) return r.structuredContent;
  try {
    return JSON.parse(text); // DarkUGC answers with JSON inside a text block
  } catch {
    return { text };
  }
}
