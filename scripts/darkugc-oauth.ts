#!/usr/bin/env node
/**
 * One-time OAuth sign-in so the Distro Worker can act as an MCP client of
 * the DarkUGC remote MCP server.
 *
 *   node scripts/darkugc-oauth.ts            # sign in, write tokens to .dev.vars
 *   node scripts/darkugc-oauth.ts --verify   # also run initialize + tools/list + one get_search_filters call
 *   node scripts/darkugc-oauth.ts --print-wrangler
 *
 * Token values are written to .dev.vars (gitignored, mode 600) and are never
 * printed. Node built-ins only.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

const SECRET_NAMES = ["DARKUGC_ACCESS_TOKEN", "DARKUGC_REFRESH_TOKEN", "DARKUGC_TOKEN_ENDPOINT", "DARKUGC_CLIENT_ID"];
const WAIT_MS = 5 * 60 * 1000;

const HELP = `Usage: node scripts/darkugc-oauth.ts [options]

One-time OAuth (authorization code + PKCE) against the DarkUGC MCP server.
Writes DARKUGC_ACCESS_TOKEN, DARKUGC_REFRESH_TOKEN (if issued),
DARKUGC_TOKEN_ENDPOINT and DARKUGC_CLIENT_ID to the env file. Never prints tokens.

Options:
  --mcp-url URL       MCP endpoint (default: $DARKUGC_MCP_URL or https://darkugc.com/mcp)
  --client-id ID      Use this client id instead of dynamic client registration
  --port N            Local callback port (default: random free port)
  --env-file PATH     File to update (default: .dev.vars)
  --no-open           Do not open the browser; just print the URL
  --verify            After sign-in: one initialize, one tools/list, one get_search_filters call
  --print-wrangler    Print the "npx wrangler secret put <NAME>" commands (names only) and exit
  --help              Show this help
`;

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    if (["help", "no-open", "verify", "print-wrangler"].includes(k)) out[k] = true;
    else out[k] = argv[++i] ?? "";
  }
  return out;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function discover(mcpUrl: string) {
  let resourceMetaUrl: string | null = null;
  let scope: string | null = null;
  try {
    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      signal: AbortSignal.timeout(15000),
    });
    const www = r.headers.get("www-authenticate") ?? "";
    resourceMetaUrl = www.match(/resource_metadata="([^"]+)"/)?.[1] ?? null;
    scope = www.match(/scope="([^"]+)"/)?.[1] ?? null;
    await r.body?.cancel();
  } catch {
    /* fall back to well-known */
  }
  const origin = new URL(mcpUrl).origin;
  const prm = (await getJson(resourceMetaUrl ?? `${origin}/.well-known/oauth-protected-resource`)) ?? {};
  const issuer: string = prm.authorization_servers?.[0] ?? origin;
  const asm =
    (await getJson(`${new URL(issuer).origin}/.well-known/oauth-authorization-server`)) ??
    (await getJson(`${new URL(issuer).origin}/.well-known/openid-configuration`));
  if (!asm?.authorization_endpoint || !asm?.token_endpoint) throw new Error(`Could not discover OAuth metadata for ${issuer}`);
  const supported: string[] = asm.scopes_supported ?? prm.scopes_supported ?? [];
  const scopes = new Set((scope ?? (prm.scopes_supported ?? []).join(" ")).split(/\s+/).filter(Boolean));
  if (supported.includes("offline_access")) scopes.add("offline_access");
  return { resource: (prm.resource as string) ?? mcpUrl, asm, scope: [...scopes].join(" ") };
}

function upsertEnv(file: string, values: Record<string, string>) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = line;
    else {
      if (lines.length && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, line);
      else lines.push(line);
    }
  }
  let text = lines.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function rpc(mcpUrl: string, token: string, sessionId: string | null, body: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const type = r.headers.get("content-type") ?? "";
  const text = await r.text();
  let msg: any = null;
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (m && (m.result !== undefined || m.error !== undefined)) msg = m;
      } catch {
        /* skip */
      }
    }
  } else if (text) {
    try {
      msg = JSON.parse(text);
    } catch {
      /* leave null */
    }
  }
  return { status: r.status, type, sessionId: r.headers.get("mcp-session-id"), msg };
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v && typeof v === "object") return `object(${Object.keys(v as object).length} keys)`;
  return typeof v;
}

