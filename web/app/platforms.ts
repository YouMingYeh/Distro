// Platform slugs match Zernio's GET /v1/connect/{platform}.
export const PLATFORMS = ["tiktok", "instagram", "youtube", "twitter", "threads"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const isPlatform = (v: unknown): v is Platform =>
  typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
