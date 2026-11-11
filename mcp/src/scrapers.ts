// Viral short-form video research across external scraper services.
// No runtime imports: keys are passed in, so this file runs under plain `node --test` (see scripts/scrapers.test.mjs).

export type VideoPlatform = "tiktok" | "instagram" | "youtube";
export type Video = {
  platform: VideoPlatform;
  id: string;
  url: string;
  caption?: string;
  author?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  created_at?: string;
  duration_s?: number;
  provider: string;
};
export type Query = { query: string; platform: VideoPlatform; days: 7 | 30 | 90; limit: number };
type Row = Omit<Video, "provider">;
type Provider = { key: string; platforms: VideoPlatform[]; search: (key: string, q: Query) => Promise<Row[]> };
/* eslint-disable @typescript-eslint/no-explicit-any -- third-party JSON */

// ponytail: one fixed timeout for every provider. ByCrawl's TikTok search takes 20-40s; Apify actors can
// take minutes and will simply report a timeout here. Move Apify to async run + poll if it matters.
const TIMEOUT_MS = 55_000;

async function http(url: string, params: Record<string, string | number>, init: RequestInit = {}): Promise<any> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${url}?${qs}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
/** Unix seconds or a date string -> ISO. */
const iso = (v: unknown) => {
  if (v == null || v === "") return undefined;
  const d = new Date(num(v) !== undefined ? Number(v) * 1000 : String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const clock = (v: unknown) => (typeof v === "string" && v.includes(":") ? v.split(":").reduce((a, b) => a * 60 + Number(b), 0) : num(v));
const tiktokUrl = (author: unknown, id: unknown) => `https://www.tiktok.com/@${author ?? ""}/video/${id}`;

/** TikTok's own "aweme" object, as passed through by ScrapeCreators and EnsembleData. Duration is in ms. */
const aweme = (a: any): Row => ({
  platform: "tiktok",
  id: String(a.aweme_id),
  url: a.author?.unique_id ? tiktokUrl(a.author.unique_id, a.aweme_id) : a.share_url,
  caption: a.desc,
  author: a.author?.unique_id,
  views: num(a.statistics?.play_count),
  likes: num(a.statistics?.digg_count),
  comments: num(a.statistics?.comment_count),
  shares: num(a.statistics?.share_count),
  created_at: iso(a.create_time),
  duration_s: num(a.video?.duration) && Math.round(num(a.video.duration)! / 1000),
});

const SC = "https://api.scrapecreators.com";
const scrapecreators: Provider = {
  key: "SCRAPECREATORS_API_KEY",
  platforms: ["tiktok", "instagram", "youtube"],
  async search(key, q) {
    const headers = { "x-api-key": key };
    if (q.platform === "tiktok") {
      const date_posted = { 7: "this-week", 30: "this-month", 90: "last-3-months" }[q.days];
      const r = await http(`${SC}/v1/tiktok/search/keyword`, { query: q.query, date_posted, sort_by: "most-liked" }, { headers });
      return (r.search_item_list ?? []).map((i: any) => aweme(i.aweme_info));
    }
    if (q.platform === "instagram") {
      const date_posted = { 7: "last-week", 30: "last-month", 90: "last-year" }[q.days];
      const r = await http(`${SC}/v2/instagram/reels/search`, { query: q.query, date_posted }, { headers });
      return (r.reels ?? []).map((x: any) => ({
        platform: "instagram",
        id: String(x.id),
        url: x.url,
        caption: x.caption,
        author: x.owner?.username,
        views: num(x.video_play_count ?? x.video_view_count), // not in the docs sample; undefined if absent
        likes: num(x.like_count),
        comments: num(x.comment_count),
        created_at: iso(x.taken_at),
        duration_s: num(x.video_duration),
      }));
    }
    const uploadDate = { 7: "this_week", 30: "this_month", 90: "this_year" }[q.days];
    const r = await http(`${SC}/v1/youtube/search`, { query: q.query, type: "shorts", uploadDate, sortBy: "popular" }, { headers });
    return (r.shorts?.length ? r.shorts : (r.videos ?? [])).map((x: any) => ({
      platform: "youtube",
      id: String(x.id),
      url: x.url,
      caption: x.title,
      author: x.channel?.handle ?? x.channel?.title,
      views: num(x.viewCountInt),
      created_at: iso(x.publishedTime),
      duration_s: num(x.lengthSeconds),
    }));
  },
};

/** ByCrawl and OmniScrape expose the same API on different hosts. */
const bycrawlLike = (base: string, key: string, platforms: VideoPlatform[]): Provider => ({
  key,
  platforms,
  async search(k, q) {
    const headers = { "x-api-key": k };
    if (q.platform === "tiktok") {
      // Billed per returned item, so count follows the caller's limit (max 30).
      const r = await http(`${base}/tiktok/videos/search`, { q: q.query, count: Math.min(q.limit, 30) }, { headers });
      return (r.videos ?? []).map((x: any) => ({
        platform: "tiktok",
        id: String(x.id),
        url: x.url ?? tiktokUrl(x.author, x.id),
        caption: x.description || x.title,
        author: x.author,
        views: num(x.views),
        likes: num(x.likes),
        comments: num(x.comments),
        shares: num(x.shares),
        created_at: iso(x.createdAt),
        // Their docs show both seconds (60) and ms (17834) here. No TikTok is 1000+ seconds long.
        duration_s: num(x.duration) && Math.round(x.duration > 1000 ? x.duration / 1000 : x.duration),
      }));
    }
    if (q.platform === "instagram") {
      const date_posted = { 7: "last-week", 30: "last-month", 90: "last-year" }[q.days];
      const r = await http(`${base}/instagram/reels/search`, { q: q.query, date_posted }, { headers });
      return (r.reels ?? []).map((x: any) => ({
        platform: "instagram",
        id: String(x.id),
        url: `https://www.instagram.com/reel/${x.shortcode}/`,
        caption: x.caption,
        author: x.owner?.username,
        views: num(x.videoViewCount),
        likes: num(x.likeCount),
        comments: num(x.commentCount),
        created_at: iso(x.takenAt),
      }));
    }
    const r = await http(`${base}/youtube/videos/search`, { q: q.query, count: Math.min(q.limit, 20), type: "shorts" }, { headers });
    return (r.videos ?? []).map((x: any) => ({
      platform: "youtube",
      id: String(x.id),
      url: `https://www.youtube.com/shorts/${x.id}`,
      caption: x.title,
      author: x.channelTitle,
      views: num(x.viewCount),
      likes: num(x.likeCount),
      comments: num(x.commentCount),
      created_at: iso(x.publishedAt),
      duration_s: clock(x.duration),
    }));
  },
});

const ensembledata: Provider = {
  key: "ENSEMBLEDATA_TOKEN",
  platforms: ["tiktok"],
  async search(key, q) {
    // period = days back, sorting 1 = most liked.
    const r = await http("https://ensembledata.com/apis/tt/keyword/search", { name: q.query, period: q.days, sorting: 1, token: key });
    return (r.data?.data ?? []).map((i: any) => aweme(i.aweme_info));
  },
};

const apify: Provider = {
  key: "APIFY_TOKEN",
  platforms: ["tiktok"],
  async search(key, q) {
    const items = await http(
      "https://api.apify.com/v2/acts/clockworks~tiktok-scraper/run-sync-get-dataset-items",
      { timeout: 50 }, // stop the actor run (and its billing) before we stop listening
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ searchQueries: [q.query], resultsPerPage: q.limit }),
      },
    );
    return (items as any[])
      .filter((x) => x.id && !x.errorCode)
      .map((x) => ({
        platform: "tiktok",
        id: String(x.id),
        url: x.webVideoUrl ?? tiktokUrl(x.authorMeta?.name, x.id),
        caption: x.text,
        author: x.authorMeta?.name,
        views: num(x.playCount),
        likes: num(x.diggCount),
        comments: num(x.commentCount),
        shares: num(x.shareCount),
        created_at: iso(x.createTimeISO ?? x.createTime),
        duration_s: num(x.videoMeta?.duration),
      }));
  },
};

