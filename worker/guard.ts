// Restrict the user program's outbound network to apify.com and its subdomains.
// Imported before usercode.js so the overrides are in place even for code that
// runs at module-evaluation time.
//
// Egress surface (workerd, no nodejs_compat): the only JS-reachable outbound
// primitives are fetch, WebSocket, and EventSource. Raw sockets (node:net,
// cloudflare:sockets connect()) need module imports, which are already blocked.
// fetch is allowlisted below; WebSocket and EventSource are removed outright
// because runner.js and the apify binding never use them — leaving them would
// be a non-fetch egress path around the allowlist (apify/ai-team#216 finding A,
// via WebSocket). If a future need arises, wrap them like fetch instead.
//
// This module used to also hand runner.js an unrestricted "real fetch" for its
// own internal API calls, via a pair of exports (markRequestHandlingStarted /
// claimRealFetch). That capability-through-export design was broken: anything
// in usercode.js's module scope can `import('./guard.js')` too (ES modules
// have no notion of a "trusted" importer), so user code could call the same
// exports runner.js did and steal the unrestricted fetch before runner.js's
// own claim ran (PR #1 review, 2026-07-21 and again 2026-08-01 — the second
// round found the first fix's gate was itself still an exported, callable
// setter). Any function this module exports is equally reachable from
// usercode.js, so no export-based gate can be made sound.
//
// The actual fix moves runner.js's internal API access off of a module export
// entirely and onto workerd's own env binding (`INTERNAL_API` in
// config.capnp, wired to a separate outbound network service — see there).
// `env` is a parameter workerd hands only to the genuinely-dispatched
// `fetch(request, env)` call; nothing at module-evaluation time (including an
// escaped top-level statement in usercode.js) ever receives a reference to
// it, so there is nothing here for user code to import or steal. This module
// no longer needs to capture or export a privileged fetch at all.
const realFetch = globalThis.fetch.bind(globalThis);

// Captured before usercode.js's module body ever runs (see runner.ts's import-order
// comment — guard.js's own top-level code, including this line, always finishes first).
// `new URL(...)` and `instanceof URL` below resolve the identifier `URL` from scope, which
// is just `globalThis.URL` — an ordinary, reassignable global. A script that replaces it
// (`globalThis.URL = class FakeURL extends URL { get hostname() { return 'apify.com'; } }`)
// would make every validation call below trust a lying parser while the *string* actually
// handed to realFetch is untouched, defeating the allowlist with no module-scope-escape
// trick needed at all — this file's own `Object.defineProperty(globalThis, 'fetch', ...)`
// below is exactly this same "capture the real one before a script can swap it" pattern,
// applied here to the other builtin this file's security check depends on.
const RealURL = globalThis.URL;

// Same capture-before-usercode-runs reasoning, for a different consumer: runner.ts's own
// `Object.freeze(...)` calls (on the `apify` binding, `console`, and its default export) are
// top-level code that runs AFTER usercode.js's module body (see runner.ts's import-order
// comment), so escaped top-level code could reassign the global `Object.freeze` to a no-op
// before runner.ts ever calls it — silently defeating every "frozen so the script can't
// reassign this" guarantee there. Exporting a pre-captured reference is safe (it's still
// just Object.freeze; the concept itself carries no capability) and closes that gap.
export const realObjectFreeze: typeof Object.freeze = Object.freeze.bind(Object);

// Match apify.com exactly or any subdomain. The leading dot in the suffix is
// what rejects look-alikes: `evilapify.com` (no dot) and `apify.com.evil.com`
// (ends with `.evil.com`) both fail.
export function isAllowedHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, ''); // strip FQDN trailing dot
    return host === 'apify.com' || host.endsWith('.apify.com');
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof RealURL) return input.href;
    if (input && typeof input.url === 'string') return input.url; // Request
    return String(input);
}

// Parses and validates one URL against the allowlist. Returns the parsed URL
// (callers use it to resolve a relative redirect Location) or throws.
export function validateUrl(input: RequestInfo | URL): URL {
    let url: URL;
    try {
        // Parse to the real host — defeats userinfo (`apify.com@evil.com`),
        // path/query/fragment (`evil.com/apify.com`) and similar tricks. Uses RealURL
        // (see above), not the bare global, so a hijacked globalThis.URL can't lie here.
        url = new RealURL(requestUrl(input));
    } catch {
        throw new Error('Blocked fetch: only absolute http(s) URLs to apify.com are allowed');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`Blocked fetch: protocol "${url.protocol}" is not allowed`);
    }
    if (!isAllowedHost(url.hostname)) {
        throw new Error(`Blocked fetch to "${url.hostname}": only apify.com and its subdomains are allowed`);
    }
    return url;
}

// fetch() follows redirects internally by default, invisibly to a wrapper that
// only checks the initial URL — an allowlisted host could 302 to anywhere.
// Follow redirects ourselves, one hop at a time, and re-validate each Location
// against the allowlist before following it. Status-to-method mapping matches
// the WHATWG fetch spec: 303 always downgrades to GET; 301/302 downgrade to
// GET only when the original method was POST; 307/308 preserve method + body.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

export function nextRedirectInit(init: RequestInit | undefined, status: number): RequestInit | undefined {
    const method = (init?.method ?? 'GET').toUpperCase();
    const downgradeToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
    if (!downgradeToGet) return init;
    return { ...init, method: 'GET', body: undefined };
}

// `hop` is an internal recursion counter, not part of the public contract — kept unexported
// so a caller (including escaped usercode.js, which can import and call any export of this
// module) can't pass a pre-inflated or negative value to defeat MAX_REDIRECT_HOPS.
async function guardedFetchHop(input: RequestInfo | URL, init: RequestInit | undefined, hop: number): Promise<Response> {
    if (hop > MAX_REDIRECT_HOPS) {
        throw new Error(`Blocked fetch: exceeded ${MAX_REDIRECT_HOPS} redirects`);
    }
    const url = validateUrl(input);
    const response = await realFetch(input, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response; // redirect status with no Location: nothing to follow
    const nextUrl = new RealURL(location, url); // resolves a relative Location against the current URL
    return guardedFetchHop(nextUrl.href, nextRedirectInit(init, response.status), hop + 1);
}

export function guardedFetch(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
    return guardedFetchHop(input, init, 0);
}

// writable:false + configurable:false, matching blockGlobal() below — a plain
// assignment could be overwritten or deleted by the sandboxed script to
// recover the ambient (real, unrestricted) fetch reference some engines
// expose under a different name; locking it closes that off.
Object.defineProperty(globalThis, 'fetch', {
    value: (input: RequestInfo | URL, init?: RequestInit) => guardedFetch(input, init),
    writable: false,
    configurable: false,
    enumerable: true,
});

// Remove the non-fetch egress primitives. These are web-standard globals present
// even without nodejs_compat, and they connect directly (not through the fetch
// guard), so a script could otherwise open a wss:// or SSE connection to any
// public host and exfiltrate data around the *.apify.com allowlist.
function blockGlobal(name: string): void {
    const blocked = function () {
        throw new Error(`Blocked ${name}: only fetch() to apify.com and its subdomains is allowed`);
    };
    Object.defineProperty(globalThis, name, {
        value: blocked,
        writable: false,
        configurable: false,
        enumerable: false,
    });
}
for (const name of ['WebSocket', 'EventSource']) {
    if (name in globalThis) blockGlobal(name);
}
