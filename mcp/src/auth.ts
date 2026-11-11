import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { env, isPlatform, SCOPES, type Props, type Scope } from "./env";
import { connectUrl } from "./zernio";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ponytail: a workspace is an unguessable id in an HttpOnly cookie, so there is no sign-in.
// The same browser gets the same workspace for every agent it authorizes. Ceiling: no access
// from a second browser or device. Upgrade path: put a real login in front of workspace().
const COOKIE = "__Host-distro-ws";
function workspace(req: Request): { id: string; setCookie?: string } {
  const found = req.headers.get("Cookie")?.match(new RegExp(`${COOKIE}=([0-9a-f-]{36})`))?.[1];
  if (found) return { id: found };
  const id = crypto.randomUUID();
  return { id, setCookie: `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000` };
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{--bg:#f4f4f5;--surface:#fafafa;--fg:#18181b;--muted:#52525b;--line:#d4d4d8}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0e;--surface:#151518;--fg:#ededf0;--muted:#a1a1aa;--line:#2a2a30}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,sans-serif}
main{width:min(26rem,calc(100% - 2rem));background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:1.75rem}
h1{font-size:1.35rem;line-height:1.25;margin:0 0 .75rem;letter-spacing:-.02em}
p{color:var(--muted);margin:.5rem 0;font-size:.9rem}strong{color:var(--fg)}
label{display:flex;gap:.6rem;align-items:baseline;padding:.6rem 0;border-top:1px solid var(--line);font-size:.9rem}
.row{display:flex;gap:.5rem;margin-top:1.25rem}
button{flex:1;font:inherit;font-weight:500;padding:.6rem 1rem;border-radius:999px;border:1px solid var(--line);background:none;color:var(--fg);cursor:pointer}
button[value=approve]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
</style><main>${body}</main></html>`;
}

function consentPage(d: ConsentDescription, handle: string): string {
  const requested = d.scope.filter((s): s is Scope => s in SCOPES);
  const shown = requested.length ? requested : (Object.keys(SCOPES) as Scope[]);
  const name = esc(d.clientName || "An app");
  return page(
    `Authorize ${name}`,
    `<h1>Allow ${name} to use your Distro tools?</h1>
<p>${d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}
Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
${d.scope.includes("offline_access") ? '<input type="hidden" name="scope" value="offline_access">' : ""}
${shown.map((s) => `<label><input type="checkbox" name="scope" value="${s}" checked><span>${SCOPES[s]}</span></label>`).join("")}
<div class="row"><button name="decision" value="deny">Deny</button><button name="decision" value="approve">Allow</button></div>
</form>`,
  );
}

async function authorize(req: Request): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        return new Response(null, { status: 302, headers: (await oauth.denyConsent(req, handle)).headers });
      }
      const approved = await oauth.approveConsent(req, handle, { scope: form.getAll("scope").map(String) });
      const ws = workspace(req);
      const scopes = approved.request.scope;
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request, // from storage, not from the form
        userId: ws.id,
        metadata: {},
        scope: scopes,
        props: { workspaceId: ws.id, scopes } satisfies Props,
      });
      approved.headers.set("Location", redirectTo);
      if (ws.setCookie) approved.headers.append("Set-Cookie", ws.setCookie);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    const request = await oauth.parseAuthRequest(req);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return new Response(page("Cannot authorize", `<h1>Cannot authorize</h1><p>${esc(message)}</p>`), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    throw error;
  }
}

/** Browser door for the site's Connect buttons: same workspace cookie, same Zernio flow as the tool. */
async function connectStart(req: Request, platform: string): Promise<Response> {
  if (!isPlatform(platform)) return new Response("Unknown platform", { status: 404 });
  const ws = workspace(req);
  let location: string;
  try {
    location = await connectUrl(ws.id, platform, new URL(req.url).origin);
  } catch {
    location = `${env.WEB_ORIGIN}/?error=connect_unavailable`;
  }
  const headers = new Headers({ Location: location });
  if (ws.setCookie) headers.append("Set-Cookie", ws.setCookie);
  return new Response(null, { status: 302, headers });
}

/** Zernio returns here after the platform's consent screen; hand the result to the site. */
function connectCallback(url: URL): Response {
  const to = new URL(env.WEB_ORIGIN);
  const platform = url.searchParams.get("platform");
  if (url.searchParams.get("connected") && isPlatform(platform)) {
    to.searchParams.set("connected", "1");
    to.searchParams.set("platform", platform);
    const username = url.searchParams.get("username");
    if (username) to.searchParams.set("username", username.slice(0, 64));
  } else {
    to.searchParams.set("error", "connect_failed");
  }
  return Response.redirect(to.toString(), 302);
}

export const authHandler = {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/authorize") return authorize(req);
    if (url.pathname === "/connect/callback") return connectCallback(url);
    const platform = url.pathname.match(/^\/connect\/([a-z]+)$/)?.[1];
    if (platform && req.method === "GET") return connectStart(req, platform);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/") return Response.redirect(env.WEB_ORIGIN, 302);
    return new Response("Not found", { status: 404 });
  },
};