export const PROVIDERS = {
  scrapecreators,
  bycrawl: bycrawlLike("https://api.bycrawl.com", "BYCRAWL_API_KEY", ["tiktok", "instagram", "youtube"]),
  // OmniScrape documents no reels search and no Shorts filter, so TikTok only.
  omniscrape: bycrawlLike("https://api.omniscrape.dev", "OMNISCRAPE_API_KEY", ["tiktok"]),
  ensembledata,
  apify,
} satisfies Record<string, Provider>;
export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]];

type Keys = Record<string, unknown>;

/** Ask every configured provider at once, merge, drop duplicates and stale posts, rank by views. */
export async function findViral(keys: Keys, q: Query & { providers?: ProviderId[] }) {
  const forPlatform = PROVIDER_IDS.filter((id) => PROVIDERS[id].platforms.includes(q.platform));
  const ids = forPlatform.filter((id) => keys[PROVIDERS[id].key] && (!q.providers || q.providers.includes(id)));
  if (!ids.length) {
    throw new Error(
      `No scraper is configured for ${q.platform}. Set one of: ${forPlatform.map((id) => PROVIDERS[id].key).join(", ")}.`,
    );
  }
  const settled = await Promise.allSettled(ids.map((id) => PROVIDERS[id].search(String(keys[PROVIDERS[id].key]), q)));

  const cutoff = Date.now() - q.days * 86_400_000;
  const seen = new Map<string, Video>();
  const sources = settled.map((s, i) => {
    if (s.status === "rejected") return { provider: ids[i], ok: false, error: String(s.reason?.message ?? s.reason) };
    for (const v of s.value) {
      if (!v.id || v.id === "undefined" || seen.has(v.id)) continue;
      if (v.created_at && Date.parse(v.created_at) < cutoff) continue;
      seen.set(v.id, { ...v, provider: ids[i] });
    }
    return { provider: ids[i], ok: true, found: s.value.length };
  });
  const score = (v: Video) => v.views ?? v.likes ?? 0;
  return { videos: [...seen.values()].sort((a, b) => score(b) - score(a)).slice(0, q.limit), sources };
}

