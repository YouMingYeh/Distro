# Distro MCP Worker

The Cloudflare Worker `distro`, served at `https://mcp.trydistro.app`. Its bindings,
vars and the list of secrets are in `wrangler.jsonc`.

## What it uses on Cloudflare

| Resource | Name | Where it is set |
| --- | --- | --- |
| Worker | `distro` | `name` in `wrangler.jsonc` |
| KV namespace | `OAUTH_KV` | `kv_namespaces` in `wrangler.jsonc` (by id) |
| Custom domain | `mcp.trydistro.app` | `routes` in `wrangler.jsonc` |
| Zone | `trydistro.app` | Must be in the same Cloudflare account as the Worker |

## Set up from nothing

```bash
cd mcp
pnpm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV   # prints an id: put it in wrangler.jsonc
pnpm secrets                                # uploads .env.production
npx wrangler secret put ZERNIO_API_KEY      # not in .env.production, set by hand
pnpm run deploy
```

`pnpm run deploy` attaches `mcp.trydistro.app` itself, as long as the `trydistro.app`
zone is in the account. If the zone is missing, add the domain in the Cloudflare
dashboard first and point the registrar at Cloudflare's nameservers.

`.env.production` is gitignored. It holds the Clerk OAuth client, `MODEL_SERVER_TOKEN`
and `KEYS_ENCRYPTION_KEY`; the header comments in the file say where each comes from.
Keep a copy of `KEYS_ENCRYPTION_KEY` somewhere safe: without it, everything users
saved in KV is unreadable.

## Update

```bash
pnpm run deploy    # code or wrangler.jsonc changed
pnpm secrets       # .env.production changed
```

## Local

```bash
pnpm dev           # reads .env.development, serves http://localhost:8787
```

## Tear down

```bash
npx wrangler delete                                                        # the Worker and its custom domain
npx wrangler kv namespace delete --namespace-id <id from wrangler.jsonc>   # all saved sign-ins and user keys
```

Deleting the KV namespace cannot be undone. The Cloudflare account also holds other
projects' resources, so delete by the id in `wrangler.jsonc`, never by the title.
