# Model server: usage

One HTTP endpoint that turns a prompt into a short video with any GMI Cloud video
model. Pick a model id or a tier (`fast`, `default`, `quality`), and get back an mp4.
It covers 101 GMI video models; 38 of them do text-to-video at 9:16.

- Deployed: `https://distro-model-417048709195.asia-east1.run.app` (Cloud Run)
- Code: `model_server/` (Python, FastAPI)
- Model catalog: `src/data/gmi-video-models.json`

## Quick start

```bash
export MODEL_SERVER=https://distro-model-417048709195.asia-east1.run.app
export MODEL_SERVER_TOKEN=...   # ask the owner; never commit it

curl -s "$MODEL_SERVER/generate?wait=true" \
  -H "Authorization: Bearer $MODEL_SERVER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model": "fast", "prompt": "Vertical selfie video, a young adult says: why did nobody tell me about this app?"}'
```

About 40 seconds later the response has `"status": "ready"` and a `video_url`. Download
it with the same `Authorization` header.

## Auth

The URL is public, so the token is the only gate. Every route except `/health` needs:

```
Authorization: Bearer <MODEL_SERVER_TOKEN>
```

Without it, or with a wrong one, the server answers `401`. The token lives in GCP
Secret Manager as `model-server-token` in project `distro-model-66ada6`. Share it
privately (not in the repo, issues or chat logs). In a Cloudflare Worker, store it
with `wrangler secret put MODEL_SERVER_TOKEN`.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/generate` | Start a job. Returns the job immediately. |
| `POST` | `/generate?wait=true` | Same, but waits until the video is ready (`wait_timeout`, default 600 s). |
| `GET` | `/jobs/{id}` | Job status, cost, and `video_url` when ready. |
| `GET` | `/jobs/{id}/video` | The finished mp4. |
| `GET` | `/models` | Selectable models with a 5 s 720p price estimate. `?all=true` lists every video model. |
| `GET` | `/spend` | Spend cap, committed, reserved, recent ledger entries. |
| `GET` | `/health` | Liveness and catalog date. No token needed. |

## Request

`POST /generate` takes JSON. Only `prompt` is required.

| Field | Default | Meaning |
|---|---|---|
| `model` | `"default"` | A model id from `/models`, or a tier: `fast`, `default`, `quality`. |
| `prompt` | (required) | What the video shows and what the person says. |
| `duration` | `5` | Seconds, 1–30. Snapped to the nearest length the model offers. |
| `aspect` | `"9:16"` | Aspect ratio. |
| `resolution` | `"720p"` | Snapped to the nearest resolution the model offers. |
| `negative_prompt` | none | What to avoid, if the model supports it. |
| `first_frame` | none | Public image URL to start from (image-to-video). |
| `last_frame` | none | Public image URL to end on, if supported. |
| `audio_url` | none | Public wav/mp3 that drives lip sync. Only Wan models support it. |
| `audio` | `true` | Generate an audio track where the model has a switch. |
| `seed` | none | Fixed seed, if supported. |
| `dry_run` | `false` | Return the exact GMI payload and price estimate without spending. |

Any value a model does not support is changed to its nearest option, and each change is
listed in the response's `warnings`. Check with `dry_run: true` first when trying a
new model.

## Response

`POST /generate` and `GET /jobs/{id}` return the same job object:

```json
{
  "job_id": "job_c52622b52ec1",
  "model": "gemini-omni-1.2-flash",
  "status": "ready",
  "est_usd": 0.35,
  "duration_s": 5.0,
  "warnings": [],
  "payload": {"prompt": "...", "durationSeconds": "5", "aspectRatio": "9:16", "resolution": "720p", "task": "text_to_video"},
  "gmi_request_id": "...",
  "gmi_status": "success",
  "gmi_video_url": "https://storage.googleapis.com/...",
  "video_url": "https://distro-model-417048709195.asia-east1.run.app/jobs/job_c52622b52ec1/video",
  "elapsed_s": 50.2,
  "error": null
}
```

- `status` goes `queued` → `submitted` → `processing` → `downloading` → `ready`, or ends
  in `failed` or `timeout`.
- Use `video_url`, not `gmi_video_url`. The GMI link is temporary; `video_url` serves
  the copy this server saved.
- A failed job has `"status": "failed"` and the reason in `error`.

Errors before a job is created come back as an HTTP status with `{"detail": "..."}`:

| Status | When |
|---|---|
| `400` | The model needs inputs this server cannot map, or the request does not fit it |
| `401` | Missing or wrong token |
| `402` | The job would pass the spend cap or the per-job limit |
| `404` | Unknown model or job, or the video is not ready yet |
| `422` | The body is not valid (for example, no `prompt`) |

## Two ways to call it

**Blocking (`wait=true`).** Simplest for scripts and quick tests. If `wait_timeout` runs
out first, the response shows the current status; keep polling `GET /jobs/{id}`.

**Async.** Use this from a Worker or anything that should not hold a request open for
minutes:

1. `POST /generate` and keep `job_id`.
2. `GET /jobs/{id}` every 5–30 seconds until `status` is `ready`, `failed` or `timeout`.
3. `GET /jobs/{id}/video` to download the mp4.

From a Cloudflare Worker:

```ts
const base = env.MODEL_SERVER_URL; // https://distro-model-417048709195.asia-east1.run.app
const auth = { Authorization: `Bearer ${env.MODEL_SERVER_TOKEN}` };

const job = await fetch(`${base}/generate`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ model: "fast", prompt }),
}).then((r) => r.json());

