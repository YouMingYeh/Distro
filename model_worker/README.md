# Distro video model Worker

The Cloudflare version of `model_server/`. It has the **same HTTP API**, so callers
only change the base URL and token. See `model_server/README.md` for the request,
response and error formats.

How it works:

- `POST /generate` builds the GMI payload, reserves the estimate in the global
  `LedgerDO`, and creates one `JobDO` per job, which submits to GMI and sets an alarm.
- `JobDO.alarm()` polls GMI every 10 s and sleeps in between, so a 5-minute render
  costs nothing while waiting. On success it copies the mp4 to R2 and commits the
  reserve; on failure it releases it.
- Model mapping reads `../src/data/gmi-video-models.json`; `src/gmiVideo.ts` is a port
  of `model_server/gmi_video.py`.

Differences from the Python server:

- `MODEL_SERVER_TOKEN` is always required. Without it, every route except `/health`
  returns 401.
- `wait_timeout` is capped at 900 s.

## Deploy

Requires Workers Paid (for Durable Objects alarms at this volume).

```bash
cd model_worker
npm install
npx wrangler login
npx wrangler r2 bucket create distro-model-media
npx wrangler secret put GMI_API_KEY
npx wrangler secret put MODEL_SERVER_TOKEN
npx wrangler deploy
```

`INITIAL_COMMITTED_USD` in `wrangler.jsonc` seeds the ledger with spend made before
this Worker existed. It is read only on the ledger's first use; change it after that
and nothing happens.

## Call

```bash
curl -s "https://distro-model.<subdomain>.workers.dev/generate?wait=true" \
  -H "Authorization: Bearer $MODEL_SERVER_TOKEN" -H 'content-type: application/json' \
  -d '{"model": "fast", "prompt": "Vertical selfie video, a young adult says: why did nobody tell me about this app?"}'
```
