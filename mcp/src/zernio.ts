import { env, type Platform } from "./env";

const API = "https://zernio.com/api/v1";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!env.ZERNIO_API_KEY) throw new Error("Social accounts are not configured on this server (ZERNIO_API_KEY is unset).");
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.ZERNIO_API_KEY}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Zernio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** One Zernio profile per workspace, created on first use. */
async function profileId(workspaceId: string): Promise<string> {
  const key = `ws:${workspaceId}`;
  const known = await env.OAUTH_KV.get(key);
  if (known) return known;
  const { profile } = await call<{ profile: { _id: string } }>("/profiles", {
    method: "POST",
    body: JSON.stringify({ name: `distro-${workspaceId.slice(0, 8)}`, externalId: workspaceId }),
  });
  await env.OAUTH_KV.put(key, profile._id);
  return profile._id;
}

export async function connectUrl(workspaceId: string, platform: Platform, origin: string): Promise<string> {
  const query = new URLSearchParams({
    profileId: await profileId(workspaceId),
    redirect_url: `${origin}/connect/callback?platform=${platform}`,
  });
  const { authUrl } = await call<{ authUrl: string }>(`/connect/${platform}?${query}`);
  return authUrl;
}

type Account = { _id: string; platform: string; username?: string; isActive?: boolean };

export async function listAccounts(workspaceId: string) {
  const { accounts } = await call<{ accounts: Account[] }>(`/accounts?profileId=${await profileId(workspaceId)}`);
  return accounts.map((a) => ({ account_id: a._id, platform: a.platform, username: a.username, active: a.isActive }));
}

export async function createPost(payload: unknown) {
  return call<{ post?: { _id?: string; status?: string } }>("/posts", { method: "POST", body: JSON.stringify(payload) });
}
