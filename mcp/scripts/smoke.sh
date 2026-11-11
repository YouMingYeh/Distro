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
# video: dry_run only, so the check never starts a paid render. Needs MODEL_SERVER_TOKEN on the Worker.
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_video","arguments":{"prompt":"a cat","dry_run":true}}}' \
  | grep -q 'est_usd' || fail "MCP generate_video"
rest list_models '{}' | grep -q '"fast"' || fail "REST list_models"
rest generate_video '{"prompt":"a cat","dry_run":true}' | grep -q '"dry_run":true' || fail "REST generate_video"
rest get_job '{"job_id":"job_000000000000"}' | grep -q 'Unknown job' || fail "another workspace's job is readable"
curl -s -o /dev/null -w '%{http_code}' "$BASE/videos/job_000000000000.mp4" | grep -q 404 || fail "video link for a job that does not exist"
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | grep -q '"find_viral_videos"' || fail "research tools not listed"
rest darkugc_call '{"tool":"top_hooks"}' | grep -q 'not connected' || fail "darkugc without sign-in"
KEYS_URL=$(rest connect_keys '{}' | json "['url']")
curl -s "$KEYS_URL" | grep -q 'name="FIRECRAWL_API_KEY"' || fail "keys form"
curl -s "$BASE/keys" -d "t=${KEYS_URL##*t=}" -d "EXA_API_KEY=smoke-test-key" | grep -q 'ends -key' || fail "key not saved"
rest connect_keys '{}' | grep -q '"your_keys":\["exa"\]' || fail "saved key not listed"
curl -s "$BASE/keys" -d "t=${KEYS_URL##*t=}" -d "remove_EXA_API_KEY=1" | grep -q 'ends -key' && fail "key not removed"
curl -s -o /dev/null -w '%{http_code}' "$BASE/keys?t=nope" | grep -q 400 || fail "bad keys link accepted"
rest get_video_hook '{"url":"https://example.com/x"}' | grep -q 'invalid_arguments' || fail "hook url not validated"
# the token only has the video and research scopes: account tools must refuse
rest list_accounts '{}' | grep -q 'lacks the' || fail "scope not enforced"
rest tokportal_call '{"tool":"tokportal_create_bundle"}' | grep -q 'lacks the' || fail "managed scope not enforced"
rest boost_post '{}' | grep -q 'lacks the' || fail "ads scope not enforced"
rest get_job '{"job_id":"nope"}' | grep -q 'invalid_arguments' || fail "input not validated"
curl -s -o /dev/null -w '%{http_code}' "$BASE/api/tools/list_models" -d '{}' | grep -q 401 || fail "REST without token"
# profiles: a second grant with the accounts scope. None of these calls needs Zernio.
V2=$(openssl rand -hex 32)
C2=$(printf '%s' "$V2" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
H2=$(curl -s -b "$JAR" -c "$JAR" -G "$BASE/authorize" --data-urlencode "response_type=code" --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "code_challenge=$C2" --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "resource=$BASE" --data-urlencode "scope=accounts managed" --data-urlencode "state=s2" \
  | sed -n 's/.*name="handle" value="\([^"]*\)".*/\1/p')
CODE2=$(curl -s -i -b "$JAR" -c "$JAR" "$BASE/authorize" --data-urlencode "handle=$H2" -d "decision=approve&scope=accounts&scope=managed" \
  | tr -d '\r' | sed -n 's/^[Ll]ocation: .*[?&]code=\([^&]*\).*/\1/p')
TOKEN=$(curl -s "$BASE/oauth/token" -d "grant_type=authorization_code&client_id=$CLIENT_ID&code_verifier=$V2" \
  -d "code=$CODE2" --data-urlencode "redirect_uri=$REDIRECT" --data-urlencode "resource=$BASE" | json "['access_token']")
rest list_profiles '{}' | grep -q '"name":"Default","default":true' || fail "no default profile"
rest list_all '{}' | grep -q '"services":\[{"name":"darkugc","connected":false' || fail "list_all"
rest list_all '{}' | grep -q '"name":"tokportal","connected":false,"connect_with":"connect_tokportal"' || fail "list_all tokportal"
rest tokportal_call '{"tool":"tokportal_create_bundle"}' | grep -q 'TokPortal is not connected' || fail "tokportal without sign-in"
rest tokportal_call '{"tool":"drop_everything"}' | grep -q 'invalid_arguments' || fail "tokportal tool name not validated"
rest list_all '{}' | grep -q '"service":"exa","yours":false' || fail "list_all keys"
PID=$(rest create_profile '{"name":"Acme"}' | json "['id']")
rest create_profile '{"name":"acme"}' | grep -q 'already exists' || fail "duplicate profile name allowed"
rest rename_profile "{\"profile\":\"$PID\",\"name\":\"Acme Co\"}" | grep -q '"name":"Acme Co"' || fail "rename_profile"
rest list_accounts '{"profile":"nope"}' | grep -q 'No profile' || fail "unknown profile accepted"
rest delete_profile '{"profile":"acme co"}' | grep -q "\"deleted\":\"$PID\"" || fail "delete_profile by name"
rest delete_profile '{"profile":"Default"}' | grep -q 'only profile' || fail "deleted the only profile"
# API keys: made from the OAuth session, inherit its scopes (accounts and managed), and cannot manage keys.
keys() { curl -s -X "$1" "$BASE/api/api-keys$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
MADE=$(keys POST "" '{"name":"smoke"}')
KEY=$(printf '%s' "$MADE" | json "['key']"); KID=$(printf '%s' "$MADE" | json "['id']")
keys GET "" | grep -q "\"id\":\"$KID\"" || fail "api key not listed"
keys GET "" | grep -q "$KEY" && fail "api key listed in full"
OAUTH=$TOKEN; TOKEN=$KEY
rest list_profiles '{}' | grep -q '"name":"Default"' || fail "api key not accepted"
rest list_models '{}' | grep -q 'lacks the' || fail "api key scope not enforced"
curl -s "$BASE/api/me" -H "Authorization: Bearer $KEY" | grep -q '"auth":"api_key"' || fail "/api/me with key"
keys GET "" | grep -q 'forbidden' || fail "api key could manage keys"
TOKEN=$OAUTH
keys DELETE "?id=$KID" | grep -q "\"revoked\":\"$KID\"" || fail "revoke api key"
curl -s -o /dev/null -w '%{http_code}' "$BASE/api/me" -H "Authorization: Bearer $KEY" | grep -q 401 || fail "revoked api key still accepted"
echo "ok: OAuth (DCR + PKCE + consent), MCP, REST, scope, input, profile and API key checks"
