import { env } from "./env";
import { readProfiles, useProfile } from "./profiles";
import { call, listAccounts } from "./zernio";

// Paid ads through Zernio's Ads API. One Zernio API key serves every workspace, so every call
// here first proves the account or ad belongs to the caller's own profiles: see ownAccount / ownAd.

export const AD_PLATFORMS = ["facebook", "instagram", "tiktok", "linkedin", "twitter", "pinterest", "googleads", "redditads", "microsoftads"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];
export const AD_GOALS = ["engagement", "traffic", "awareness", "video_views", "lead_generation", "conversions", "app_promotion"] as const;

const qs = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));

/** The link the user opens to grant ads access on one platform. */
export async function connectAdsUrl(ws: string, platform: AdPlatform, profileRef?: string) {
  const p = await useProfile(ws, profileRef);
  let accountId: string | undefined;
  if (platform === "twitter") {
    // X Ads hangs off an already connected X account.
    accountId = (await listAccounts(p.zernioId)).find((a) => a.platform === "twitter" && a.active !== false)?.account_id;
    if (!accountId) throw new Error(`Connect an X account to profile "${p.name}" first (connect_account), then connect its ads.`);
  }
  const r = await call<{ authUrl?: string; alreadyConnected?: boolean; accountId?: string; username?: string }>(
    `/connect/${platform}/ads?${qs({ profileId: p.zernioId, accountId, redirect_url: `${env.ORIGIN}/ads/callback` })}`,
  );
  return r.alreadyConnected
    ? { profile: p.name, platform, already_connected: true, account_id: r.accountId, username: r.username }
    : { profile: p.name, platform, auth_url: r.authUrl };
}

/** Throws unless `accountId` is a connection in this workspace's profile. */
async function ownAccount(ws: string, accountId: string, profileRef?: string) {
  const p = await useProfile(ws, profileRef);
  const account = (await listAccounts(p.zernioId)).find((a) => a.account_id === accountId);
  if (!account) throw new Error(`No account ${accountId} in profile "${p.name}". Call list_ad_accounts to see the ones you can use.`);
  return { profile: p, account };
}

type Ad = { _id: string; name?: string; platform?: string; profileId?: string; status?: unknown; goal?: string; budget?: unknown; metrics?: unknown; campaignName?: string; platformAdAccountId?: string };

/** Throws unless the ad sits in one of this workspace's profiles. Returns Zernio's own id for it. */
async function ownAd(ws: string, adId: string): Promise<Ad> {
  const mine = new Set((await readProfiles(ws)).map((p) => p.zernio_id).filter(Boolean));
  // "Not found" for someone else's ad too, so ids cannot be probed.
  const { ad } = await call<{ ad: Ad | null }>(`/ads/${encodeURIComponent(adId)}`).catch((e: Error) => {
    if (!/^Zernio 4\d\d/.test(e.message)) throw e; // outage or missing key: say so
    return { ad: null };
  });
  if (!ad?.profileId || !mine.has(ad.profileId)) throw new Error(`No ad ${adId} in this workspace. Call list_ads to see yours.`);
  return ad;
}

const brief = (a: Ad) => ({
  ad_id: a._id,
  name: a.name,
  platform: a.platform,
  status: a.status,
  goal: a.goal,
  campaign: a.campaignName,
  ad_account_id: a.platformAdAccountId,
  budget: a.budget,
  metrics: a.metrics,
});

type AdAccount = { id: string; name?: string; currency?: string; selectable?: boolean; unusableReason?: string | null; billingStatus?: string; balance?: number; minimumDailyBudget?: number };

/** Every ad account each connection in the profile can spend from. */
export async function listAdAccounts(ws: string, profileRef?: string) {
  const p = await useProfile(ws, profileRef);
  const accounts = (await listAccounts(p.zernioId)).filter((a) => a.active !== false);
  const settled = await Promise.allSettled(accounts.map((a) => call<{ accounts: AdAccount[] }>(`/ads/accounts?${qs({ accountId: a.account_id })}`)));
  const connections = settled.flatMap((s, i) =>
    // A connection without ads access just fails here; leave it out.
    s.status === "rejected" || !s.value.accounts?.length
      ? []
      : [{
          account_id: accounts[i].account_id,
          platform: accounts[i].platform,
          username: accounts[i].username,
          ad_accounts: s.value.accounts.map((x) => ({
            ad_account_id: x.id,
            name: x.name,
            currency: x.currency,
            usable: x.selectable ?? true,
            problem: x.unusableReason ?? undefined,
            billing: x.billingStatus,
            balance: x.balance,
            minimum_daily_budget: x.minimumDailyBudget,
          })),
        }],
  );
  return { profile: p.name, connections, ...(connections.length ? {} : { hint: "No ad accounts yet. Call connect_ads." }) };
}

