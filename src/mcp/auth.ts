import type { Env } from "../env";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Optional shared bearer. A no-op when DISTRO_BEARER_TOKEN is unset (the
 * default, and what a hosted demo should use). When set, the token must come
 * in the Authorization header; it is never read from the query string.
 */
export function checkBearer(request: Request, env: Env): Response | null {
  const token = env.DISTRO_BEARER_TOKEN;
  if (!token) return null;
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (given && timingSafeEqual(given, token)) return null;
  return new Response(JSON.stringify({ error: "unauthorized", message: "Send Authorization: Bearer <DISTRO_BEARER_TOKEN>." }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
  });
}