/** WebVTT -> the words spoken in the first `seconds` (the hook) and the whole transcript. */
export function hookFromVtt(vtt: string, seconds = 5) {
  const cues = [...vtt.matchAll(/(?:(\d+):)?(\d+):(\d+)[.,]\d+ --> [^\n]*\n([\s\S]*?)(?=\n\s*\n|\s*$)/g)].map((m) => ({
    start: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]),
    text: m[4].replace(/\s+/g, " ").trim(),
  }));
  const join = (c: typeof cues) => c.map((x) => x.text).filter(Boolean).join(" ");
  return { hook: join(cues.filter((c) => c.start < seconds)), transcript: join(cues) };
}

export async function getHook(keys: Keys, url: string) {
  if (!keys.SCRAPECREATORS_API_KEY) throw new Error("Transcripts need SCRAPECREATORS_API_KEY, which is unset on this server.");
  const r = await http(`${SC}/v1/tiktok/video/transcript`, { url }, { headers: { "x-api-key": String(keys.SCRAPECREATORS_API_KEY) } });
  if (!r.transcript) throw new Error("This video has no transcript (no speech, or captions are unavailable).");
  return { url, ...hookFromVtt(r.transcript) };
}

// ---- General web scrapers: read one page, or search the web. ----
// Unlike findViral these are tried in order and the first that answers wins: one page costs one call.

