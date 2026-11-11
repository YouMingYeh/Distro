import { env } from "./env";
import { getSealed, putSealed } from "./keys";

// Outside services that offer a remote MCP server behind OAuth. This Worker is their MCP client.
// Each workspace signs in with its own account there, so that account's limits and credits apply
// and nobody shares a login. Nothing a service returns is stored here: results pass straight
// through to the caller.

/** `kv` prefixes this service's KV records. `as` is the OAuth authorization server. */
export type Service = { id: string; label: string; as: string; mcp: string; scope: string; kv: string };

// DarkUGC's terms forbid scraping the site; its MCP server is the allowed path.
export const DARKUGC: Service = { id: "darkugc", label: "DarkUGC", as: "https://darkugc.com", mcp: "https://darkugc.com/mcp", scope: "search", kv: "dugc" };
// TokPortal creates and runs TikTok and Instagram accounts on real phones, and posts through them.
// Its sign-in mints a TokPortal API key as the access token: no refresh token, no expiry.
export const TOKPORTAL: Service = {
  id: "tokportal",
  label: "TokPortal",
  as: "https://app.tokportal.com",
  mcp: "https://app.tokportal.com/api/ext/mcp",
  scope: "mcp",
  kv: "tokp",
};
export const SERVICES = [DARKUGC, TOKPORTAL];

const TIMEOUT_MS = 60_000;
const redirectUri = (s: Service) => `${env.ORIGIN}/${s.id}/callback`;

/** No `expires_at` means the token does not expire. */
type Tokens = { access: string; refresh?: string; expires_at?: number };
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function json<T>(s: Service, res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${s.label} ${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Dynamic client registration, once per redirect URI. */
async function clientId(s: Service): Promise<string> {
  const key = `${s.kv}:client:${redirectUri(s)}`;
  const known = await env.OAUTH_KV.get(key);
  if (known) return known;
  const res = await fetch(`${s.as}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Distro",
      redirect_uris: [redirectUri(s)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id } = await json<{ client_id: string }>(s, res, "client registration");
  await env.OAUTH_KV.put(key, client_id);
  return client_id;
}

async function token(s: Service, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${s.as}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: await clientId(s), resource: s.mcp }),
  });
  return json<TokenResponse>(s, res, "sign-in");
}

async function save(s: Service, ws: string, t: TokenResponse, previous?: Tokens): Promise<Tokens> {
  const refresh = t.refresh_token ?? previous?.refresh;
  // A token that can be refreshed but states no lifetime is assumed to last an hour.
  const lifetime = t.expires_in ?? (refresh ? 3600 : undefined);
  const tokens: Tokens = { access: t.access_token, refresh, ...(lifetime ? { expires_at: Date.now() + lifetime * 1000 } : {}) };
  await putSealed(`${s.kv}:tok:${ws}`, tokens); // encrypted at rest
  return tokens;
}

/** The link the user opens to sign in to the service and allow this workspace (authorization code + PKCE). */
export async function remoteConnectUrl(s: Service, ws: string): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`${s.kv}:state:${state}`, JSON.stringify({ ws, verifier }), { expirationTtl: 600 });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: await clientId(s),
    redirect_uri: redirectUri(s),
    code_challenge: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    code_challenge_method: "S256",
    scope: s.scope,
    state,
    resource: s.mcp,
  });
  return `${s.as}/oauth/authorize?${query}`;
}

/** The service redirects the browser here. Throws with a user-readable reason if the sign-in did not complete. */
export async function remoteCallback(s: Service, url: URL): Promise<void> {
  const p = url.searchParams;
  const key = `${s.kv}:state:${p.get("state")}`;
  const pending = await env.OAUTH_KV.get<{ ws: string; verifier: string }>(key, "json");
  if (!pending) throw new Error("This sign-in link expired. Ask your agent for a new one.");
  await env.OAUTH_KV.delete(key); // single use
  if (p.get("iss") && p.get("iss") !== s.as) throw new Error("Unexpected issuer.");
  const code = p.get("code");
  if (!code) throw new Error(p.get("error_description") ?? p.get("error") ?? `${s.label} did not return a code.`);
  await save(s, pending.ws, await token(s, { grant_type: "authorization_code", code, redirect_uri: redirectUri(s), code_verifier: pending.verifier }));
}

/** Whether this workspace has signed in to the service. Does not check that the sign-in still works. */
export const remoteConnected = async (s: Service, ws: string) => !!(await getSealed(`${s.kv}:tok:${ws}`));

const notConnected = (s: Service) => `${s.label} is not connected. Call connect_${s.id} and give the user the link.`;

async function accessToken(s: Service, ws: string): Promise<string> {
  const t = await getSealed<Tokens>(`${s.kv}:tok:${ws}`);
  if (!t) throw new Error(notConnected(s));
  if (!t.expires_at || t.expires_at - 60_000 > Date.now()) return t.access;
  if (!t.refresh) throw new Error(notConnected(s));
  // ponytail: no lock. Two calls refreshing at once can burn a rotating refresh token, and the
  // user reconnects. Move the refresh into a Durable Object if that shows up.
  return (await save(s, ws, await token(s, { grant_type: "refresh_token", refresh_token: t.refresh }), t)).access;
}

type Rpc = { result?: any; error?: { message?: string }; id?: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One JSON-RPC message over MCP Streamable HTTP. The reply is plain JSON or a one-message SSE stream. */
async function rpc(s: Service, access: string, extra: Record<string, string>, method: string, params: unknown, id?: number) {
  const res = await fetch(s.mcp, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error(notConnected(s));
  if (!res.ok) throw new Error(`${s.label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  if (!msg) throw new Error(`${s.label} sent no reply.`);
  if (msg.error) throw new Error(`${s.label}: ${msg.error.message ?? "request failed"}`);
  return { result: msg.result, session: res.headers.get("mcp-session-id") };
}

// ponytail: a fresh MCP session per call (three round-trips). Cache the session id in KV if latency matters.
async function call(s: Service, ws: string, method: string, params: unknown) {
  const access = await accessToken(s, ws);
  const init = await rpc(s, access, {}, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "distro", version: "0.1.0" } }, 1);
  const headers: Record<string, string> = { "MCP-Protocol-Version": init.result?.protocolVersion ?? "2025-06-18" };
  if (init.session) headers["Mcp-Session-Id"] = init.session;
  await rpc(s, access, headers, "notifications/initialized", undefined);
  return (await rpc(s, access, headers, method, params, 2)).result;
}

export type RemoteTool = { name: string; description?: string; input?: unknown; annotations?: Record<string, unknown> };

// ponytail: one tools/list page. Follow nextCursor if a service ever pages its list.
export async function remoteTools(s: Service, ws: string): Promise<{ tools: RemoteTool[] }> {
  const { tools } = await call(s, ws, "tools/list", {});
  return {
    tools: (tools ?? []).map((t: Record<string, unknown>) => ({ name: t.name, description: t.description, input: t.inputSchema, annotations: t.annotations })),
  };
}

export async function remoteCall(s: Service, ws: string, name: string, args: Record<string, unknown>) {
  const r = await call(s, ws, "tools/call", { name, arguments: args });
  const text = (r?.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  if (r?.isError) throw new Error(`${s.label}: ${text || "tool failed"}`);
  if (r?.structuredContent) return r.structuredContent;
  try {
    return JSON.parse(text); // these services answer with JSON inside a text block
  } catch {
    return { text };
  }
}
