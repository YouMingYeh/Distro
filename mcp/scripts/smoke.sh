#!/usr/bin/env bash
# End-to-end check of the OAuth + tools path against a running Worker.
# Usage: scripts/smoke.sh [base-url]   (default http://localhost:8787, i.e. `pnpm dev`)
set -euo pipefail
BASE="${1:-http://localhost:8787}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
REDIRECT="http://localhost:9999/callback"
fail() { echo "FAIL: $1" >&2; exit 1; }
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

# Local only: seed a signed-in session the way /callback does after Clerk, since a script cannot
# click through the sign-in. Ignored by a Worker that runs without CLERK_ISSUER.
if [[ "$BASE" == http://localhost* ]]; then
  SID=$(uuidgen | tr 'A-Z' 'a-z')
  npx wrangler kv key put --local --binding OAUTH_KV "session:$SID" "{\"ws\":\"smoke-$SID\"}" >/dev/null 2>&1 || fail "could not seed a session"
  printf '#HttpOnly_localhost\tFALSE\t/\tTRUE\t0\t__Host-distro-ws\t%s\n' "$SID" > "$JAR"
fi

# 401 challenge points at the protected resource metadata
curl -s -i -X POST "$BASE/mcp" | grep -qi 'resource_metadata=' || fail "no 401 challenge"

# dynamic client registration (public client)
CLIENT_ID=$(curl -s "$BASE/oauth/register" -H 'Content-Type: application/json' \
  -d "{\"client_name\":\"smoke\",\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"none\"}" | json "['client_id']")

# authorization code + PKCE (S256), through the consent page
VERIFIER=$(openssl rand -hex 32)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
HANDLE=$(curl -s -b "$JAR" -c "$JAR" -G "$BASE/authorize" --data-urlencode "response_type=code" --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code_challenge=$CHALLENGE" --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "resource=$BASE" --data-urlencode "scope=video research" --data-urlencode "state=s1" \
  | sed -n 's/.*name="handle" value="\([^"]*\)".*/\1/p')
[ -n "$HANDLE" ] || fail "no consent page"
LOCATION=$(curl -s -i -b "$JAR" -c "$JAR" "$BASE/authorize" --data-urlencode "handle=$HANDLE" -d "decision=approve&scope=video&scope=research" \
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
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | grep -q '"find_viral_videos"' || fail "research tools not listed"
rest darkugc_call '{"tool":"top_hooks"}' | grep -q 'not connected' || fail "darkugc without sign-in"
rest get_video_hook '{"url":"https://example.com/x"}' | grep -q 'invalid_arguments' || fail "hook url not validated"
# the token only has the video and research scopes: account tools must refuse
rest list_accounts '{}' | grep -q 'lacks the' || fail "scope not enforced"
rest get_job '{"job_id":"nope"}' | grep -q 'invalid_arguments' || fail "input not validated"
curl -s -o /dev/null -w '%{http_code}' "$BASE/api/tools/list_models" -d '{}' | grep -q 401 || fail "REST without token"
# profiles: a second grant with the accounts scope. None of these calls needs Zernio.
V2=$(openssl rand -hex 32)
C2=$(printf '%s' "$V2" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
H2=$(curl -s -b "$JAR" -c "$JAR" -G "$BASE/authorize" --data-urlencode "response_type=code" --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code_challenge=$C2" --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "resource=$BASE" --data-urlencode "scope=accounts" --data-urlencode "state=s2" \
  | sed -n 's/.*name="handle" value="\([^"]*\)".*/\1/p')
CODE2=$(curl -s -i -b "$JAR" -c "$JAR" "$BASE/authorize" --data-urlencode "handle=$H2" -d "decision=approve&scope=accounts" \
  | tr -d '\r' | sed -n 's/^[Ll]ocation: .*[?&]code=\([^&]*\).*/\1/p')
TOKEN=$(curl -s "$BASE/oauth/token" -d "grant_type=authorization_code&client_id=$CLIENT_ID&code_verifier=$V2" \
  -d "code=$CODE2" --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "resource=$BASE" | json "['access_token']")
rest list_profiles '{}' | grep -q '"name":"Default","default":true' || fail "no default profile"
PID=$(rest create_profile '{"name":"Acme"}' | json "['id']")
rest create_profile '{"name":"acme"}' | grep -q 'already exists' || fail "duplicate profile name allowed"
rest rename_profile "{\"profile\":\"$PID\",\"name\":\"Acme Co\"}" | grep -q '"name":"Acme Co"' || fail "rename_profile"
rest list_accounts '{"profile":"nope"}' | grep -q 'No profile' || fail "unknown profile accepted"
rest delete_profile '{"profile":"acme co"}' | grep -q "\"deleted\":\"$PID\"" || fail "delete_profile by name"
rest delete_profile '{"profile":"Default"}' | grep -q 'only profile' || fail "deleted the only profile"
echo "ok: OAuth (DCR + PKCE + consent), MCP, REST, scope, input and profile checks"