type Page = { url: string; title?: string; markdown: string };
type Hit = { url: string; title?: string; snippet?: string };
type WebProvider = {
  key: string;
  scrape?: (key: string, url: string) => Promise<Page>;
  search?: (key: string, query: string, limit: number) => Promise<Hit[]>;
};

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  http(url, {}, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

export const WEB_IDS = ["firecrawl", "jina", "tavily", "exa"] as const;
export type WebId = (typeof WEB_IDS)[number];
const WEB: Record<WebId, WebProvider> = {
  firecrawl: {
    key: "FIRECRAWL_API_KEY",
    async scrape(k, url) {
      const { data } = await post("https://api.firecrawl.dev/v2/scrape", bearer(k), { url, formats: ["markdown"] });
      return { url: data?.metadata?.url ?? url, title: first(data?.metadata?.title), markdown: data?.markdown ?? "" };
    },
    async search(k, query, limit) {
      const r = await post("https://api.firecrawl.dev/v2/search", bearer(k), { query, limit });
      return (r.data?.web ?? []).map((x: any) => ({ url: x.url, title: x.title, snippet: x.description }));
    },
  },
  jina: {
    key: "JINA_API_KEY",
    async scrape(k, url) {
      const { data } = await post("https://r.jina.ai/", { ...bearer(k), Accept: "application/json" }, { url });
      return { url: data?.url ?? url, title: data?.title, markdown: data?.content ?? "" };
    },
  },
  tavily: {
    key: "TAVILY_API_KEY",
    async scrape(k, url) {
      const r = await post("https://api.tavily.com/extract", bearer(k), { urls: [url] });
      if (!r.results?.length) throw new Error(r.failed_results?.[0]?.error ?? "extract failed");
      return { url, markdown: r.results[0].raw_content ?? "" };
    },
    async search(k, query, limit) {
      const r = await post("https://api.tavily.com/search", bearer(k), { query, max_results: Math.min(limit, 20) });
      return (r.results ?? []).map((x: any) => ({ url: x.url, title: x.title, snippet: x.content }));
    },
  },
  exa: {
    key: "EXA_API_KEY",
    async scrape(k, url) {
      const r = await post("https://api.exa.ai/contents", { "x-api-key": k }, { urls: [url], text: true });
      return { url, title: r.results?.[0]?.title, markdown: r.results?.[0]?.text ?? "" };
    },
    async search(k, query, limit) {
      const r = await post("https://api.exa.ai/search", { "x-api-key": k }, { query, numResults: limit });
      return (r.results ?? []).map((x: any) => ({ url: x.url, title: x.title }));
    },
  },
};

async function firstOk<T>(keys: Keys, kind: "scrape" | "search", only: WebId | undefined, run: (p: WebProvider, key: string) => Promise<T>) {
  const able = WEB_IDS.filter((id) => WEB[id][kind] && (!only || only === id));
  const ids = able.filter((id) => keys[WEB[id].key]);
  if (!ids.length) throw new Error(`No ${kind} service is configured. Set one of: ${able.map((id) => WEB[id].key).join(", ")}.`);
  const errors: string[] = [];
  for (const id of ids) {
    try {
      return { ...(await run(WEB[id], String(keys[WEB[id].key]))), provider: id };
    } catch (e) {
      errors.push(`${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw new Error(errors.join("; "));
}

export const scrapePage = (keys: Keys, a: { url: string; provider?: WebId; max_chars: number }) =>
  firstOk(keys, "scrape", a.provider, async (p, key) => {
    const page = await p.scrape!(key, a.url);
    if (!page.markdown.trim()) throw new Error("empty page"); // let the next service try
    return { ...page, markdown: page.markdown.slice(0, a.max_chars), truncated: page.markdown.length > a.max_chars };
  });

export const searchWeb = (keys: Keys, a: { query: string; limit: number; provider?: WebId }) =>
  firstOk(keys, "search", a.provider, async (p, key) => ({ results: (await p.search!(key, a.query, a.limit)).slice(0, a.limit) }));

/** Every secret a workspace may bring itself: key name -> service. */
export const VIDEO_KEYS = PROVIDER_IDS.map((id) => PROVIDERS[id].key);
export const WEB_KEYS = WEB_IDS.map((id) => WEB[id].key);
export const KEY_SERVICES: Record<string, string> = Object.fromEntries([
  ...PROVIDER_IDS.map((id) => [PROVIDERS[id].key, id]),
  ...WEB_IDS.map((id) => [WEB[id].key, id]),
]);
