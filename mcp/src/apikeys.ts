import { env, SCOPES, type Props } from "./env";

// API keys: a long-lived bearer credential for places a browser sign-in cannot reach (CI, servers,
// `DISTRO_API_KEY`). A key carries a workspace and a set of scopes, exactly like an OAuth token,
// and is accepted on /mcp and /api/ through the provider's resolveExternalToken hook.
// Only the SHA-256 of a key is stored; the key itself is shown once, at creation.
// Keys are made from a signed-in session only: a key cannot create, list or revoke keys.

type Stored = { id: string; name: string; hash: string; last4: string; scopes: string[]; created: string };

const PREFIX = "dk_";
const MAX_KEYS = 20;
const index = (ws: string) => `apikeys:${ws}`;
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (v: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
const pub = ({ id, name, last4, scopes, created }: Stored) => ({ id, name, ends_with: last4, scopes, created });

// ponytail: the list is one KV value, read then written; two changes in the same second can lose
// one. Fine for a list a person edits by hand. Move to D1 if keys are ever minted by automation.
const read = async (ws: string) => (await env.OAUTH_KV.get<Stored[]>(index(ws), "json")) ?? [];

export async function createApiKey(ws: string, rawName: unknown, scopes: string[]) {
  const name = String(rawName ?? "").trim().slice(0, 60) || "API key";
  const list = await read(ws);
  if (list.length >= MAX_KEYS) throw new Error(`API key limit reached (${MAX_KEYS}). Revoke one first.`);
  const key = PREFIX + hex(crypto.getRandomValues(new Uint8Array(32)));
  const stored: Stored = {
    id: `key_${hex(crypto.getRandomValues(new Uint8Array(6)))}`,
    name,
    hash: await sha256(key),
    last4: key.slice(-4),
    scopes: scopes.filter((s) => s in SCOPES),
    created: new Date().toISOString(),
  };
  await env.OAUTH_KV.put(`apikey:${stored.hash}`, JSON.stringify({ ws, id: stored.id, scopes: stored.scopes }));
  await env.OAUTH_KV.put(index(ws), JSON.stringify([...list, stored]));
  return { ...pub(stored), key };
}

export const listApiKeys = async (ws: string) => (await read(ws)).map(pub);

// ponytail: KV is eventually consistent, so a revoked key can keep working for up to a minute at
// other edge locations. Check a Durable Object instead if revocation must be instant.
export async function revokeApiKey(ws: string, id: string) {
  const list = await read(ws);
  const found = list.find((k) => k.id === id);
  if (!found) throw new Error(`No API key "${id}".`);
  await env.OAUTH_KV.delete(`apikey:${found.hash}`);
  await env.OAUTH_KV.put(index(ws), JSON.stringify(list.filter((k) => k !== found)));
  return { revoked: id };
}

/** The props a presented key stands for, or null when it is not one of ours. */
export async function resolveApiKey(token: string): Promise<Props | null> {
  if (!/^dk_[0-9a-f]{64}$/.test(token)) return null;
  const found = await env.OAUTH_KV.get<{ ws: string; id: string; scopes: string[] }>(`apikey:${await sha256(token)}`, "json");
  return found ? { workspaceId: found.ws, scopes: found.scopes, apiKey: found.id } : null;
}

/** REST: GET /api/me, and GET, POST, DELETE on /api/api-keys. Null for any other path. */
export async function accountRoute(req: Request, props: Props | undefined): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/me" && url.pathname !== "/api/api-keys") return null;
  if (!props?.workspaceId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (url.pathname === "/api/me") return Response.json({ scopes: props.scopes, auth: props.apiKey ? "api_key" : "oauth" });
  if (props.apiKey) {
    return Response.json({ error: "forbidden", message: "API keys are managed from a signed-in session. Run: distro login" }, { status: 403 });
  }
  try {
    if (req.method === "GET") return Response.json({ keys: await listApiKeys(props.workspaceId) });
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      return Response.json(await createApiKey(props.workspaceId, body.name, props.scopes));
    }
    if (req.method === "DELETE") return Response.json(await revokeApiKey(props.workspaceId, url.searchParams.get("id") ?? ""));
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "GET, POST, DELETE" } });
  } catch (e) {
    return Response.json({ error: "failed", message: (e as Error).message }, { status: 422 });
  }
}