export type Spend = {
  account_id: string;
  ad_account_id: string;
  name: string;
  goal: (typeof AD_GOALS)[number];
  budget_amount: number;
  budget_type: "daily" | "lifetime";
  end_date?: string;
  countries?: string[];
  age_min?: number;
  age_max?: number;
  link_url?: string;
  call_to_action?: string;
  start_paused: boolean;
  dry_run: boolean;
  profile?: string;
  options?: Record<string, unknown>;
};

/** Create something that spends money. `own` is spread last so `options` can never redirect the account. */
async function spend(ws: string, path: "/ads/boost" | "/ads/create", a: Spend, creative: Record<string, unknown>) {
  if (a.budget_type === "lifetime" && !a.end_date) throw new Error("A lifetime budget needs end_date.");
  const { profile, account } = await ownAccount(ws, a.account_id, a.profile);
  const payload = {
    ...a.options,
    ...creative,
    name: a.name,
    goal: a.goal,
    budgetAmount: a.budget_amount,
    budgetType: a.budget_type,
    ...(a.end_date ? { endDate: a.end_date } : {}),
    ...(a.link_url ? { linkUrl: a.link_url } : {}),
    ...(a.call_to_action ? { callToAction: a.call_to_action } : {}),
    status: a.start_paused ? "PAUSED" : "ACTIVE",
    validateOnly: false,
    accountId: a.account_id,
    adAccountId: a.ad_account_id,
  };
  if (a.dry_run) {
    return { dry_run: true, message: "Dry-run only; no ad was created and nothing will be spent.", profile: profile.name, platform: account.platform, payload };
  }
  // Same request from the same workspace replays the first answer instead of buying a second ad.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ws + path + JSON.stringify(payload)));
  const key = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const r = await call<{ ad?: Ad; message?: string }>(path, { method: "POST", body: JSON.stringify(payload), headers: { "Idempotency-Key": key } });
  return { dry_run: false, message: r.message, ad: r.ad ? brief(r.ad) : undefined };
}

/** Only the audience fields the caller set. Boost takes them nested under `targeting`, create takes them flat. */
const audience = (a: Spend) =>
  Object.fromEntries(Object.entries({ countries: a.countries, ageMin: a.age_min, ageMax: a.age_max }).filter(([, v]) => v !== undefined));

export const boostPost = (ws: string, a: Spend & { post_id?: string; platform_post_id?: string }) => {
  if (!a.post_id === !a.platform_post_id) throw new Error("Give exactly one of post_id (from publish) or platform_post_id.");
  const targeting = audience(a);
  return spend(ws, "/ads/boost", a, {
    ...(a.post_id ? { postId: a.post_id } : { platformPostId: a.platform_post_id }),
    ...(Object.keys(targeting).length ? { targeting } : {}),
  });
};

export const createAd = (ws: string, a: Spend & { headline?: string; body: string; video_url?: string; image_url?: string }) => {
  if (!a.video_url === !a.image_url) throw new Error("Give exactly one of video_url or image_url.");
  return spend(ws, "/ads/create", a, {
    ...audience(a),
    headline: a.headline,
    body: a.body,
    ...(a.video_url ? { video: { url: a.video_url } } : { imageUrl: a.image_url }),
  });
};

export async function listAds(ws: string, a: { profile?: string; status?: string; from_date?: string; to_date?: string; limit: number }) {
  const p = await useProfile(ws, a.profile);
  const r = await call<{ ads?: Ad[] }>(`/ads?${qs({ profileId: p.zernioId, status: a.status, fromDate: a.from_date, toDate: a.to_date, limit: a.limit })}`);
  return { profile: p.name, ads: (r.ads ?? []).map(brief) };
}

export async function setAdStatus(ws: string, adId: string, status: "active" | "paused") {
  const ad = await ownAd(ws, adId);
  const r = await call<Record<string, unknown>>(`/ads/${ad._id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
  return { ad_id: ad._id, name: ad.name, ...r };
}

export async function adAnalytics(ws: string, a: { ad_id: string; from_date?: string; to_date?: string }) {
  const ad = await ownAd(ws, a.ad_id);
  return call<unknown>(`/ads/${ad._id}/analytics?${qs({ fromDate: a.from_date, toDate: a.to_date })}`);
}
