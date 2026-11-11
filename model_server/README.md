# Distro video model server

One HTTP endpoint in front of every GMI Cloud video model (101 in the live
catalog, 38 usable for text-to-video at 9:16). Pick any model id, or a tier
(`fast`, `default`, `quality`), and get back an mp4.

## Run

```bash
uv run scripts/sync_gmi_catalog.py   # refresh src/data/gmi-video-models.json (only when GMI adds models)
uv run model_server/app.py           # http://localhost:8787
```

`GMI_API_KEY` comes from the environment or the repo `.env`. Optional:
`GMI_ORG_ID`, `SPEND_CAP_USD` (default 9), `MAX_RENDER_USD` (default 1.00),
`MODEL_SERVER_TOKEN` (require a bearer), `PUBLIC_BASE_URL`, `PORT`.

The deployed Worker cannot reach `localhost`. To call this server from the
Worker, put it behind a public HTTPS URL, for example:

```bash
cloudflared tunnel --url http://localhost:8787
```

Then set `PUBLIC_BASE_URL` to the tunnel URL so `video_url` points there.

## API

| Method | Path | What it does |
|---|---|---|
| `POST` | `/generate` | Start a job. Returns `job_id` immediately. |
| `POST` | `/generate?wait=true` | Same, but waits until the video is ready (default up to 600 s). |
| `GET` | `/jobs/{id}` | Status, cost estimate, `video_url` when ready. |
| `GET` | `/jobs/{id}/video` | The finished mp4. |
| `GET` | `/models` | Selectable models with a 5 s 720p estimate (`?all=true` for every model). |
| `GET` | `/spend` | Cap, committed, reserved, recent ledger entries. |
| `GET` | `/health` | Liveness and catalog date. |

`POST /generate` body (only `prompt` is required):

```json
{
  "model": "default",
  "prompt": "Vertical selfie video, a young adult says: \"why did nobody tell me about this app?\"",
  "duration": 5,
  "aspect": "9:16",
  "resolution": "720p",
  "first_frame": null,
  "audio_url": null,
  "audio": true,
  "dry_run": false
}
```

`dry_run: true` returns the exact GMI payload and the estimate without spending.
Unsupported values are snapped to the nearest option the model offers, and each
change is listed in `warnings`.

Job `status` goes `queued` → `submitted` → `processing` → `downloading` → `ready`,
or ends in `failed` / `timeout`.

## Spend

Each job reserves its list-price estimate before it is submitted. A job is
refused if it would push the total past `SPEND_CAP_USD`, or if it alone costs
more than `MAX_RENDER_USD`. The ledger is saved in `model_server/data/spend.json`,
so the cap survives restarts.

| Outcome | Reserve |
|---|---|
| GMI rejects the request or the job fails | Released (GMI refunds failed jobs) |
| Video is ready | Committed |
| Job times out | Kept, since GMI may still bill it |

The cap matters because GMI keeps generating even when the account balance is
negative.
