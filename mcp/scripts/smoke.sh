#!/usr/bin/env bash
# End-to-end check of the OAuth + tools path against a running Worker.
# Usage: scripts/smoke.sh [base-url]   (default http://localhost:8787, i.e. `pnpm dev`)
set -euo pipefail
BASE="${1:-http://localhost:8787}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
REDIRECT="http://localhost:9999/callback"
fail() { echo "FAIL: $1" >&2; exit 1; }
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

# 401 challenge points at the protected resource metadata
curl -s -i -X POST "$BASE/mcp" | grep -qi 'resource_metadata=' || fail "no 401 challenge"

# dynamic client registration (public client)
CLIENT_ID=$(curl -s "$BASE/oauth/register" -H 'Content-Type: application/json' \
  -d "{\"client_name\":\"smoke\",\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"none\"}" | json "['client_id']")

# authorization code + PKCE (S256), through the consent page
VERIFIER=$(openssl rand -hex 32)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
HANDLE=$(curl -s -c "$JAR" -G "$BASE/authorize" --data-urlencode "response_type=code" --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "resource=$BASE" --data-urlencode "scope=video" --data-urlencode "state=s1" \
  | sed -n 's/.*name="handle" value="\([^"]*\)".*/\1/p')
[ -n "$HANDLE" ] || fail "no consent page"
LOCATION=$(curl -s -i -b "$JAR" -c "$JAR" "$BASE/authorize" --data-urlencode "handle=$HANDLE" -d "decision=approve&scope=video" \
  | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
CODE=$(printf '%s' "$LOCATION" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$CODE" ] || fail "no code in redirect: $LOCATION"
TOKEN=$(curl -s "$BASE/oauth/token" -d "grant_type=authorization_code&client_id=$CLIENT_ID&code_verifier=$VERIFIER" \
  -d "code=$CODE" --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "resource=$BASE" | json "['access_token']")

mcp() { curl -s "$BASE/mcp" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d "$1"; }
rest() { curl -s "$BASE/api/tools/$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2"; }

mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -q '"connect_account"' || fail "tools/list"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_video","arguments":{"prompt":"a cat"}}}' \
  | grep -q 'job_' || fail "MCP generate_video"
JOB=$(rest generate_video '{"prompt":"a cat"}' | json "['job_id']")
rest get_job "{\"job_id\":\"$JOB\"}" | grep -q '"queued"' || fail "REST get_job"
# the token only has the video scope: account tools must refuse
rest list_accounts '{}' | grep -q 'lacks the' || fail "scope not enforced"
rest get_job '{"job_id":"nope"}' | grep -q 'invalid_arguments' || fail "input not validated"
curl -s -o /dev/null -w '%{http_code}' "$BASE/api/tools/list_models" -d '{}' | grep -q 401 || fail "REST without token"
echo "ok: OAuth (DCR + PKCE + consent), MCP, REST, scope and input checks"
