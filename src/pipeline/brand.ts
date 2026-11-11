import { nowIso, safeJson, ToolError, type Env } from "../env";

export type BrandInput = {
  name?: string;
  site_url?: string;
  notes?: string;
  niche?: string;
  audience?: string;
  tone?: string;
  platform?: "TikTok" | "Instagram";
  cta?: string;
  competitors?: string[];
  avoid_claims?: string[];
};

export type Brand = {
  set: true;
  name: string | null;
  site_url: string | null;
  site_excerpt: string | null;
  scrape_ok: boolean | null;
  notes: string | null;
  niche: string | null;
  audience: string | null;
  tone: string | null;
  platform: string;
  cta: string | null;
  competitors: string[];
  avoid_claims: string[];
  updated_at: string;
};

type Row = {
  name: string | null;
  site_url: string | null;
  site_excerpt: string | null;
  scrape_ok: number | null;
  notes: string | null;
  niche: string | null;
  audience: string | null;
  tone: string | null;
  platform: string | null;
  cta: string | null;
  competitors_json: string | null;
  avoid_claims_json: string | null;
  updated_at: string;
};

export async function getBrand(env: Env): Promise<Brand | null> {
  const r = await env.DB.prepare(`SELECT * FROM brand_config WHERE id=1`).first<Row>();
  if (!r) return null;
  return {
    set: true,
    name: r.name,
    site_url: r.site_url,
    site_excerpt: r.site_excerpt,
    scrape_ok: r.scrape_ok === null ? null : r.scrape_ok === 1,
    notes: r.notes,
    niche: r.niche,
    audience: r.audience,
    tone: r.tone,
    platform: r.platform ?? "TikTok",
    cta: r.cta,
    competitors: safeJson<string[]>(r.competitors_json, []),
    avoid_claims: safeJson<string[]>(r.avoid_claims_json, []),
    updated_at: r.updated_at,
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function meta(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decodeEntities(content).trim() : null;
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.startsWith("[") || h === "::1") return true;
  return false;
}

/** Fetch a site and reduce it to title, description and visible text. Never throws. */
export async function scrapeSite(siteUrl: string): Promise<{ ok: boolean; title: string | null; excerpt: string | null; reason?: string }> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
  } catch {
    return { ok: false, title: null, excerpt: null, reason: "not a valid URL" };
  }
  if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) {
    return { ok: false, title: null, excerpt: null, reason: "URL is not a public http(s) address" };
  }
  try {
    const res = await fetch(url.toString(), {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DistroBot/0.1)", Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, title: null, excerpt: null, reason: `site returned HTTP ${res.status}` };
    const type = res.headers.get("Content-Type") ?? "";
    if (type && !/html|text/i.test(type)) return { ok: false, title: null, excerpt: null, reason: `unexpected content type ${type}` };

    // Cap the read at ~400 KB.
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      let total = 0;
      while (total < 400_000) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        html += dec.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => {});
    }

    const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim() || meta(html, "og:title");
    const description = meta(html, "description") ?? meta(html, "og:description") ?? meta(html, "twitter:description");
    const text = decodeEntities(
      html
        .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/\s+/g, " ")
      .trim();
    const parts = [title ? `Title: ${title}` : null, description ? `Description: ${description}` : null, text ? `Page text: ${text.slice(0, 1400)}` : null].filter(Boolean);
    const excerpt = parts.join("\n").slice(0, 1800);
    const ok = Boolean(title || description || text.length > 80);
    return { ok, title: title || null, excerpt: excerpt || null, reason: ok ? undefined : "page had no readable text (it may be rendered by JavaScript)" };
  } catch (e) {
    return { ok: false, title: null, excerpt: null, reason: `fetch failed (${String(e).slice(0, 80)})` };
  }
}

export async function setBrand(env: Env, input: BrandInput): Promise<Brand & { scrape_note?: string }> {
  if (!input.name && !input.site_url && !input.notes) {
    throw new ToolError("Provide at least one of name, site_url, or notes.");
  }
  let excerpt: string | null = null;
  let scrapeOk: number | null = null;
  let scrapeNote: string | undefined;
  let name = input.name?.trim() || null;
  let siteUrl = input.site_url?.trim() || null;

  if (siteUrl) {
    if (!/^https?:\/\//i.test(siteUrl)) siteUrl = `https://${siteUrl}`;
    const s = await scrapeSite(siteUrl);
    scrapeOk = s.ok ? 1 : 0;
    excerpt = s.excerpt;
    if (!s.ok) scrapeNote = `Could not read the site (${s.reason}). Using the notes you gave instead.`;
    if (!name && s.title) name = s.title.split(/\s+[|\-–—:·]\s+/)[0].trim().slice(0, 80) || null;
  }

  await env.DB.prepare(
    `INSERT INTO brand_config (id,name,brief_md,site_url,site_excerpt,scrape_ok,niche,audience,tone,platform,cta,competitors_json,avoid_claims_json,notes,updated_at)
     VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, brief_md=excluded.brief_md, site_url=excluded.site_url, site_excerpt=excluded.site_excerpt,
       scrape_ok=excluded.scrape_ok, niche=excluded.niche, audience=excluded.audience, tone=excluded.tone,
       platform=excluded.platform, cta=excluded.cta, competitors_json=excluded.competitors_json,
       avoid_claims_json=excluded.avoid_claims_json, notes=excluded.notes, updated_at=excluded.updated_at`,
  )
    .bind(
      name,
      input.notes ?? null,
      siteUrl,
      excerpt,
      scrapeOk,
      input.niche ?? null,
      input.audience ?? null,
      input.tone ?? null,
      input.platform ?? "TikTok",
      input.cta ?? null,
      JSON.stringify(input.competitors ?? []),
      JSON.stringify(input.avoid_claims ?? []),
      input.notes ?? null,
      nowIso(),
    )
    .run();

  const brand = (await getBrand(env))!;
  return scrapeNote ? { ...brand, scrape_note: scrapeNote } : brand;
}

/** The brand "bible" injected into every generation and judging prompt. Only states what the profile states. */
export function brandBrief(brand: Brand | null, briefOverride?: string): string {
  if (briefOverride?.trim()) {
    const extra = brand ? `\n\nStored profile for reference:\n${brandBrief(brand)}` : "";
    return `Product brief (from the user):\n${briefOverride.trim()}${extra}`;
  }
  if (!brand) return "";
  const lines = [
    brand.name ? `Name: ${brand.name}` : null,
    brand.site_url ? `Site: ${brand.site_url}` : null,
    brand.niche ? `Niche: ${brand.niche}` : null,
    brand.audience ? `Audience: ${brand.audience}` : null,
    brand.tone ? `Tone: ${brand.tone}` : null,
    `Platform: ${brand.platform}`,
    brand.cta ? `CTA: ${brand.cta}` : null,
    brand.competitors.length ? `Competitors: ${brand.competitors.join(", ")}` : null,
    brand.avoid_claims.length ? `Claims to avoid: ${brand.avoid_claims.join("; ")}` : null,
    brand.notes ? `User notes: ${brand.notes}` : null,
    brand.site_excerpt ? `Site excerpt:\n${brand.site_excerpt.slice(0, 1200)}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

export const NO_BRAND_ERROR =
  "No brand profile yet. Call set_brand first with a site_url and/or notes (ask the user what the product is), or pass a `brief`.";
