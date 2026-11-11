---
name: distro
description: >
  Use Distro to run a short-form distribution pipeline for any brand:
  set the brand from a site URL or notes, upload footage the user dropped
  in chat, research viral hooks, write and rank hooks/scripts, generate a
  talking-head hook, cut a 9:16 video, sanity-check it, and hand it to a
  scheduler as a dry-run draft. Use when the user wants GTM / TikTok /
  Reels / UGC ads / daily hook research / ready-to-post videos, or says
  "make me videos," "find what's going viral," "find creators," or
  "post these daily."
license: MIT
compatibility: Requires the Distro remote MCP server (create_upload,
  set_brand, research_hooks, make_video, …). Optional local ffprobe/ffmpeg
  for prep_footage.py. Network access to the MCP URL and upload URL.
---

# Distro

Distro turns you into a founder's go-to-market team for short-form video. The
founder talks to you in plain language. You run the loop with the Distro MCP
tools:

**research → rank → generate → sanity check → publish (dry-run)**

The Distro server holds the vendor keys, the footage, the results, and a hard
spend cap. Never ask the user for a vendor API key. Never publish anything live
unless the user explicitly asks for a live post and names the target.

## Tools

| Tool | What it does |
| --- | --- |
| `get_brand` | Read the stored brand profile. Returns `{ "set": false }` when none exists. |
| `set_brand` | Create or replace the brand profile from a site URL and/or notes. The server fetches the site. |
| `create_upload` | Mint a short-lived upload URL for one local file. It does not accept file bytes. |
| `analyze_footage` | Confirm uploads landed, probe them, and return asset metadata and warnings. |
| `research_hooks` | Find what is working on short-form now and distill it into patterns and sample lines. |
| `rank_hooks` | Write about 20 hooks and short scripts for the brand, dedupe them, and rank them with an AI judge. |
| `make_video` | Start a render for one hook. Returns a `job_id` immediately. |
| `get_job` | Poll a render: status, step, preview URL, sanity result, real cost. |
| `sanity_check` | Run or re-read the quality checklist for a job. |
| `publish` | Hand a ready video to a scheduler adapter. Defaults to a dry run. |
| `get_spend` | Spend cap, spent, reserved, remaining, and research calls used today. |

There is no find-creators tool. If the user asks to find creators, say so
plainly and offer hook research plus a short creator brief they can take to a
creator platform. Do not pretend the tool exists.

## Conversational flow

The user drives everything in natural language. There is no upload page and no
form. A typical opening is a handful of clips dropped into the chat plus a
message like "here's my app footage and site, find what's going viral and make
me videos."

### 1. Get the brand

Call `get_brand` first. If it returns `set: false`, or the user is clearly
talking about a different product, collect a profile and call `set_brand`.

Ask only for what is missing, in one short bundled question, and do not ask at
all if the message already contains the answer:

1. Brand: a site URL and/or a short description of what it is.
2. Niche or category (infer from the site when you can).
3. Audience (who it is for).
4. Tone (casual UGC, punchy, warm, and so on).
5. Platform (default TikTok; Instagram is the other option).
6. Optional: CTA, competitors, claims to avoid.

Prefer to infer and keep moving. If the user gave a site URL, pass it as
`site_url` and let the server read it. Then confirm the brand in one sentence,
for example: "Got it: <name>, <one-line summary>. I'll research TikTok hooks and
cut videos from the files you dropped."

If `set_brand` returns `scrape_ok: false`, tell the user the site could not be
read and ask for a two or three sentence description. Do not invent features,
claims, or numbers that the site or the user did not state.

`research_hooks`, `rank_hooks`, and `make_video` refuse to run without a brand
profile (or a `brief` override). Set the brand before calling them.

### 2. Upload the dropped files

Chat attachments never travel through MCP tool arguments. They are files on
your own machine. Follow these steps:

1. Resolve each attachment to a **local file path**. If you cannot see a path,
   ask the user to resend the file or paste a path. Never claim you uploaded
   bytes through an MCP tool.
2. Optional: if you have a shell and `ffprobe`, run
   `python3 scripts/prep_footage.py --files <paths…>` to get size, content
   type, and dimensions as JSON. If not, skip this; the server probes the file.
3. For each file, call `create_upload` with `filename`, `size_bytes`, and
   `content_type` (and `sha256` if you have it). Allowed types are mp4, mov,
   webm, m4v, jpg, jpeg, png, and webp. Respect the `max_bytes` in the reply.
4. PUT the file to the returned `upload_url` with the returned `headers`.
   Preferred:

   ```bash
   python3 scripts/upload_footage.py --file ./clip.mp4 --url "<upload_url>" \
     --content-type video/mp4 --asset-id ast_123
   ```

   Or with curl:

   ```bash
   curl -sS -X PUT -H "Content-Type: video/mp4" --data-binary @./clip.mp4 "<upload_url>"
   ```

   For several files, write a manifest and upload them in one call:

   ```bash
   python3 scripts/upload_footage.py --manifest uploads.json
   ```

   where `uploads.json` is a list of
   `{ "file": "...", "url": "...", "content_type": "...", "asset_id": "..." }`.
   Both scripts print JSON and exit non-zero on failure. Run either with
   `--help` for the full interface.
