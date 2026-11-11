# Distro — coding-agent prompt (paste this)

You are building **Distro**, a self-hostable **agent plugin**: an Agent Skill (`skills/distro/SKILL.md` + helper scripts, [agentskills.io](https://agentskills.io/specification)) plus a remote MCP server on Cloudflare. It replaces a founder’s GTM team. This is a 4-hour hackathon build. **The product is generic.** Do not bake in any specific consumer app, brand name, CTA, hooks, or footage. Brand and footage come from the user in chat (a site URL or description, and files dropped on the agent).

**Read first, in this order, and do not invent a different architecture:**

1. `HACKATHON_BRIEF.md` (event facts). Do not copy it, or its “Internal, don’t ship” note, into the public repo.
2. `DISTRO_BUILD_SPEC.md` — the only source of truth for the build (hard rules in **§0**, tools in §5, chat-drop uploads in **§5.8–5.9** and **§19**, brand profile in **§5.10–5.11**, D1 in §7, skill UX in **§13**, plugin layout in **§4**, smoke tests in §15, timeline in §16, DoD in §17, what Marx must provide in §18, ffmpeg contract in **§20**).
3. `DEMO_STORY.md` — canonical demo walkthrough (≤ 2 min, target 90–110s). Brand is a **[BRAND]** placeholder; Marx picks the app.

If those files are not in the working directory, they live at `/workspace/hackathon/` (same names). `prep/one_connection_research.md` is background only; if it and the spec disagree, follow the spec.

## Hard rules

- **No `git init`, no git repo, no commit (even empty) before 18:45 local time on 2026-11-11.** An earlier commit makes the repo ineligible. After 18:45, create the public GitHub repo and start the first commit, then build.
- **Never** write the event city, country, venue, or any subsidiary in shipped files (repo, README, UI, skill, comments, dashboard, captions, demo).
- **Never** post or publish anything externally without Marx’s explicit OK. `publish` **defaults to dry-run**.
- **Never** commit secrets, `.env`, `.dev.vars`, or raw DarkUGC content (store derived patterns and original lines you generate for the user’s brand only).
- **GMI spend cap in our code**, default **`$9`**. GMI keeps generating at a negative balance; do not trust its balance as the limiter. Do not raise the cap unless Marx says so.
- **TikTok AI-generated label** must be burned into generated videos.
- **No baked-in demo brand.** Do not ship product-specific briefs, ads, hook lines, or media. Sanity checks are generic (unexpected faces, personal photos, location cues, off-brand vs the *user’s* profile).
- Distro itself has **no sign-in** (optional bearer off by default; keep the hosted demo open).

## What to build

A TypeScript Worker on **Workers Paid** (`createMcpHandler`, Streamable HTTP at `/mcp`, export an object `fetch`; **do not use `McpAgent`**). Package the repo as a plugin: `skills/distro/SKILL.md` + `scripts/`, `.claude-plugin/plugin.json`, example `.mcp.json`, and README install steps for Grok Bot, Claude Code, and Codex (mark unverified client syntax as such, then verify).

Tools: `set_brand`, `get_brand`, `create_upload`, `analyze_footage`, `research_hooks`, `rank_hooks`, `make_video` → `job_id`, `get_job`, `sanity_check`, `publish`, `get_spend`. MCP tools **cannot** receive chat attachments; attachments sit as files on the agent’s machine. `create_upload` returns a short-lived upload URL; the skill tells the agent to PUT the dropped file with the helper script or curl, then call `analyze_footage`. Long work is Cloudflare Workflows + poll `get_job` (Wan with `step.sleep("30 seconds")`; do not block a tool on a ~5 minute render). Global Durable Object spend cap and DarkUGC daily call cap. Serve media at `GET /files/<key>` (R2 binding cannot mint signed URLs). **Default editor** is an HTTP `POST /edit` ffmpeg service with a **public HTTPS** URL (`FFMPEG_SERVICE_URL`, §20); the Worker cannot reach `localhost` — typically a `cloudflared` tunnel. Optional skill script may run local ffprobe/thumbnails if the agent has a shell; that is prep, not the editor. DarkUGC has **no documented API key**; the Worker is an MCP *client* of `https://darkugc.com/mcp` (OAuth / token secrets) with generic seed-pattern fallback and a daily call cap. Do not invent `DARKUGC_API_KEY`. Organic publish goes through Buffer and/or Zernio; **stub** `tiktok` (Ads API ≠ organic posting). Wan 3.0 `audio_url` is documented but untested; try once, mux TTS in ffmpeg if it fails.

Ship a README with self-host steps, plugin install steps, and a working `.env.example`. Publishing a Grok Bot *shareable template* is out of scope for you; the skill folder and MCP URL in the README are in scope.

## At 18:45

Run the **§15 smoke tests before writing features**: clock/git, Workers Paid, hello `/mcp`, optional bearer then leave it unset, `GET /v1/models` and pin IDs, Workflow sleep-poll, DO cap, `/files` proxy, **`create_upload` + a real PUT** (Worker route, and presigned S3 if R2 API tokens are set), ffmpeg HTTP + public URL, one DarkUGC handshake or seed fallback, then a 5s 480P Wan + TTS test.

**Never cut:** the pipeline, the $9 spend cap, chat-drop upload, `set_brand`, one real finished 9:16 video, a working MCP connection, the skill + README + `.env.example`, dry-run `publish`. **Cut first:** the dashboard, cron, find-creators, Containers, WhisperX, Claude marketplace polish.

When done, report the repo URL, the deployed MCP URL, the real cost of the demo video, and anything still blocked on Marx.
