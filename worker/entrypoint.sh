#!/bin/sh
# Read input, start workerd, trigger one run, then exit.
set -eu

PORT=8787
READINESS_ATTEMPTS=100   # 100 * 0.1s = 10s budget for workerd to bind the socket

API_BASE="${APIFY_API_BASE_URL:-https://api.apify.com}"
API_BASE="${API_BASE%/}"   # APIFY_API_BASE_URL ships with a trailing slash
STORE_ID="${ACTOR_DEFAULT_KEY_VALUE_STORE_ID:-${APIFY_DEFAULT_KEY_VALUE_STORE_ID:-}}"
DATASET_ID="${ACTOR_DEFAULT_DATASET_ID:-${APIFY_DEFAULT_DATASET_ID:-}}"
INPUT_KEY="${APIFY_INPUT_KEY:-INPUT}"
WORKERD_STDERR=/tmp/workerd.err

if [ -z "${APIFY_TOKEN:-}" ] || [ -z "$STORE_ID" ] || [ -z "$DATASET_ID" ]; then
    echo "[code-runtime] missing APIFY_TOKEN or default key-value store / dataset ID" >&2
    exit 1
fi

# Insert input code directly into the generated module.
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

# Export optional execution limits; blank means unlimited.
export CODE_RUNTIME_MAX_ACTOR_RUNS="$(jq -r '.maxActorRuns // empty' < /tmp/input.json)"
export CODE_RUNTIME_MAX_TOTAL_CHARGE_USD="$(jq -r '.maxTotalChargeUsd // empty' < /tmp/input.json)"
export CODE_RUNTIME_DEFAULT_TIMEOUT_SECS="$(jq -r '.defaultTimeoutSecs // empty' < /tmp/input.json)"

sed -i "s/__PORT__/${PORT}/" /app/worker/config.capnp

/usr/local/bin/workerd serve --experimental /app/worker/config.capnp 2>"$WORKERD_STDERR" &
workerd_pid=$!
trap 'kill "$workerd_pid" 2>/dev/null || true' EXIT

# Report user-code compile errors as diagnostic output.
push_compile_failure() {
    crash_log=$(cat "$WORKERD_STDERR" 2>/dev/null || true)
    echo "[code-runtime] usercode.js failed to compile: $crash_log" >&2
    item=$(jq -n --arg stderr "$crash_log" \
        '{stdout: "", stderr: $stderr, exitCode: 1, statusMessage: ("Failed to compile: " + $stderr)}')
    push_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
        "${API_BASE}/v2/datasets/${DATASET_ID}/items" \
        -H "Authorization: Bearer ${APIFY_TOKEN}" \
        -H 'content-type: application/json; charset=utf-8' \
        --data-binary "$item")
    case "$push_status" in
        2??) exit 0 ;;
        *)
            echo "[code-runtime] failed to push compile-failure diagnostic (HTTP $push_status)" >&2
            exit 1
            ;;
    esac
}

attempt=0
until curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; do
    if ! kill -0 "$workerd_pid" 2>/dev/null; then
        if grep -q 'usercode\.js' "$WORKERD_STDERR" 2>/dev/null; then
            push_compile_failure
        fi
        echo "[code-runtime] workerd exited before startup: $(cat "$WORKERD_STDERR" 2>/dev/null)" >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$READINESS_ATTEMPTS" ]; then
        echo "[code-runtime] workerd did not become ready in time" >&2
        exit 1
    fi
    sleep 0.1
done

# Trigger one run; non-2xx fails the Actor run.
curl -fsS -X POST "http://127.0.0.1:${PORT}/run"
