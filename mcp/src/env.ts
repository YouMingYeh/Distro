import { env as raw } from "cloudflare:workers";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** This Worker's public origin. It is the OAuth resource: tokens are bound to it and cover /mcp and /api. */
  ORIGIN: string;
  /** The Next.js site. Browser flows return here. */
  WEB_ORIGIN: string;
  /** Clerk sign-in (where "Continue with Google" lives): the instance URL and its OAuth app for this Worker,
   *  redirect URI <ORIGIN>/callback. Unset means no sign-in: a workspace is just a browser cookie. */
  CLERK_ISSUER?: string;
  CLERK_OAUTH_CLIENT_ID?: string;
  CLERK_OAUTH_CLIENT_SECRET?: string;
  /** Secret. Unset means account and publish tools answer "not configured". */
  ZERNIO_API_KEY?: string;
  /** Secrets, one per scraper service. find_viral_videos asks every one that is set. */
  SCRAPECREATORS_API_KEY?: string;
  BYCRAWL_API_KEY?: string;
  OMNISCRAPE_API_KEY?: string;
  ENSEMBLEDATA_TOKEN?: string;
  APIFY_TOKEN?: string;
  /** Secrets for scrape_page and web_search. Tried in this order; the first that answers wins. */
  FIRECRAWL_API_KEY?: string;
  JINA_API_KEY?: string;
  TAVILY_API_KEY?: string;
  EXA_API_KEY?: string;
}

export const env = raw as unknown as Env;

export const PLATFORMS = ["tiktok", "instagram", "youtube", "twitter", "threads"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const isPlatform = (v: unknown): v is Platform => (PLATFORMS as readonly unknown[]).includes(v);

export const SCOPES = {
  accounts: "Link social accounts and see which are connected",
  video: "Run video models and read job status",
  research: "Search public videos and read public web pages",
  publish: "Create posts on connected accounts",
} as const;
export type Scope = keyof typeof SCOPES;

/** What completeAuthorization() stores on a grant and every tool call receives. */
export type Props = { workspaceId: string; scopes: string[] };
