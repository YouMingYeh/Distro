# Distro: extended flow notes

Read this only when the main skill body does not cover the situation.

## Missing pieces

| Situation | What to do |
| --- | --- |
| No brand, no site, no description | Ask one bundled question: what is it, who is it for, and is there a site? |
| Site could not be read (`scrape_ok: false`) | Keep the user's notes, ask for two or three sentences, call `set_brand` again with `notes`. |
| No footage uploaded | Research and ranking still work. Before `make_video`, ask the user to drop a few clips (6–10 short clips, 9:16 or close, is ideal). |
| Attachments have no visible local path | Ask the user to resend or paste a path. Do not invent one. |
| Only images were dropped | Upload them; they can serve as an end-card icon or stills. Ask for at least one video clip for the body. |
| All clips are flagged | Tell the user which warnings fired and ask whether to use them anyway or drop different clips. |

## Upload problems

| Symptom | Fix |
| --- | --- |
| `create_upload` refuses the type | Only mp4, mov, webm, m4v, jpg, jpeg, png, webp are allowed. Ask for a supported file. |
| `create_upload` refuses the size | The reply states the limit. Ask for a shorter or more compressed clip. |
| PUT returns 401/403/410 | The slot expired or was already used. Call `create_upload` again and retry. |
| PUT returns 413 | The file is over the limit for this upload mode. Use a smaller file. |
| `analyze_footage` says an asset is missing | The PUT never completed. Upload it again. |
| `analyze_footage` returns `probe_pending` | The file is stored; the probe service was unavailable. It can still be used. |

## Render problems

| Error mentions | Fix |
| --- | --- |
| Spend cap | Offer a shorter `hook_duration_s`, `resolution: "480P"`, or fewer videos. |
| `confirm_usd` | Pass the estimate from the error as `confirm_usd` once the user has agreed. |
| Unknown `hook_id` | Run `rank_hooks` again and use an id from the fresh result. |
| No usable footage | Ask the user to drop clips, or clear a false flag with their consent. |
| Render timed out or failed | Money was released. Retry once; if it fails again, try the next ranked hook. |
| Editor unavailable | The server's edit service is down. Tell the user and retry in a minute. |

## Repeat requests

- "Another one" → `make_video` with the next ranked `hook_id`. Do not re-run
  research or ranking unless the user asks for fresh hooks.
- "Different angle" → `rank_hooks` again, optionally with `seed_hooks` taken
  from the user's own wording.
- "Do this every day" → explain that daily posting runs through the user's own
  scheduler (Buffer or Zernio), show a dry-run `publish` draft, and stop there
  unless a live post is explicitly requested.

## What to say, briefly

- After upload: "8 clips landed. 2 are taller than 9:16 and will be cropped; 5 are silent."
- After research: three patterns, one line each, plus three sample hooks.
- After ranking: the top five hooks, one-line reason each.
- Before render: the estimate and the remaining cap, in dollars.
- After render: preview link, sanity verdict, real cost.
