// node --test scripts/scrapers.test.mjs   (Node 22.18+ strips the TypeScript types on import)
import assert from "node:assert/strict";
import { test } from "node:test";
import { findViral, hookFromVtt, scrapePage, searchWeb } from "../src/scrapers.ts";

const now = Math.floor(Date.now() / 1000);
const awemeItem = (id, plays, ageDays = 1) => ({
  aweme_info: {
    aweme_id: id,
    desc: `caption ${id}`,
    author: { unique_id: "maker" },
    statistics: { play_count: plays, digg_count: 1, comment_count: 2, share_count: 3 },
    create_time: now - ageDays * 86_400,
    video: { duration: 12_400 },
  },
});

// Trimmed from each provider's documented response shape.
const RESPONSES = {
  "api.scrapecreators.com": { search_item_list: [awemeItem("1", 500), awemeItem("2", 9000), awemeItem("old", 99_999, 400)] },
  "ensembledata.com": { data: { data: [awemeItem("2", 9000), awemeItem("3", 70_000)] } },
  "api.bycrawl.com": {
    videos: [{ id: "4", url: "https://www.tiktok.com/@a/video/4", description: "d", author: "a", views: 800, likes: 5, createdAt: new Date().toISOString(), duration: 17_834 }],
  },
  "r.jina.ai": { data: { title: "T", url: "https://x.dev/", content: "0123456789" } },
  "api.tavily.com": { results: [{ url: "https://x.dev/a", title: "A", content: "snip" }] },
  "api.apify.com": [{ id: "5", webVideoUrl: "u", text: "t", authorMeta: { name: "b" }, playCount: 100, videoMeta: { duration: 16 } }, { errorCode: "X" }],
};

globalThis.fetch = async (url) => {
  const host = new URL(url).host;
  if (!RESPONSES[host]) return new Response("origin down", { status: 521 });
  return Response.json(RESPONSES[host]);
};

const KEYS = { SCRAPECREATORS_API_KEY: "k", ENSEMBLEDATA_TOKEN: "k", BYCRAWL_API_KEY: "k", OMNISCRAPE_API_KEY: "k", APIFY_TOKEN: "k" };
const q = { query: "skincare", platform: "tiktok", days: 30, limit: 10 };

test("merges providers, dedupes, drops stale posts, ranks by views", async () => {
  const { videos, sources } = await findViral(KEYS, q);
  assert.deepEqual(videos.map((v) => v.id), ["3", "2", "4", "1", "5"]);
  assert.equal(videos[0].url, "https://www.tiktok.com/@maker/video/3");
  assert.equal(videos[0].duration_s, 12);
  assert.equal(videos.find((v) => v.id === "4").duration_s, 18);
  // one provider being down does not sink the call
  assert.deepEqual(sources.find((s) => s.provider === "omniscrape"), { provider: "omniscrape", ok: false, error: "HTTP 521: origin down" });
  assert.equal(sources.filter((s) => s.ok).length, 4);
});

test("only uses configured, requested providers", async () => {
  const { sources } = await findViral(KEYS, { ...q, providers: ["ensembledata"] });
  assert.deepEqual(sources, [{ provider: "ensembledata", ok: true, found: 2 }]);
  await assert.rejects(findViral({}, q), /No scraper is configured for tiktok/);
  await assert.rejects(findViral({ APIFY_TOKEN: "k" }, { ...q, platform: "instagram" }), /SCRAPECREATORS_API_KEY, BYCRAWL_API_KEY\.$/);
});

test("hookFromVtt keeps the first 5 seconds", () => {
  const vtt = "WEBVTT\n\n00:00:00.120 --> 00:00:01.840\nStop scrolling.\n\n00:00:02.000 --> 00:00:04.500\nThis changed\nmy skin.\n\n00:00:06.000 --> 00:00:08.000\nHere is how.\n";
  assert.deepEqual(hookFromVtt(vtt), { hook: "Stop scrolling. This changed my skin.", transcript: "Stop scrolling. This changed my skin. Here is how." });
  assert.equal(hookFromVtt("").hook, "");
});

test("page scrapers fall through to the next service", async () => {
  // Firecrawl is not mocked (521), so Jina answers.
  const keys = { FIRECRAWL_API_KEY: "k", JINA_API_KEY: "k", TAVILY_API_KEY: "k" };
  assert.deepEqual(await scrapePage(keys, { url: "https://x.dev", max_chars: 4 }), {
    url: "https://x.dev/", title: "T", markdown: "0123", truncated: true, provider: "jina",
  });
  await assert.rejects(scrapePage(keys, { url: "https://x.dev", max_chars: 4, provider: "firecrawl" }), /firecrawl: HTTP 521/);
  assert.deepEqual(await searchWeb(keys, { query: "q", limit: 5 }), {
    results: [{ url: "https://x.dev/a", title: "A", snippet: "snip" }], provider: "tavily",
  });
  // Jina has no search, so it is not offered as a key to set.
  await assert.rejects(searchWeb({ JINA_API_KEY: "k" }, { query: "q", limit: 5 }), /FIRECRAWL_API_KEY, TAVILY_API_KEY, EXA_API_KEY\.$/);
});
