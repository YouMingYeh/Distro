import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ToolError, usd, utcDay, type Env } from "../env";
import { createUpload } from "../files/upload";
import { guard } from "../guardrails/spend";
import { getBrand, setBrand } from "../pipeline/brand";
import { analyzeFootage } from "../pipeline/footage";
import { jobView, startVideo } from "../pipeline/generate";
import { publish } from "../pipeline/publish";
import { rankHooks } from "../pipeline/rank";
import { researchHooks } from "../pipeline/research";
import { sanityCheckTool } from "../pipeline/sanity";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Small structured JSON on success; an actionable message (never a stack trace) on failure. */
async function run(name: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn()) }] };
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
    console.error(`tool ${name} failed`, e);
    const brief = String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 240);
    return { content: [{ type: "text", text: `${name} failed: ${brief}. Try again; if it keeps failing, check the server logs.` }], isError: true };
  }
}

export async function spendView(env: Env, days = 1) {
  const g = guard(env);
  const state = await g.getState(utcDay());
  const since = new Date(Date.now() - Math.min(30, Math.max(1, days)) * 86_400_000).toISOString();
  const entries = await g.entries({ since, limit: 40 });
  return {
    cap_usd: usd(state.cap_cents),
    spent_usd: usd(state.spent_cents),
    reserved_usd: usd(state.reserved_cents),
    remaining_usd: usd(state.remaining_cents),
    max_render_usd: usd(state.max_render_cents),
    darkugc_calls_today: state.darkugc_today,
    darkugc_daily_cap: state.darkugc_daily_cap,
    entries: entries.map((e) => ({ at: e.at, kind: e.kind, usd: usd(e.cents), job_id: e.job_id, model: e.model, note: e.note })),
  };
}

const platform = z.enum(["TikTok", "Instagram"]);