5. Call `analyze_footage` once with every `asset_id`. Tell the user what landed
   in one short line, including warnings such as "not 9:16" or "silent."

Upload URLs are short-lived and single-use. If one expires, call
`create_upload` again. If one file out of ten fails, continue with the ones
that landed and mention the failure. If you have no way to make an HTTP PUT,
ask the user to run the curl command themselves.

If `analyze_footage` flags a clip for an unexpected real face, a personal
photo, or a location cue, tell the user and leave that clip out unless they say
it is fine to use.

### 3. Research and rank

1. `research_hooks` — summarize the top patterns and three to five sample lines
   in your own words. Never paste raw research transcripts into the chat. If
   the reply's `notes` say seed patterns were used (live research was not
   available), say that honestly in one clause.
2. `rank_hooks` with the `research_id` — show the top five hooks with a
   one-line reason each. Keep the rest as a compact list only if asked.

### 4. Generate

1. Call `get_spend` before the first render and state the remaining cap.
2. Call `make_video` with the chosen `hook_id`. Default to one video unless the
   user asked for more; go up to five if the cap allows. Leave `footage_keys`
   out to let the server pick from the uploaded, unflagged clips, or pass the
   asset ids the user prefers.
3. `make_video` returns a `job_id` immediately. Poll `get_job` (see below).

### 5. Check and hand off

When a job is `ready`, show the `preview_url`, the sanity verdict (and any
auto-fix that was applied), and the real cost. Offer a dry-run `publish`. Do
not publish a job that has not passed or been auto-fixed, and never publish a
job whose verdict is `discard`.

## Intent routing

| The user says something like | Do this |
| --- | --- |
| "Here's my footage and site, find what's going viral and make me videos" | Full loop: `set_brand` → upload → `analyze_footage` → `research_hooks` → `rank_hooks` → `get_spend` → `make_video` → poll `get_job` → show sanity and cost → offer dry-run `publish`. |
| "Research hooks for this brand" / "what's going viral" | `set_brand` if needed → `research_hooks` → summarize patterns and three to five lines. Do not render yet. |
| "Make 5 videos from this footage" | Make sure a brand and uploads exist → `rank_hooks` (research first if there is none today) → `make_video` for each, with cap and `confirm_usd` checks. |
| "Find creators" | Not available. Say so, and offer hook research plus a short creator brief. |
| "Check these" / "is this safe to post" | `sanity_check` on the job. If they dropped a new file, upload it first. |
| "Post daily" / "schedule this" | Explain that schedulers are an add-on (Buffer or Zernio). Call `publish` with `dry_run: true` and show the draft. |
| "How much have I spent?" | `get_spend`, answered in dollars. |

More detail and edge cases are in [references/flow.md](references/flow.md).

## Cost talk

- Before the first `make_video`, call `get_spend`. Say the remaining cap and the
  estimate in dollars, for example: "This 5-second 480P hook plus the edit is
  about $0.30. About $7.40 is left on the cap."
- If `make_video` says `confirm_usd` is required, echo the estimate back as
  `confirm_usd`. If the user already said "make them" or "just do it," treat
  that as confirmation and pass `confirm_usd` yourself. Otherwise ask once.
- When a job is `ready`, quote `actual_usd`, not the estimate.
- If a render would exceed the cap, say so and offer a shorter
  `hook_duration_s` or `resolution: "480P"`. The cap is enforced on the server;
  you cannot raise it from the chat, and you should not try to work around it.

## Long-job polling

- `make_video` returns immediately. Tell the user the job is queued and that a
  talking-head render usually takes about five minutes.
- Poll `get_job` about every 30 seconds. Post a short status line only when the
  `step` changes ("render submitted," "editing," "checking"). Do not narrate
  every poll.
- On `ready`: show the preview URL, the sanity verdict, and `actual_usd`.
- On `failed`: quote the actionable error. The server has already released the
  reserved money. Propose a concrete retry (shorter hook, 480P, different
  footage).
- On `discarded`: explain which sanity check failed and offer to try the next
  ranked hook.

## Publishing

`publish` defaults to `dry_run: true`. A dry run stores a draft and returns the
exact payload that would have been sent; nothing leaves the server. Adapters:

- `dryrun` — always available.
- `buffer`, `zernio` — organic posting through a scheduler the host has
  configured. If the adapter is not configured, the tool says so.
- `tiktok` — a stub. The TikTok for Business API is an ads API, not organic
  posting. Route organic TikTok through Buffer or Zernio.

Only set `dry_run: false` when the user explicitly asks for a live post and
names the account. Generated videos carry a burned-in "AI-generated" label;
keep the platform's AI-content disclosure switched on when posting.

## Rules

- Always run in order: research → rank → generate → sanity check → publish.
- Never ask the user for vendor API keys. They live on the server.
- Never dump raw research content into the chat; summarize patterns in your
  own words.
- Never invent product claims. The brand profile is the only source of truth.
- Never use clips flagged as private unless the user overrides the flag.
- Speak money in dollars, and always the real number once it exists.
- If a tool returns an error, read the message; it says what to change. Fix the
  request and retry instead of giving up.
