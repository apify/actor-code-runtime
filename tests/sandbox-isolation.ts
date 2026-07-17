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
//
// `export {}` marks this file as its own ES module, so its top-level consts
// don't collide with the other probe's (both are type-checked in one tsc
// program) and top-level await below is legal. `pnpm build` strips this line
// post-compile (see package.json) -- left in, it would be a syntax error once
// spliced into the wrapping `async function run(apify, console) { ... }`.
export {};

const results: boolean[] = [];
function check(name: string, cond: boolean, detail = ''): void {
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
async function guardBlocks(url: string): Promise<boolean> {
    try {
        await fetch(url);
        return false; // request went out — guard allowed it
    } catch (e) {
        return /Blocked fetch/.test((e as Error).message); // guard rejection vs. network error
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

// Non-fetch egress primitives must be neutralized: WebSocket and EventSource
// are web-standard globals that connect directly (not through the fetch guard),
// so a script could otherwise open a wss:// / SSE channel to any public host and
// exfiltrate around the *.apify.com allowlist (apify/ai-team#216 finding A).
function blocksConstruct(name: string, url: string): boolean {
    const Ctor = (globalThis as Record<string, unknown>)[name];
    if (typeof Ctor !== 'function') return true; // absent → not an egress path
    try {
        new (Ctor as new (u: string) => unknown)(url);
        return false; // constructed → egress opened
    } catch (e) {
        return /Blocked/.test((e as Error).message); // our guard rejection vs. any other error
    }
}
check('WebSocket blocked', blocksConstruct('WebSocket', 'wss://echo.websocket.org'), 'no wss egress');
check('EventSource blocked', blocksConstruct('EventSource', 'https://example.com/sse'), 'no SSE egress');

// The apify binding must still work (fetch to *.apify.com).
let bindingWorks = false;
try {
    const found = await apify.store({ search: 'hello world', limit: 1 });
    bindingWorks = Array.isArray(found.items);
} catch (e) {
    console.error(`apify.store threw: ${(e as Error).message}`);
}
check('apify binding works', bindingWorks, bindingWorks ? 'store ok' : 'binding broken');

const passed = results.filter(Boolean).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
if (passed === results.length) console.log('ALL_TESTS_PASSED');
else console.error(`SOME_TESTS_FAILED (${results.length - passed} failed)`);