// later, e.g. from a Workflow step after step.sleep("30 seconds"):
const now = await fetch(`${base}/jobs/${job.job_id}`, { headers: auth }).then((r) => r.json());
if (now.status === "ready") {
  const mp4 = await fetch(now.video_url, { headers: auth });
  await env.BUCKET.put(`videos/${job.job_id}.mp4`, mp4.body);
}
```

## Choosing a model

| Tier | Model | Time to video | Cost (5 s, 720p) | Notes |
|---|---|---|---|---|
| `fast` | `gemini-omni-1.2-flash` | 37–50 s | $0.35 | Good quality, cheapest of the tested set. Native 9:16. |
| `default` | `wan3.0-video` | 117 s | $0.50 | Most visible speaking motion. Only model with `audio_url` lip sync. Needs ≥ $10 in the GMI account. |
| (any) | `MiniMax-H3` | 120 s | $0.40 | Outputs 768×1344. Strong lifestyle backgrounds. |
| `quality` | `seedance-2-5-260628` | 210 s | $1.155 | Refused by default: costs more than the $1.00 per-job limit. |
| (any) | `veo-3.1-lite-generate-001` | — | — | GMI returned HTTP 500 three times on 2026-11-11. |

Tested 2026-11-11 with one prompt: a 9:16 UGC selfie of a young adult saying a one-line
app hook, 5 s, with audio. All successful outputs were 9:16 with audio. Only still frames
were reviewed, not lip sync or audio quality. Times include GMI's queue and will vary.

For any other model, call `GET /models` and try it with `dry_run: true`.

## Spend cap

Every job reserves its list-price estimate before it is sent to GMI. GMI keeps
generating even when the account balance is negative, so this cap is the real limit.

- Total cap: `SPEND_CAP_USD`, default $9. A job that would pass it gets `402`.
- Per-job limit: `MAX_RENDER_USD`, default $1.00.
- `GET /spend` shows what is committed, reserved and left.

| Outcome | Reserve |
|---|---|
| GMI rejects the request, or the job fails | Released (GMI refunds failed jobs) |
| Video is ready | Committed |
| Job times out | Kept, because GMI may still bill it |

## Operating it

### Deployment

| | |
|---|---|
| URL | `https://distro-model-417048709195.asia-east1.run.app` |
| GCP project / region | `distro-model-66ada6` / `asia-east1` |
| Storage | `gs://distro-model-66ada6-media` (`videos/`, `jobs/`, `spend.json`) |
| Secrets | Secret Manager: `gmi-api-key`, `model-server-token` |
| Instances | Exactly 1, CPU always on. Keep `--max-instances 1`: the spend ledger and job polling assume a single instance. |

Jobs and the ledger are saved on every change. After a restart, jobs that GMI already
accepted resume polling.

### Redeploy after a code change

Run from the repo root. `.gcloudignore` uploads only the server files, never `.env`.
Bump the image tag each time.

```bash
gcloud builds submit . --project distro-model-66ada6 --region asia-east1 \
  --config model_server/cloudbuild.yaml \
  --substitutions=_IMAGE=asia-east1-docker.pkg.dev/distro-model-66ada6/distro/model-server:v2
gcloud run deploy distro-model --project distro-model-66ada6 --region asia-east1 \
  --image asia-east1-docker.pkg.dev/distro-model-66ada6/distro/model-server:v2
```

If `gcloud storage` or `gcloud builds` crashes with `ssl ... PROTOCOL_TLSv1`, point
gcloud at another Python first:

```bash
export CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.12/bin/python3.12
```

### Rotate the token

```bash
openssl rand -hex 24 | tr -d '\n' | gcloud secrets versions add model-server-token \
  --project distro-model-66ada6 --data-file=-
gcloud run services update distro-model --project distro-model-66ada6 --region asia-east1 \
  --update-secrets MODEL_SERVER_TOKEN=model-server-token:latest
```

Then send the new token to everyone who calls the server.

### Make it private again

Callers then also need a Google identity token in `X-Serverless-Authorization`, which a
Cloudflare Worker cannot easily get.

```bash
gcloud run services remove-iam-policy-binding distro-model --project distro-model-66ada6 \
  --region asia-east1 --member=allUsers --role=roles/run.invoker
```

### Run locally

```bash
uv run model_server/app.py   # http://localhost:8787
```

Reads `GMI_API_KEY` from the environment or the repo `.env`. Without `GCS_BUCKET` it
stores videos, jobs and the ledger in `model_server/data/` (gitignored). Optional:
`GMI_ORG_ID`, `SPEND_CAP_USD`, `MAX_RENDER_USD`, `MODEL_SERVER_TOKEN`, `GCS_BUCKET`,
`PUBLIC_BASE_URL`, `PORT`.

### Refresh the model catalog

When GMI adds or changes models:

```bash
uv run scripts/sync_gmi_catalog.py --summary
```

This rewrites `src/data/gmi-video-models.json`. Redeploy afterwards so the server sees it.

### Compare models

```bash
uv run scripts/bench_video_models.py --list
uv run scripts/bench_video_models.py --dry-run --models fast default
```

Without `--dry-run` it generates real videos and spends money (it asks first). This
script calls GMI directly, so its spend is not recorded in the server's ledger.

## Cloudflare version (not deployed)

`model_worker/` is a TypeScript port with the same API: a Durable Object per job polls
GMI with `alarm()`, and videos go to R2. It has not been type-checked or deployed. See
`model_worker/README.md`. If it replaces Cloud Run, carry over the committed spend from
`GET /spend` and run only one of the two at a time, or the $9 cap is counted twice.
