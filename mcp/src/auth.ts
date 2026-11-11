import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { env, isPlatform, SCOPES, type Props, type Scope } from "./env";
import { listApiKeys } from "./apikeys";
import { readProfiles, useProfile } from "./profiles";
import { darkugcCallback } from "./darkugc";
import { videoFile } from "./inference";
import { KEY_NAMES, keysLinkWorkspace, saveKeys, userKeys } from "./keys";
import { KEY_SERVICES } from "./scrapers";
import { connectUrl, listAccounts } from "./zernio";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A workspace belongs to a signed-in user. Sign-in is Clerk (the "Distro Worker" OAuth app),
// which is where the Google button lives. KV maps user:<clerk user id> to the workspace id, and
// the cookie holds a random session id that KV maps to that workspace. Social accounts, profiles
// and DarkUGC tokens all hang off the workspace id, so they follow the user to any browser.
// Without CLERK_ISSUER (self-host without Clerk) there is no sign-in and the cookie value itself
// is the workspace.
const COOKIE = "__Host-distro-ws";
const STATE = "__Host-distro-st";
const YEAR = 31536000;
const signInRedirect = () => `${env.ORIGIN}/callback`; // registered on the Clerk OAuth app
const cookie = (req: Request, name: string) =>
  req.headers.get("Cookie")?.match(new RegExp(`(?:^|; )${name}=([0-9a-f-]{36})(?:;|$)`))?.[1];
const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

type Who = { id: string; email?: string; setCookie?: string };

/** The signed-in workspace, or null when this browser has to sign in first. */
async function workspace(req: Request): Promise<Who | null> {
  const found = cookie(req, COOKIE);
  if (!env.CLERK_ISSUER) {
    if (found) return { id: found };
    const id = crypto.randomUUID();
    return { id, setCookie: setCookie(COOKIE, id, YEAR) };
  }
  const session = found ? await env.OAUTH_KV.get<{ ws: string; email?: string }>(`session:${found}`, "json") : null;
  return session ? { id: session.ws, email: session.email } : null;
}