async function verify(mcpUrl: string, token: string) {
  console.log("\nVerify (one initialize, one tools/list, one get_search_filters):");
  const init = await rpc(mcpUrl, token, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "distro", version: "0.1.0" } },
  });
  console.log(`  initialize: HTTP ${init.status}, content-type=${init.type}, session-id=${init.sessionId ? "yes" : "no"}, protocol=${init.msg?.result?.protocolVersion}, server=${JSON.stringify(init.msg?.result?.serverInfo)}`);
  // tools/list sent WITHOUT notifications/initialized to learn whether it is required.
  const list = await rpc(mcpUrl, token, init.sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (list.msg?.result?.tools ?? []).map((t: any) => t.name);
  console.log(`  tools/list: HTTP ${list.status}, content-type=${list.type}, tools=${names.length} [${names.join(", ")}]${list.msg?.error ? ", error=" + JSON.stringify(list.msg.error) : ""}`);
  const call = await rpc(mcpUrl, token, init.sessionId, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_search_filters", arguments: {} },
  });
  const res = call.msg?.result;
  console.log(`  tools/call: HTTP ${call.status}, content-type=${call.type}${call.msg?.error ? ", error=" + JSON.stringify(call.msg.error) : ""}`);
  if (res) {
    console.log(`    result keys: ${Object.keys(res).join(", ")}; isError=${res.isError}`);
    const content = res.content ?? [];
    console.log(`    content: ${content.map((c: any) => `${c.type}(${typeof c.text === "string" ? c.text.length + " chars" : "-"})`).join(", ")}`);
    let payload: any = res.structuredContent;
    let from = "structuredContent";
    if (payload === undefined && typeof content[0]?.text === "string") {
      try {
        payload = JSON.parse(content[0].text);
        from = "content[0].text parsed as JSON";
      } catch {
        from = "content[0].text is NOT JSON (plain text/markdown)";
      }
    }
    console.log(`    payload source: ${from}`);
    if (payload && typeof payload === "object") {
      for (const [k, v] of Object.entries(payload)) console.log(`      ${k}: ${describe(v)}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(HELP);
  if (args["print-wrangler"]) {
    console.log("# Run each and paste the value from .dev.vars when prompted:");
    for (const n of SECRET_NAMES) console.log(`npx wrangler secret put ${n}`);
    return;
  }
  const mcpUrl = String(args["mcp-url"] || process.env.DARKUGC_MCP_URL || "https://darkugc.com/mcp");
  const envFile = resolve(String(args["env-file"] || ".dev.vars"));

  const { resource, asm, scope } = await discover(mcpUrl);
  console.log(`Authorization server: ${asm.issuer ?? new URL(asm.authorization_endpoint).origin}`);
  console.log(`Scope: ${scope || "(none)"}`);

  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  let resolveCode: (v: { code: string }) => void = () => {};
  let rejectCode: (e: Error) => void = () => {};
  const codePromise = new Promise<{ code: string }>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const err = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    const ok = !err && code && u.searchParams.get("state") === state;
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>${ok ? "Signed in. You can close this tab." : "Sign-in failed."}</h2></body></html>`);
    if (ok) resolveCode({ code: code! });
    else rejectCode(new Error(err ? `Authorization error: ${err} ${u.searchParams.get("error_description") ?? ""}` : "State mismatch or missing code"));
  });
  await new Promise<void>((r) => server.listen(Number(args.port) || 0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    let clientId = args["client-id"] ? String(args["client-id"]) : "";
    if (!clientId) {
      if (!asm.registration_endpoint) throw new Error("Server has no dynamic client registration; pass --client-id.");
      const r = await fetch(asm.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "Distro (self-hosted)",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope,
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.client_id) throw new Error(`Client registration failed: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      clientId = j.client_id;
      console.log("Registered a public client.");
    }

    const auth = new URL(asm.authorization_endpoint);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("code_challenge", challenge);
    auth.searchParams.set("code_challenge_method", "S256");
    auth.searchParams.set("state", state);
    auth.searchParams.set("resource", resource);
    if (scope) auth.searchParams.set("scope", scope);

    console.log(`\nOpen this URL to sign in (waiting up to 5 minutes):\n${auth.toString()}\n`);
    if (!args["no-open"]) {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const cmdArgs = process.platform === "win32" ? ["/c", "start", "", auth.toString()] : [auth.toString()];
      try {
        spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      } catch {
        /* URL is printed above */
      }
    }

    const timer = setTimeout(() => rejectCode(new Error("Timed out after 5 minutes waiting for sign-in.")), WAIT_MS);
    const { code } = await codePromise;
    clearTimeout(timer);

    const tr = await fetch(asm.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource,
      }),
    });
    const tok: any = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.access_token) {
      throw new Error(`Token exchange failed: HTTP ${tr.status} ${String(tok.error ?? "")} ${String(tok.error_description ?? "")}`);
    }

    const values: Record<string, string> = {
      DARKUGC_ACCESS_TOKEN: tok.access_token,
      DARKUGC_TOKEN_ENDPOINT: asm.token_endpoint,
      DARKUGC_CLIENT_ID: clientId,
    };
    if (tok.refresh_token) values.DARKUGC_REFRESH_TOKEN = tok.refresh_token;
    upsertEnv(envFile, values);

    console.log(`Wrote ${Object.keys(values).join(", ")} to ${envFile} (mode 600).`);
    console.log(
      `access_token: ${tok.access_token.length} chars, token_type=${tok.token_type ?? "?"}, expires_in=${tok.expires_in ?? "not stated"}s, ` +
        `scope=${tok.scope ?? "not stated"}, refresh_token: ${tok.refresh_token ? tok.refresh_token.length + " chars" : "not issued"}`,
    );
    console.log("For production, run: node scripts/darkugc-oauth.ts --print-wrangler");

    if (args.verify) await verify(mcpUrl, tok.access_token);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
  },
);
