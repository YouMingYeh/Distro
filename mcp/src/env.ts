import { env as raw } from "cloudflare:workers";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** This Worker's public origin. It is the OAuth resource: tokens are bound to it and cover /mcp and /api. */
  ORIGIN: string;
  /** The Next.js site. Browser flows return here. */
  WEB_ORIGIN: string;
  /** Secret. Unset means account and publish tools answer "not configured". */
  ZERNIO_API_KEY?: string;
}

export const env = raw as unknown as Env;

export const PLATFORMS = ["tiktok", "instagram", "youtube", "twitter", "threads"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const isPlatform = (v: unknown): v is Platform => (PLATFORMS as readonly unknown[]).includes(v);

export const SCOPES = {
  accounts: "Link social accounts and see which are connected",
  video: "Run video models and read job status",
  publish: "Create posts on connected accounts",
} as const;
export type Scope = keyof typeof SCOPES;

/** What completeAuthorization() stores on a grant and every tool call receives. */
export type Props = { workspaceId: string; scopes: string[] };
