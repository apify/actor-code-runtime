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

// guard.js must still block a non-apify host over fetch.
let nonApifyBlocked = false;
try { await fetch('https://example.com'); } catch { nonApifyBlocked = true; }
check('non-apify fetch blocked', nonApifyBlocked, nonApifyBlocked ? 'blocked' : 'REACHED example.com (leak!)');

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
