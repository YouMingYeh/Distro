# Distro: demo story (≤ 2 minutes, target 90–110s)

This is the **canonical** walkthrough for the recorded demo and the live judging pass. It supersedes `prep/demo_script_distro_90s.md`.

Hard cap: **2:00** on Loom or YouTube. Target: **90–110s**. The timed script below lands near 1:50–1:58; if you run long, trim Insight and Add-on, never the proof, the chat-drop, or the cost number.

One-line pitch: **Every founder can now build a product in a weekend. Nobody can afford a GTM expert. Distro turns a founder, or a $15-an-hour hire, into one — a skill plus one MCP URL you add to your agent.**

RFS: "The $15-an-Hour Expert."

**The product is generic.** There is no baked-in demo brand. In the script, replace **[BRAND]** with whatever app Marx chooses that day. Brand and context come from the chat: a site URL (or a short description) and raw footage dropped into the agent. Do not mention a city, country, venue, or subsidiary. Do not show keys or secrets on screen.

## The story arc

1. **Pain.** We build consumer apps. Building is no longer the hard part. Distribution is.
2. **Why it's hard.** The meta is short-form video, but it needs research, creators, editors and a daily routine. A small team can't afford a growth team.
3. **Insight.** The growth team is a loop: research what's viral, write hooks, make videos, check quality, post. An agent can run that loop if it has the right tools.
4. **Product.** Distro is a harness you install as a plugin: a Skill that teaches the agent the loop, plus one remote MCP URL that runs the tools, keys, spend cap and storage on our side (or on a self-hosted Worker).
5. **Proof.** Live, in natural language: drop raw app footage into the chat, paste the site, say "find what's going viral and make me videos." Distro researches, ranks, generates, sanity-checks, and shows a ready-to-post 9:16 video with the real cost. Dashboard (if built) updates side by side.
6. **Why it wins.** Costs cents to dollars per video against a salary. Add our URL, or self-host in minutes. Schedulers you already use are an add-on.

## Script with timing and screen

**0:00-0:15 PAIN** (screen: a generic phone / TikTok feed, not a branded splash you have to explain)
"We're consumer app builders. Building the product used to be the hard part. Now it's distribution. Everyone knows the answer is short-form video, but doing it takes research, creators, editors and a team running it every single day. As a small team, we can't afford one."

**0:15-0:25 INSIGHT** (screen: simple loop diagram: research, hooks, video, check, post)
"But a growth team is just a loop. Research what's viral, write hooks, make the videos, check them, post them. An agent can run that loop, if it has the right tools."

**0:25-0:38 PRODUCT** (screen: agent chat — add the Distro MCP URL, skill already installed)
"So we built Distro. It's a plugin for your agent: one Skill, one URL. Add it to Grok Bot, Claude, Codex, anything that speaks MCP, and your agent becomes your GTM team. Keys and the spend cap stay on the server."

**0:38-0:55 DROP + ASK** (screen: drag 6–10 raw clips into the chat, paste https://[BRAND-SITE], type the line below)
"You don't upload to a dashboard. You drop your footage in the chat and talk like a founder."
Type, naturally: **"Here's my app footage and the site. Find what's going viral and make me videos."**
(The agent may ask one short clarifying question only if niche, audience, tone, or platform is still missing. Prefer to infer from the site and keep moving.)

**0:55-1:10 RESEARCH + RANK** (screen: chat replies + dashboard hook board, if built)
"Distro researches what's working on short-form right now, writes hooks for [BRAND], removes duplicates, and an AI judge ranks them. These are today's winners."

**1:10-1:25 GENERATE** (screen: footage thumbs, talking-head hook, captions; cost counter)
"Then it cuts the footage we just dropped, generates the talking-head hook, adds the voice, captions and sound. This one cost [real cost]."

**1:25-1:38 SANITY CHECK** (screen: checklist, green ticks, one auto-fix)
"Before anything ships, Distro checks its own work: format, captions, audio, hook matches script, nothing private or off-brand, AI label on. Failures get fixed or thrown out."

**1:38-1:48 ADD-ON** (screen: Buffer / Zernio dry-run draft — not a built-in scheduler product)
"It plugs into whatever scheduler you already use. Say 'post these every day,' and it does."

**1:48-1:58 CLOSE** (screen: Distro wordmark, GitHub URL, hosted MCP URL)
"A founder, or a $15-an-hour hire, becomes a GTM expert. Add our URL, or self-host it in minutes. Distro. Never worry about distribution."

## What Marx should prepare (he picks the app)

The product has no default brand. Marx decides which app to show. Minimum for a convincing drop:

- **A site URL** (or, if there is no site, a 2–3 sentence product description, audience, and CTA).
- **6–10 raw clips**, preferably 9:16 or close, a few seconds to ~20s each. A mix of app screen recordings and, if available, one talking-head or lifestyle beat. Phone recordings that are slightly taller than 9:16 are fine — the editor crops. Prefer individual files **under ~40 MB** when you can; the uploader can handle larger (sample recordings in the rehearsal set reached ~90 MB), but a live demo should not wait on a 1 GB folder.
- Optional but useful: a logo or app icon, and a one-line CTA ("Download free on iOS and Android," or whatever is true).

**Rehearsal footage already on the Grok Bot computer** (`/workspace/hackathon/footage/`, 41 organized files from a consumer social app) may be used if Marx chooses that app. Treat it as just "a consumer app." Do not name it as Distro's product, do not ship it in the repo, and do not hard-code its hooks or CTA. If using that set, drop a short subset into chat (ready 9:16 bodies and a handful of highlights), and skip clips with unexpected real faces, personal photos, or location cues.

## How to record / run it

- Drive the whole demo in **natural language**. No "go to the upload page." The chat is the UI; the dashboard is a read-only window (cut it if needed).
- Show the **hosted MCP URL** connected in the agent, and the read-only dashboard (if built) **side by side**. If the dashboard was cut, the chat alone is enough; speak `get_spend` and show the `/files` preview.
- The finished 9:16 product video is **pre-rendered** (a Wan render takes about 5 minutes). Show the live drop, research, and ranking, then cut to the finished file when you reach generate. Keep the same clips you drop in the chat in a hidden R2 backup so a failed live upload does not kill the take.
- Keep a fallback cut at `videos/demo/fallback_final.mp4` (hook + body + captions + AI label). Use it if the live job is not ready. Be honest if that cut was assembled offline.
- Fill in the real cost number from the first full pipeline run (`actual_usd`).
- `publish` stays a dry-run. Do not post live.
- Sanity rules are generic: reject unexpected real faces, personal photos, and location cues. Do not show private photos on stage.
- Don't mention location or any subsidiary. Don't show keys, tokens, `.env`, or wrangler secrets.
- Upload to Loom or YouTube; the limit is 2 minutes. Submit with the public GitHub repo URL before judging at 22:45 local time.
