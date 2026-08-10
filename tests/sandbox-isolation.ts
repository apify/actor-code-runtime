// Actor probe for workerd isolation, egress guards, and binding access.
// `export {}` enables top-level await; build strips it before wrapping code.
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

// Node built-ins must be unavailable.
for (const mod of ['node:net', 'node:fs', 'node:dns', 'node:child_process']) {
    let imported = false;
    try { await import(mod); imported = true; } catch { /* expected */ }
    check(`import ${mod} blocked`, !imported, imported ? 'IMPORTED (leak!)' : 'blocked');
}

// No process or require means no token access through Node globals.
check('process undefined', typeof process === 'undefined', `typeof process = ${typeof process}`);
check('require undefined', typeof require === 'undefined', `typeof require = ${typeof require}`);

check('fetch available', typeof fetch === 'function', `typeof fetch = ${typeof fetch}`);

// Classify guard rejection separately from network errors.
async function guardBlocks(url: string): Promise<boolean> {
    try {
        await fetch(url);
        return false;
    } catch (e) {
        return /Blocked fetch/.test((e as Error).message);
    }
}

for (const url of ['https://apify.com/', 'https://api.apify.com/v2/browser-info']) {
    check(`allow ${url}`, !(await guardBlocks(url)), 'not blocked by guard');
}

// Block public-host look-alikes, URL tricks, and metadata IPs.
const blockedTargets = [
    'https://example.com/',
    'https://evilapify.com/',
    'https://apify.com.evil.com/',
    'https://apify.com@evil.com/',
    'http://169.254.169.254/',
];
for (const url of blockedTargets) {
    check(`block ${url}`, await guardBlocks(url), 'blocked by guard');
}

// WebSocket and EventSource must not bypass the fetch guard.
function blocksConstruct(name: string, url: string): boolean {
    const Ctor = (globalThis as Record<string, unknown>)[name];
    if (typeof Ctor !== 'function') return true;
    try {
        new (Ctor as new (u: string) => unknown)(url);
        return false;
    } catch (e) {
        return /Blocked/.test((e as Error).message);
    }
}
check('WebSocket blocked', blocksConstruct('WebSocket', 'wss://echo.websocket.org'), 'no wss egress');
check('EventSource blocked', blocksConstruct('EventSource', 'https://example.com/sse'), 'no SSE egress');

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
