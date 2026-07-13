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
DATASET_ID="${ACTOR_DEFAULT_DATASET_ID:-${APIFY_DEFAULT_DATASET_ID:-}}"
INPUT_KEY="${APIFY_INPUT_KEY:-INPUT}"
WORKERD_STDERR=/tmp/workerd.err

if [ -z "${APIFY_TOKEN:-}" ] || [ -z "$STORE_ID" ] || [ -z "$DATASET_ID" ]; then
    echo "[code-runtime] missing APIFY_TOKEN or default key-value store / dataset ID" >&2
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

/usr/local/bin/workerd serve --experimental /app/worker/config.capnp 2>"$WORKERD_STDERR" &
workerd_pid=$!
trap 'kill "$workerd_pid" 2>/dev/null || true' EXIT

# push_compile_failure reports a usercode.js syntax error as a normal, SUCCEEDED script
# result (same contract as a script that throws at runtime) instead of failing the whole
# Actor run. usercode.js wraps the user's `code` inside `export async function run(...) {
# ... }` with nothing else at module scope, so nothing in it can fail to *parse* except
# that inserted code — a startup crash naming usercode.js is therefore always a syntax
# error in the user's script, never our own code. See detection below.
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

# Trigger the single run. The worker runs the program and pushes { stdout, stderr,
# exitCode, statusMessage } to the default dataset. A non-2xx response fails the Actor
# run (curl -f).
curl -fsS -X POST "http://127.0.0.1:${PORT}/run"
