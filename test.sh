#!/bin/sh
# Deploy the Actor (apify push) and run the binding smoke test on the freshly
# built version via `apify call`. Exits non-zero if any binding check fails.
#
# Usage: ./test.sh
set -eu

cd "$(dirname "$0")"

TEST_JS="tests/binding-smoke.js"

command -v apify >/dev/null 2>&1 || { echo "apify CLI not found" >&2; exit 1; }
command -v jq    >/dev/null 2>&1 || { echo "jq not found" >&2; exit 1; }

input_json="$(mktemp)"
trap 'rm -f "$input_json"' EXIT

echo "==> apify push"
apify push

echo "==> building input from ${TEST_JS}"
jq -n --arg code "$(cat "$TEST_JS")" '{ code: $code }' > "$input_json"

echo "==> apify call (running the test on the built Actor)"
output="$(apify call -f "$input_json" -o 2>&1)"
echo "$output"

if printf '%s' "$output" | grep -q 'ALL_TESTS_PASSED'; then
    echo "==> all binding tests passed"
else
    echo "==> binding tests FAILED" >&2
    exit 1
fi
