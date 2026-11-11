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
  /** Secret: encrypts what users store here (their scraper keys, their DarkUGC and TokPortal tokens). Random, e.g. `openssl rand -base64 32`.
   *  Unset means nothing can be saved. Changing it makes everything saved so far unreadable. */
  KEYS_ENCRYPTION_KEY?: string;
  /** The video model server (docs/MODEL_SERVER.md): its base URL (a var) and bearer token (a secret).
   *  Unset means the video tools answer "not configured". */
  MODEL_SERVER_URL?: string;
  MODEL_SERVER_TOKEN?: string;
  /** R2 bucket for files users upload (create_upload). Unset means create_upload answers "not configured". */
  UPLOADS?: R2Bucket;
  /** Uploads a workspace may reserve per day. Default 20. */
  FREE_DAILY_UPLOADS?: string;
  /** Videos a workspace may start per day. Default 5. */
  FREE_DAILY_VIDEOS?: string;
  /** Research calls a workspace may make per day on the keys above. Its own keys (connect_keys) are not counted. Default 20. */
  FREE_DAILY_CALLS?: string;
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
  ads: "Connect ad accounts, create and pause paid ads, and read their results",
  managed: "Order managed accounts from TokPortal and post through them, on your TokPortal credits",
} as const;
export type Scope = keyof typeof SCOPES;

/** What completeAuthorization() stores on a grant and every tool call receives. */
/** `apiKey` is the id of the API key that authenticated the request; unset for an OAuth token. */
export type Props = { workspaceId: string; scopes: string[]; apiKey?: string };
