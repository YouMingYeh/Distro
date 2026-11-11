import { createMcpHandler } from "agents/mcp/server";
import { listAssets } from "./db/client";
import { safeJson, ToolError, usd, type Env } from "./env";
import { fileUrl, handleFiles } from "./files/proxy";
import { createUpload, handleUploadPut } from "./files/upload";
import { checkBearer } from "./mcp/auth";
import { createServer, spendView } from "./mcp/tools";
import { DarkUgcClient } from "./adapters/darkugc";
import { getBrand } from "./pipeline/brand";
import { analyzeFootage } from "./pipeline/footage";
import { adaptersConfigured } from "./pipeline/publish";
import { DASHBOARD_HTML } from "./ui/dashboard";

export { GuardrailsDO } from "./guardrails/GuardrailsDO";
export { MakeVideoWorkflow } from "./pipeline/workflow";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });

function baseUrlOf(request: Request, env: Env): string {
  return (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

/** Everything the read-only dashboard shows, in one call. */
async function dashboardState(env: Env, baseUrl: string) {
  const [brand, assets, run, jobs, drafts, spend] = await Promise.all([
    getBrand(env),
    listAssets(env, { includeBanned: true, limit: 24 }),
    env.DB.prepare(`SELECT id,created_at,cost_cents,discarded_json FROM rank_runs ORDER BY created_at DESC LIMIT 1`).first<{ id: string; created_at: string; cost_cents: number; discarded_json: string }>(),
    env.DB.prepare(`SELECT id,hook_id,status,step,estimated_cents,actual_cents,final_r2_key,error,params_json,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT 8`).all<Record<string, any>>(),
    env.DB.prepare(`SELECT id,job_id,adapter,dry_run,payload_json,created_at FROM publish_drafts ORDER BY created_at DESC LIMIT 5`).all<Record<string, any>>(),
    spendView(env, 1),
  ]);
  const hooks = run
    ? ((
        await env.DB.prepare(
          `SELECT h.id,h.hook,h.body,h.cta,h.want_talking_head,s.rank,s.elo,s.pointwise_avg,s.reasons_json
           FROM hooks h JOIN hook_scores s ON s.hook_id=h.id WHERE h.run_id=? ORDER BY s.rank ASC LIMIT 20`,
        )
          .bind(run.id)
          .all<Record<string, any>>()
      ).results ?? [])
    : [];
  const research = await env.DB.prepare(`SELECT id,created_at,calls_used,notes FROM research_runs ORDER BY created_at DESC LIMIT 1`).first<Record<string, any>>();
  const patterns = research ? ((await env.DB.prepare(`SELECT hook_type,format_family,brand_angle FROM patterns WHERE research_id=? LIMIT 8`).bind(research.id).all<Record<string, any>>()).results ?? []) : [];

  return {
    brand: brand ?? { set: false },
    assets: await Promise.all(
      assets.map(async (a) => ({
        id: a.id,
        filename: a.original_filename,
        kind: a.kind,
        width: a.width,
        height: a.height,
        duration_ms: a.duration_ms,
        has_audio: a.has_audio === 1,
        banned: a.banned === 1,
        warnings: safeJson<string[]>(a.warnings_json, []),
        thumb_url: await fileUrl(env, baseUrl, `uploads/${a.id}/thumb.jpg`, 3600),
      })),
    ),
    research: research ? { ...research, patterns } : null,
    rank_run: run ? { id: run.id, created_at: run.created_at, cost_usd: usd(run.cost_cents ?? 0), discarded: safeJson(run.discarded_json, {}) } : null,
    hooks: hooks.map((h) => ({ ...h, reasons: safeJson<string[]>(h.reasons_json, []), reasons_json: undefined })),
    jobs: await Promise.all(
      (jobs.results ?? []).map(async (j) => {
        const sanity = await env.DB.prepare(`SELECT verdict,items_json,actions_json FROM sanity_checks WHERE job_id=? ORDER BY created_at DESC LIMIT 1`).bind(j.id).first<{ verdict: string; items_json: string; actions_json: string }>();
        const hook = j.hook_id ? await env.DB.prepare(`SELECT hook FROM hooks WHERE id=?`).bind(j.hook_id).first<{ hook: string }>() : null;
        const params = safeJson<Record<string, any>>(j.params_json, {});
        return {
          id: j.id,
          hook: hook?.hook ?? null,
          status: j.status,
          step: j.step,
          estimated_usd: usd(j.estimated_cents ?? 0),
          actual_usd: j.actual_cents === null ? null : usd(j.actual_cents),
          preview_url: j.final_r2_key ? await fileUrl(env, baseUrl, j.final_r2_key, 3600) : null,
          error: j.error,
          notes: params.notes ?? [],
          sanity: sanity ? { verdict: sanity.verdict, items: safeJson(sanity.items_json, []), actions: safeJson(sanity.actions_json, []) } : null,
          created_at: j.created_at,
          updated_at: j.updated_at,
        };
      }),
    ),
    drafts: (drafts.results ?? []).map((d) => ({ id: d.id, job_id: d.job_id, adapter: d.adapter, dry_run: d.dry_run === 1, payload: safeJson(d.payload_json, {}), created_at: d.created_at })),
    spend,
    adapters: adaptersConfigured(env),
    integrations: { llm_and_video: Boolean(env.GMI_API_KEY), live_research: DarkUgcClient.configured(env), editor: Boolean(env.FFMPEG_SERVICE_URL), presigned_uploads: Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CLOUDFLARE_ACCOUNT_ID) },
  };
}

async function api(request: Request, env: Env, url: URL, baseUrl: string): Promise<Response> {
  try {
    if (url.pathname === "/api/state" && request.method === "GET") return json(await dashboardState(env, baseUrl));
    if (url.pathname === "/api/spend" && request.method === "GET") return json(await spendView(env, 1));
    if (url.pathname === "/api/uploads" && request.method === "POST") return json(await createUpload(env, baseUrl, await request.json()));
    if (url.pathname === "/api/analyze" && request.method === "POST") return json(await analyzeFootage(env, baseUrl, await request.json()));
    return json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof ToolError) return json({ error: e.message }, 400);
    console.error("api error", e);
    return json({ error: "Internal error. Check the server logs." }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok", { headers: { "Content-Type": "text/plain" } });

    if (request.method === "OPTIONS" && !path.startsWith("/mcp")) {
      return new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type", "Access-Control-Max-Age": "86400" },
      });
    }

    // The dashboard shell is static and holds no data; its /api calls carry the bearer when one is set.
    if (path === "/" || path === "/dashboard") {
      return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    // /files links are fetched by the video model and the editor, which cannot send a
    // bearer header; they are protected by the HMAC signature when FILES_SIGNING_SECRET is set.
    const filesSigned = path.startsWith("/files/") && Boolean(env.FILES_SIGNING_SECRET);
    if (!filesSigned) {
      const denied = checkBearer(request, env);
      if (denied) return denied;
    }

    const baseUrl = baseUrlOf(request, env);
    if (path === "/mcp") {
      // Stateless: a fresh McpServer per request; all state lives in D1 / R2 / the Durable Object.
      return createMcpHandler(() => createServer(env, baseUrl), { route: "/mcp" })(request, env, ctx);
    }
    if (path.startsWith("/files/")) return handleFiles(request, env, url);
    if (path.startsWith("/upload/")) return handleUploadPut(request, env, url);
    if (path.startsWith("/api/")) return api(request, env, url, baseUrl);

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
