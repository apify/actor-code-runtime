// Sandbox isolation test. Submitted as the Actor's `code` input by test.sh and
// executed on the built Actor via `apify call`. Asserts the sandbox boundary
// holds and prints a sentinel line (ALL_TESTS_PASSED) that test.sh greps for.
//
// Guards github.com/apify/ai-team#216 (findings A, B, C): the isolate runs
// WITHOUT workerd's nodejs_compat, so user code cannot reach Node built-ins.
// That removes node:net (a raw-socket egress path that bypassed guard.js's
// *.apify.com fetch allowlist — finding A) and process.env (which held the
// run's APIFY_TOKEN — finding B), and makes the "no imports" docs accurate
// (finding C). fetch() and the apify binding must still work.
const results = [];
function check(name, cond, detail = '') {
    if (cond) {
        console.log(`PASS ${name}: ${detail}`);
        results.push(true);
    } else {
        console.error(`FAIL ${name}: ${detail}`);
        results.push(false);
    }
}

// Node built-ins must NOT be importable (no nodejs_compat).
for (const mod of ['node:net', 'node:fs', 'node:dns', 'node:child_process']) {
    let imported = false;
    try { await import(mod); imported = true; } catch { /* expected */ }
    check(`import ${mod} blocked`, !imported, imported ? 'IMPORTED (leak!)' : 'blocked');
}

// The run token lives in process.env under nodejs_compat; without it, process
// and require must be undefined so user code can't read the credential.
check('process undefined', typeof process === 'undefined', `typeof process = ${typeof process}`);
check('require undefined', typeof require === 'undefined', `typeof require = ${typeof require}`);

// fetch must remain — the apify binding depends on it.
check('fetch available', typeof fetch === 'function', `typeof fetch = ${typeof fetch}`);

// guard.js allowlist: apify.com and *.apify.com only. A guard rejection throws
// synchronously with a "Blocked fetch" message BEFORE any network I/O; anything
// else (a real network/HTTP error) means guard let the request through. So we
// classify by the error message, not by whether the request ultimately succeeds.
async function guardBlocks(url) {
    try {
        await fetch(url);
        return false; // request went out — guard allowed it
    } catch (e) {
        return /Blocked fetch/.test(e.message); // guard rejection vs. network error
    }
}

// Allowed: the main domain and any subdomain must NOT be guard-blocked.
for (const url of ['https://apify.com/', 'https://api.apify.com/v2/browser-info']) {
    check(`allow ${url}`, !(await guardBlocks(url)), 'not blocked by guard');
}

// Blocked: other public hosts, subdomain look-alikes, userinfo/host tricks, and
// the cloud metadata IP must all be guard-blocked.
const blockedTargets = [
    'https://example.com/', // unrelated public host
    'https://evilapify.com/', // suffix without the dot — must not match .apify.com
    'https://apify.com.evil.com/', // real host is evil.com
    'https://apify.com@evil.com/', // userinfo trick — real host is evil.com
    'http://169.254.169.254/', // cloud link-local metadata
];
for (const url of blockedTargets) {
    check(`block ${url}`, await guardBlocks(url), 'blocked by guard');
}

// The apify binding must still work (fetch to *.apify.com).
let bindingWorks = false;
try {
    const found = await apify.actor.search({ query: 'hello world', limit: 1 });
    bindingWorks = Array.isArray(found);
} catch (e) {
    console.error(`apify.actor.search threw: ${e.message}`);
}
check('apify binding works', bindingWorks, bindingWorks ? 'actor.search ok' : 'binding broken');

const passed = results.filter(Boolean).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
if (passed === results.length) console.log('ALL_TESTS_PASSED');
else console.error(`SOME_TESTS_FAILED (${results.length - passed} failed)`);
