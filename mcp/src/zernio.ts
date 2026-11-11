import { env, type Platform } from "./env";

const API = "https://zernio.com/api/v1";

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!env.ZERNIO_API_KEY) throw new Error("Social accounts are not configured on this server (ZERNIO_API_KEY is unset).");
  const res = await fetch(API + path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${env.ZERNIO_API_KEY}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Zernio ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Creates the Zernio profile that backs one Distro profile. `externalId` is the Distro profile id. */
export async function createZernioProfile(externalId: string): Promise<string> {
  const { profile } = await call<{ profile: { _id: string } }>("/profiles", {
    method: "POST",
    body: JSON.stringify({ name: `distro-${externalId}`, externalId }),
  });
  return profile._id;
}

/** Zernio refuses while the profile still has active accounts; that error reaches the caller. */
export async function deleteZernioProfile(zernioId: string): Promise<void> {
  await call(`/profiles/${zernioId}`, { method: "DELETE" });
}

/** `back` is appended to our own callback URL, so the callback knows which page started the flow. */
export async function connectUrl(zernioId: string, platform: Platform, origin: string, back = ""): Promise<string> {
  const query = new URLSearchParams({ profileId: zernioId, redirect_url: `${origin}/connect/callback?platform=${platform}${back}` });
  const { authUrl } = await call<{ authUrl: string }>(`/connect/${platform}?${query}`);
  return authUrl;
}

type Account = { _id: string; platform: string; username?: string; isActive?: boolean };

export async function listAccounts(zernioId: string) {
  const { accounts } = await call<{ accounts: Account[] }>(`/accounts?profileId=${zernioId}`);
  return accounts.map((a) => ({ account_id: a._id, platform: a.platform, username: a.username, active: a.isActive }));
}

export async function createPost(payload: unknown) {
  return call<{ post?: { _id?: string; status?: string } }>("/posts", { method: "POST", body: JSON.stringify(payload) });
}
