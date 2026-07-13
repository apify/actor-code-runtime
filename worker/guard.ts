// Restrict the user program's outbound network to apify.com and its subdomains.
// Imported before usercode.js so the overrides are in place even for code that
// runs at module-evaluation time. Our own Apify API calls use the real,
// unrestricted fetch (the internal API is a private IP, not *.apify.com) —
// see claimRealFetch() below for how runner.js gets it without leaving it
// reachable from user code.
//
// Egress surface (workerd, no nodejs_compat): the only JS-reachable outbound
// primitives are fetch, WebSocket, and EventSource. Raw sockets (node:net,
// cloudflare:sockets connect()) need module imports, which are already blocked.
// fetch is allowlisted below; WebSocket and EventSource are removed outright
// because runner.js and the apify binding never use them — leaving them would
// be a non-fetch egress path around the allowlist (apify/ai-team#216 finding A,
// via WebSocket). If a future need arises, wrap them like fetch instead.

const realFetch = globalThis.fetch.bind(globalThis);

// One-shot handoff of the unrestricted fetch to runner.js. ES modules are
// evaluated once and cached, so `guard.js` is the same module instance no
// matter who imports it. runner.js imports this module (and calls
// claimRealFetch()) before usercode.js is ever imported, so it always claims
// first. If the sandboxed script later does `await import('./guard.js')` to
// try to recover the unrestricted fetch, it gets this same cached instance —
// but the value is already gone. A standing `export { realFetch }` would hand
// it to that later import too; don't reintroduce one.
let unclaimedRealFetch: typeof realFetch | null = realFetch;
export function claimRealFetch(): typeof realFetch | null {
    const fetchFn = unclaimedRealFetch;
    unclaimedRealFetch = null;
    return fetchFn;
}

// Match apify.com exactly or any subdomain. The leading dot in the suffix is
// what rejects look-alikes: `evilapify.com` (no dot) and `apify.com.evil.com`
// (ends with `.evil.com`) both fail.
function isAllowedHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, ''); // strip FQDN trailing dot
    return host === 'apify.com' || host.endsWith('.apify.com');
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url; // Request
    return String(input);
}

// Parses and validates one URL against the allowlist. Returns the parsed URL
// (callers use it to resolve a relative redirect Location) or throws.
function validateUrl(input: RequestInfo | URL): URL {
    let url: URL;
    try {
        // Parse to the real host — defeats userinfo (`apify.com@evil.com`),
        // path/query/fragment (`evil.com/apify.com`) and similar tricks.
        url = new URL(requestUrl(input));
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

function nextRedirectInit(init: RequestInit | undefined, status: number): RequestInit | undefined {
    const method = (init?.method ?? 'GET').toUpperCase();
    const downgradeToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
    if (!downgradeToGet) return init;
    return { ...init, method: 'GET', body: undefined };
}

async function guardedFetch(input: RequestInfo | URL, init: RequestInit | undefined, hop = 0): Promise<Response> {
    if (hop > MAX_REDIRECT_HOPS) {
        throw new Error(`Blocked fetch: exceeded ${MAX_REDIRECT_HOPS} redirects`);
    }
    const url = validateUrl(input);
    const response = await realFetch(input, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response; // redirect status with no Location: nothing to follow
    const nextUrl = new URL(location, url); // resolves a relative Location against the current URL
    return guardedFetch(nextUrl.href, nextRedirectInit(init, response.status), hop + 1);
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