/** Sends the browser to sign in and remembers where it was going. */
async function signIn(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = crypto.randomUUID();
  // `legacy` is the pre-sign-in cookie workspace, if any, so its connected accounts are kept.
  const verifier = crypto.randomUUID() + crypto.randomUUID(); // PKCE, which Clerk requires
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const pending = { returnTo: url.pathname + url.search, legacy: cookie(req, COOKIE), verifier };
  await env.OAUTH_KV.put(`signin:${state}`, JSON.stringify(pending), { expirationTtl: 600 });
  const to = new URL(`${env.CLERK_ISSUER}/oauth/authorize`);
  to.search = new URLSearchParams({
    client_id: env.CLERK_OAUTH_CLIENT_ID ?? "",
    redirect_uri: signInRedirect(),
    response_type: "code",
    scope: "email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, { status: 302, headers: { Location: to.toString(), "Set-Cookie": setCookie(STATE, state, 600) } });
}

/** Clerk returns here. Starts a session for the user's workspace and resumes what was interrupted. */
async function signInCallback(req: Request): Promise<Response> {
  const fail = (why: string) =>
    new Response(page("Sign-in failed", `<h1>Sign-in failed</h1><p>${esc(why)}</p>`), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  // The state must match this browser's cookie, so a link made in another browser cannot sign this one in.
  if (!state || !code || state !== cookie(req, STATE)) return fail("The sign-in expired or was cancelled. Start again.");
  const pending = await env.OAUTH_KV.get<{ returnTo: string; legacy?: string; verifier: string }>(`signin:${state}`, "json");
  if (!pending) return fail("The sign-in expired. Start again.");
  await env.OAUTH_KV.delete(`signin:${state}`); // single use

  const tokenRes = await fetch(`${env.CLERK_ISSUER}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: env.CLERK_OAUTH_CLIENT_ID ?? "",
      client_secret: env.CLERK_OAUTH_CLIENT_SECRET ?? "",
      redirect_uri: signInRedirect(),
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  const { access_token } = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !access_token) return fail("The sign-in could not be confirmed.");
  const userRes = await fetch(`${env.CLERK_ISSUER}/oauth/userinfo`, { headers: { Authorization: `Bearer ${access_token}` } });
  const user = (await userRes.json().catch(() => ({}))) as { sub?: string; user_id?: string; email?: string };
  const userId = user.sub ?? user.user_id;
  if (!userRes.ok || !userId) return fail("The sign-in could not be confirmed.");

  // ponytail: read then write on KV. Two first sign-ins of one user within KV's propagation
  // window can create two workspaces. Move the user map to D1 if that ever shows up.
  let ws = await env.OAUTH_KV.get(`user:${userId}`);
  if (!ws) {
    ws = pending.legacy ?? crypto.randomUUID();
    await env.OAUTH_KV.put(`user:${userId}`, ws);
  }
  const session = crypto.randomUUID();
  await env.OAUTH_KV.put(`session:${session}`, JSON.stringify({ ws, email: user.email }), { expirationTtl: YEAR });
  const headers = new Headers({ Location: pending.returnTo });
  headers.append("Set-Cookie", setCookie(COOKIE, session, YEAR));
  headers.append("Set-Cookie", setCookie(STATE, "", 0));
  return new Response(null, { status: 302, headers });
}

/** The site's Sign in button. Signs in if needed, then lands on the dashboard. */
async function signInStart(req: Request): Promise<Response> {
  if (!env.CLERK_ISSUER || (await workspace(req))) return Response.redirect(`${env.WEB_ORIGIN}/dashboard`, 302);
  return signIn(req); // comes back to /signin once signed in
}

// ponytail: a plain GET, so another site can sign a visitor out with a link. Nothing is lost
// (accounts hang off the user, not the session). Make it a POST with a token if that changes.
async function signOut(req: Request): Promise<Response> {
  const headers = new Headers({ Location: env.WEB_ORIGIN });
  const session = cookie(req, COOKIE);
  if (env.CLERK_ISSUER && session) {
    await env.OAUTH_KV.delete(`session:${session}`);
    headers.append("Set-Cookie", setCookie(COOKIE, "", 0));
  }
  return new Response(null, { status: 302, headers });
}

/** What the site's header and dashboard show. Readable by the site only, with the session cookie. */
async function me(req: Request): Promise<Response> {
  const headers = {
    "Access-Control-Allow-Origin": env.WEB_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (!env.CLERK_ISSUER) return Response.json({ sign_in: false }, { headers });
  const ws = await workspace(req);
  if (!ws) return Response.json({ sign_in: true, signed_in: false }, { headers });
  const profiles = await Promise.all(
    (await readProfiles(ws.id)).map(async (p, i) => ({
      id: p.id,
      name: p.name,
      default: i === 0,
      // A profile that never touched Zernio has no accounts. null means Zernio could not be asked.
      accounts: p.zernio_id ? await listAccounts(p.zernio_id).catch(() => null) : [],
    })),
  );
  return Response.json({ sign_in: true, signed_in: true, email: ws.email, profiles, api_keys: await listApiKeys(ws.id) }, { headers });
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

function consentPage(d: ConsentDescription, handle: string, email?: string): string {
  const requested = d.scope.filter((s): s is Scope => s in SCOPES);
  const shown = requested.length ? requested : (Object.keys(SCOPES) as Scope[]);
  const name = esc(d.clientName || "An app");
  return page(
    `Authorize ${name}`,
    `<h1>Allow ${name} to use your Distro tools?</h1>
<p>${d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}
Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
${email ? `<p>Signed in as <strong>${esc(email)}</strong>.</p>` : ""}
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
      const ws = await workspace(req);
      if (!ws) {
        return new Response(page("Signed out", "<h1>You were signed out</h1><p>Start connecting again from your agent.</p>"), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const form = await req.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        return new Response(null, { status: 302, headers: (await oauth.denyConsent(req, handle)).headers });
      }
      const approved = await oauth.approveConsent(req, handle, { scope: form.getAll("scope").map(String) });
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
    const who = await workspace(req);
    if (!who) return signIn(req); // comes back to this same URL once signed in
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(details, consent.handle, who.email), { headers: consent.headers });
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
  const ws = await workspace(req);
  if (!ws) return signIn(req);
  let location: string;
  try {
    const url = new URL(req.url);
    const profile = await useProfile(ws.id, url.searchParams.get("profile") ?? undefined);
    location = await connectUrl(profile.zernioId, platform, url.origin);
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

/** DarkUGC returns the browser here after its own sign-in and consent. */
async function darkugcReturn(url: URL): Promise<Response> {
  let body = "<h1>DarkUGC connected</h1><p>You can close this tab and go back to your agent.</p>";
  let status = 200;
  try {
    await darkugcCallback(url);
  } catch (e) {
    status = 400;
    body = `<h1>DarkUGC was not connected</h1><p>${esc(e instanceof Error ? e.message : "Sign-in failed.")}</p>`;
  }
  return new Response(page("DarkUGC", body), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** The form behind connect_keys. The one-time token in the link names the workspace, so it works in any browser. */
async function keysPage(req: Request, url: URL): Promise<Response> {
  const form = req.method === "POST" ? await req.formData() : null;
  const t = form ? form.get("t") : url.searchParams.get("t");
  const ws = await keysLinkWorkspace(t);
  const send = (body: string, status = 200) =>
    new Response(page("Your scraper keys", body), {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  if (!ws) return send("<h1>This link expired</h1><p>Ask your agent for a new one (connect_keys).</p>", 400);
  let note = "";
  if (form) {
    try {
      await saveKeys(ws, form);
      note = "Saved.";
    } catch (e) {
      note = e instanceof Error ? e.message : "Could not save.";
    }
  }
  const own = await userKeys(ws);
  const input = "flex:1;min-width:0;font:inherit;padding:.35rem .6rem;border:1px solid var(--line);border-radius:8px;background:none;color:var(--fg)";
  const rows = KEY_NAMES.map((name) => {
    const saved = own[name];
    return `<label><span style="width:7.5rem">${esc(KEY_SERVICES[name])}</span>
<input type="password" name="${name}" autocomplete="off" style="${input}" placeholder="${saved ? `saved, ends ${esc(saved.slice(-4))}` : "not set"}">
${saved ? `<span><input type="checkbox" name="remove_${name}" value="1"> remove</span>` : ""}</label>`;
  }).join("");
  return send(`<h1>Your scraper keys</h1>
<p>Optional. With your own key for a service, research calls run on your account with no daily limit. Without one, they run on Distro's keys with a daily limit.</p>
${note ? `<p><strong>${esc(note)}</strong></p>` : ""}
<form method="post" action="/keys"><input type="hidden" name="t" value="${esc(String(t))}">${rows}
<div class="row"><button value="approve">Save</button></div></form>`);
}

export const authHandler = {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/authorize") return authorize(req);
    if (url.pathname === "/callback" && env.CLERK_ISSUER) return signInCallback(req);
    if (url.pathname === "/signin") return signInStart(req);
    if (url.pathname === "/signout") return signOut(req);
    if (url.pathname === "/me" && req.method === "GET") return me(req);
    if (url.pathname === "/connect/callback") return connectCallback(url);
    if (url.pathname === "/darkugc/callback") return darkugcReturn(url);
    if (url.pathname === "/keys") return keysPage(req, url);
    const platform = url.pathname.match(/^\/connect\/([a-z]+)$/)?.[1];
    if (platform && req.method === "GET") return connectStart(req, platform);
    const video = url.pathname.match(/^\/videos\/(job_[0-9a-f]{12})\.mp4$/)?.[1];
    if (video && req.method === "GET") return videoFile(video);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/") return Response.redirect(env.WEB_ORIGIN, 302);
    return new Response("Not found", { status: 404 });
  },
};
