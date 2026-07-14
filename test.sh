#!/bin/sh
# Deploy the Actor (apify push) once, then run each test probe on the freshly
# built version via `apify call`. Each probe is a script submitted as the `code`
# input; it prints ALL_TESTS_PASSED on success. Exits non-zero if any probe fails.
#
# Usage: ./test.sh
set -eu

cd "$(dirname "$0")"

# Probes are written in tests/*.ts and compiled by `pnpm build`; add a .ts file
# there to register a new probe. Run against the built Actor.
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
