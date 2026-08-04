#!/bin/sh
# Build, deploy, and run each remote probe.
# Usage: ./test.sh
set -eu

cd "$(dirname "$0")"

# Build probes from tests/*.ts.
PROBES="tests/binding-smoke.js tests/sandbox-isolation.js"

command -v apify >/dev/null 2>&1 || { echo "apify CLI not found" >&2; exit 1; }
command -v jq    >/dev/null 2>&1 || { echo "jq not found" >&2; exit 1; }

echo "==> pnpm build"
pnpm build

input_json="$(mktemp)"
trap 'rm -f "$input_json"' EXIT

echo "==> apify push"
apify push

failed=0
for probe in $PROBES; do
    echo "==> apify call: ${probe}"
    jq -n --arg code "$(cat "$probe")" '{ code: $code }' > "$input_json"
    output="$(apify call -f "$input_json" -o 2>&1)"
    echo "$output"
    if printf '%s' "$output" | grep -q 'ALL_TESTS_PASSED'; then
        echo "==> ${probe} passed"
    else
        echo "==> ${probe} FAILED" >&2
        failed=1
    fi
done

[ "$failed" -eq 0 ] || { echo "==> some probes FAILED" >&2; exit 1; }
echo "==> all probes passed"

# Regression probe for module-scope capability theft.
echo "==> apify call: tests/fixtures/realfetch-escape.js (regression: guard.js capability theft)"
jq -n --arg code "$(cat tests/fixtures/realfetch-escape.js)" '{ code: $code }' > "$input_json"
if apify call -f "$input_json" -o; then
    echo "==> realfetch-escape passed (run succeeded — module-scope steal attempt found nothing to steal)"
else
    echo "==> realfetch-escape FAILED (run crashed — capability-theft regression, see guard.ts/runner.ts/config.capnp's INTERNAL_API binding)" >&2
    failed=1
fi

[ "$failed" -eq 0 ] || { echo "==> some probes FAILED" >&2; exit 1; }
echo "==> all probes (including regressions) passed"
