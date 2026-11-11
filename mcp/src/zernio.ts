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
  // A profile holds one account per platform. An inactive one may be linked again.
  const taken = (await listAccounts(zernioId)).find((a) => a.platform === platform && a.active !== false);
  if (taken) {
    throw new Error(
      `This profile already has a ${platform} account${taken.username ? ` (@${taken.username})` : ""}. A profile holds one account per platform: connect the second one in another profile (create_profile).`,
    );
  }
  const query = new URLSearchParams({ profileId: zernioId, redirect_url: `${origin}/connect/callback?platform=${platform}${back}` });
  const { authUrl } = await call<{ authUrl: string }>(`/connect/${platform}?${query}`);
  return authUrl;
}

type Account = { _id: string; platform: string; username?: string; isActive?: boolean };

export async function listAccounts(zernioId: string) {
  const { accounts } = await call<{ accounts: Account[] }>(`/accounts?profileId=${zernioId}`);
  return accounts.map((a) => ({ account_id: a._id, platform: a.platform, username: a.username, active: a.isActive }));
}

type AnalyticsPost = {
  _id: string;
  platform?: string;
  content?: string;
  publishedAt?: string;
  platformPostUrl?: string;
  thumbnailUrl?: string;
  platforms?: { accountUsername?: string }[];
  analytics?: { views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null };
};

/**
 * A profile's published posts with their metrics, newest first. Includes posts made outside Distro.
 * ponytail: one page of 50 from Zernio's default 90-day window; page through it if anyone posts more.
 */
export async function listPosts(zernioId: string) {
  const { posts } = await call<{ posts: AnalyticsPost[] }>(`/analytics?profileId=${zernioId}&limit=50&sortBy=date&order=desc`);
  return posts.map((p) => ({
    id: p._id,
    platform: p.platform,
    username: p.platforms?.[0]?.accountUsername,
    caption: p.content?.slice(0, 200),
    published: p.publishedAt,
    url: p.platformPostUrl,
    thumbnail: p.thumbnailUrl,
    views: p.analytics?.views ?? 0,
    likes: p.analytics?.likes ?? 0,
    comments: p.analytics?.comments ?? 0,
    shares: p.analytics?.shares ?? 0,
  }));
}

export async function createPost(payload: unknown) {
  return call<{ post?: { _id?: string; status?: string } }>("/posts", { method: "POST", body: JSON.stringify(payload) });
}
