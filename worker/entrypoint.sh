#!/bin/sh
# Normal-mode (non-standby) Apify Actor entrypoint. Single-tenant per run:
#   1. read the Actor input and wrap its `code` into the runnable usercode.js module
#   2. boot workerd on loopback (it embeds runner.js + usercode.js)
#   3. trigger /run once, then exit
# workerd hosts the sandboxed worker and is reached only over loopback.
set -eu

PORT=8787
READINESS_ATTEMPTS=100   # 100 * 0.1s = 10s budget for workerd to bind the socket

API_BASE="${APIFY_API_BASE_URL:-https://api.apify.com}"
API_BASE="${API_BASE%/}"   # APIFY_API_BASE_URL ships with a trailing slash
STORE_ID="${ACTOR_DEFAULT_KEY_VALUE_STORE_ID:-${APIFY_DEFAULT_KEY_VALUE_STORE_ID:-}}"
INPUT_KEY="${APIFY_INPUT_KEY:-INPUT}"

if [ -z "${APIFY_TOKEN:-}" ] || [ -z "$STORE_ID" ]; then
    echo "[code-runtime] missing APIFY_TOKEN or default key-value store ID" >&2
    exit 1
fi

# Fetch the Actor input and wrap its `code` into the runnable module. The `code`
# is inserted as code between the wrapper lines (not as a string) — no escaping.
INPUT_URL="${API_BASE}/v2/key-value-stores/${STORE_ID}/records/${INPUT_KEY}"
input_status=$(curl -sS -o /tmp/input.json -w '%{http_code}' \
    -H "Authorization: Bearer ${APIFY_TOKEN}" "$INPUT_URL")
if [ "$input_status" != "200" ]; then
    echo "[code-runtime] failed to read Actor input from ${INPUT_URL} (HTTP ${input_status})" >&2
    exit 1
fi

{
    printf 'export async function run(apify, console) {\n'
    jq -r '.code // ""' < /tmp/input.json
    printf '\n}\n'
} > /app/worker/usercode.js

# config.capnp hardcodes __PORT__ as a placeholder so the port has one source ($PORT above).
sed -i "s/__PORT__/${PORT}/" /app/worker/config.capnp

/usr/local/bin/workerd serve --experimental /app/worker/config.capnp &
workerd_pid=$!
trap 'kill "$workerd_pid" 2>/dev/null || true' EXIT

attempt=0
until curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$READINESS_ATTEMPTS" ]; then
        echo "[code-runtime] workerd did not become ready in time" >&2
        exit 1
    fi
    sleep 0.1
done

# Trigger the single run. The worker runs the program and pushes { stdout, stderr }
# to the default dataset. A non-2xx response fails the Actor run (curl -f).
curl -fsS -X POST "http://127.0.0.1:${PORT}/run"