/** Tools are registered in a fixed order so tools/list is deterministic. */
export function createServer(env: Env, baseUrl: string): McpServer {
  const server = new McpServer({ name: "distro", version: "0.1.0" });

  server.registerTool(
    "set_brand",
    {
      title: "Set brand",
      description:
        "Create or replace the brand profile that all research, hooks, and checks are based on. Pass a site_url (the server fetches and reads it) and/or notes. At least one of name, site_url, or notes is required. Call this before research_hooks, rank_hooks, or make_video.",
      inputSchema: z.strictObject({
        name: z.string().max(120).optional(),
        site_url: z.string().max(500).optional().describe("Official site or store URL to read."),
        notes: z.string().max(4000).optional().describe("User-supplied brief, positioning, and anything the site misses."),
        niche: z.string().max(200).optional(),
        audience: z.string().max(400).optional(),
        tone: z.string().max(200).optional(),
        platform: platform.optional(),
        cta: z.string().max(200).optional(),
        competitors: z.array(z.string().max(120)).max(10).optional(),
        avoid_claims: z.array(z.string().max(200)).max(20).optional(),
      }),
    },
    (args) => run("set_brand", () => setBrand(env, args)),
  );

  server.registerTool(
    "get_brand",
    { title: "Get brand", description: "Return the stored brand profile, or { set: false } if none exists yet.", inputSchema: z.strictObject({}) },
    () => run("get_brand", async () => (await getBrand(env)) ?? { set: false }),
  );

  server.registerTool(
    "create_upload",
    {
      title: "Create upload slot",
      description:
        "Get a short-lived upload URL for ONE file that exists on your machine (for example a chat attachment). This tool does not accept file bytes. After it returns, HTTP PUT the file to upload_url with the returned headers (use the skill's upload_footage.py or `curl -X PUT -H 'Content-Type: <type>' --data-binary @FILE '<upload_url>'`), then call analyze_footage with the asset_id. Allowed: mp4, mov, webm, m4v, jpg, jpeg, png, webp.",
      inputSchema: z.strictObject({
        filename: z.string().min(1).max(255).describe("Original filename, used only for extension and display."),
        size_bytes: z.number().int().min(1),
        content_type: z.string().max(100),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe("Optional hex digest for reuse of a pending slot."),
      }),
    },
    (args) => run("create_upload", () => createUpload(env, baseUrl, args)),
  );

  server.registerTool(
    "analyze_footage",
    {
      title: "Analyze footage",
      description:
        "Confirm uploads landed, probe them (size, duration, audio), screen them for unexpected faces, personal photos and location cues, and register them as usable footage. Call after PUTting files from create_upload. Flagged clips are excluded from videos; pass override_flags: true only if the user confirms the flagged clips are fine to use.",
      inputSchema: z.strictObject({
        asset_ids: z.array(z.string()).min(1).max(24),
        notes: z.string().max(1000).optional().describe("Optional user description of the batch."),
        override_flags: z.boolean().optional().describe("Clear privacy flags on these assets after the user confirmed them."),
      }),
    },
    (args) => run("analyze_footage", () => analyzeFootage(env, baseUrl, args)),
  );

  server.registerTool(
    "research_hooks",
    {
      title: "Research hooks",
      description:
        "Research what is working on short-form video right now and distill it into original hook patterns plus fresh sample lines for the current brand. Uses the server's live research connection when available (counts against a daily call cap); otherwise falls back to generic seed patterns and says so in notes. Requires a brand profile (set_brand) or a brief.",
      inputSchema: z.strictObject({
        brief: z.string().max(4000).optional().describe("Optional product brief override. If omitted, the stored brand profile is used."),
        platform: platform.optional(),
        posted_within_days: z.number().int().min(7).max(90).optional(),
        max_calls: z.number().int().min(1).max(30).optional().describe("Hard-capped by the remaining daily research budget. Default 12."),
        competitor_brands: z.array(z.string().max(120)).max(10).optional().describe("Defaults to the competitors in the brand profile."),
      }),
    },
    (args) => run("research_hooks", () => researchHooks(env, args)),
  );

  server.registerTool(
    "rank_hooks",
    {
      title: "Rank hooks",
      description:
        "Generate about 20 hook + body + CTA scripts for the current brand, remove unsafe ones and near-duplicates, score them with an AI judge, run a pairwise tournament on the finalists, and return the top 5 in full plus a compact leaderboard. Costs a few cents. Takes roughly 30 to 60 seconds.",
      inputSchema: z.strictObject({
        research_id: z.string().optional().describe("From research_hooks. Defaults to the most recent research run."),
        brief: z.string().max(4000).optional(),
        n: z.number().int().min(5).max(40).optional().describe("How many candidates to generate. Default 20."),
        seed_hooks: z.array(z.string().max(300)).max(20).optional(),
      }),
    },
    (args) => run("rank_hooks", () => rankHooks(env, args)),
  );

  server.registerTool(
    "make_video",
    {
      title: "Make video",
      description:
        "Start a finished 9:16 video for one ranked hook: voiceover, talking-head hook, body cut from uploaded footage, captions, CTA end card and AI-generated label, then an automatic sanity check. Returns immediately with a job_id; poll get_job (about every 30 seconds; a talking-head render takes about 5 minutes). Call get_spend first and tell the user the estimate. If the estimate is at or above the confirmation threshold the call is refused with the amount: call again with confirm_usd set to it once the user agrees.",
      inputSchema: z.strictObject({
        hook_id: z.string(),
        footage_keys: z.array(z.string()).max(12).optional().describe("Asset ids or R2 keys. If omitted, footage is picked from the hook's hints and recent uploads, skipping flagged assets."),
        body_asset: z.string().optional().describe("Asset id or R2 key to lead the body, or 'auto'."),
        resolution: z.enum(["480P", "720P"]).optional().describe("Default 480P."),
        hook_duration_s: z.number().int().min(3).max(8).optional().describe("Default: sized to the hook line, 3 to 8 seconds."),
        confirm_usd: z.number().optional().describe("Echo of the estimate, required when the estimate needs confirmation."),
      }),
    },
    (args) => run("make_video", () => startVideo(env, baseUrl, args)),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: "Status of a make_video job: status, current step, estimated and actual cost, preview_url of the finished video, and the sanity report. Statuses: queued, running, waiting_render, editing, checking, ready, failed, discarded.",
      inputSchema: z.strictObject({ job_id: z.string() }),
    },
    (args) => run("get_job", () => jobView(env, baseUrl, args.job_id)),
  );

  server.registerTool(
    "sanity_check",
    {
      title: "Sanity check",
      description:
        "Re-run the pre-publish checklist on a finished job (or on a file by r2_key): aspect, length, captions, audio, hook match, off-brand claims, private content, AI label, and flagged sources. Returns pass/fail per item and a verdict of pass, fixed, or discard.",
      inputSchema: z.strictObject({ job_id: z.string().optional(), r2_key: z.string().optional(), hook_id: z.string().optional() }),
    },
    (args) => run("sanity_check", () => sanityCheckTool(env, baseUrl, args)),
  );

  server.registerTool(
    "publish",
    {
      title: "Publish (dry-run by default)",
      description:
        "Hand a ready video to a scheduler adapter. dry_run defaults to true: it records a draft and returns exactly what would be sent, and posts nothing. Only set dry_run to false when the user has explicitly asked for a live post. Refuses videos that failed the sanity check. The tiktok adapter is a stub; use buffer or zernio for organic TikTok.",
      inputSchema: z.strictObject({
        job_id: z.string(),
        adapter: z.enum(["dryrun", "buffer", "zernio", "tiktok"]).optional().describe("Default dryrun."),
        dry_run: z.boolean().optional().describe("Default true."),
        caption: z.string().max(2000).optional(),
        schedule_at: z.string().optional().describe("ISO-8601. Ignored unless dry_run is false and the adapter supports it."),
      }),
    },
    (args) => run("publish", () => publish(env, baseUrl, args)),
  );

  server.registerTool(
    "get_spend",
    {
      title: "Get spend",
      description: "Spend cap status in USD: cap, spent, reserved, remaining, the per-render limit, today's research call count, and recent ledger entries. Call before make_video and quote the remaining amount.",
      inputSchema: z.strictObject({ days: z.number().int().min(1).max(30).optional() }),
    },
    (args) => run("get_spend", () => spendView(env, args.days ?? 1)),
  );

  return server;
}
