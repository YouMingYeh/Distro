# Distro: notes for coding agents

Distro is an agent plugin: an Agent Skill plus one remote MCP server.

## Using Distro

- Load the skill at `skills/distro/SKILL.md` and follow it. It covers the
  conversational flow, how to upload files the user dropped in chat, tool
  order, cost talk, and polling.
- Connect the MCP server. The URL ends in `/mcp` and uses Streamable HTTP with
  no sign-in by default. See `.mcp.json` for the config shape and the README
  for per-client install steps.
- Tool order is always: research → rank → generate → sanity check → publish
  (dry-run).
- Files dropped in chat are local files. Call `create_upload`, PUT the file
  with `skills/distro/scripts/upload_footage.py`, then call `analyze_footage`.

## Working on this repo

- Never commit secrets: no `.env`, no `.dev.vars`, no wrangler secret values.
  `.env.example` lists names only.
- Never commit footage, rendered videos, or raw third-party research content.
  `fixtures/` holds generic pattern types only.
- Do not bake a specific brand into code, prompts, fixtures, or docs. The
  brand comes from `set_brand` at runtime.
- `publish` must keep `dry_run: true` as its default, and the spend cap in the
  Durable Object must stay in front of every paid call.
- The Worker entry is `src/index.ts`. The D1 schema lives in `migrations/`.
  The edit service is `scripts/ffmpeg-service.mjs`.
