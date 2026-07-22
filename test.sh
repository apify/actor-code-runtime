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

# Regression probe for the realFetch claim-ordering bug (PR #1 review,
# 2026-07-21): tests/fixtures/realfetch-escape.js escapes usercode.js's
# wrapper into module scope and tries to steal the internal-only realFetch
# before runner.ts's own claim. It has no captured console to report through
# (see the file's own comment), so success/failure is the Actor run itself
# succeeding vs. failing -- not a printed sentinel like the probes above.
echo "==> apify call: tests/fixtures/realfetch-escape.js (regression: realFetch claim ordering)"
jq -n --arg code "$(cat tests/fixtures/realfetch-escape.js)" '{ code: $code }' > "$input_json"
if apify call -f "$input_json" -o; then
    echo "==> realfetch-escape passed (run succeeded — module-scope steal attempt did not hijack/crash the internal claim)"
else
    echo "==> realfetch-escape FAILED (run crashed — realFetch claim-ordering regression, see guard.ts's requestHandlingStarted gate)" >&2
    failed=1
fi

[ "$failed" -eq 0 ] || { echo "==> some probes FAILED" >&2; exit 1; }
echo "==> all probes (including regressions) passed"
