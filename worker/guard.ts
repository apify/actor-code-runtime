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
// This module used to also hand runner.js an unrestricted "real fetch" for its own
// internal API calls via a pair of exports. That capability-through-export design was
// broken: anything in usercode.js's module scope can `import('./guard.js')` too (ES
// modules have no notion of a "trusted" importer), so user code could call the same
// exports runner.js did and steal the capability before runner.js's own use of it. The fix
// moves runner.js's internal API access off of any module export entirely and onto
// workerd's own env binding (`INTERNAL_API` in config.capnp, wired to a separate outbound
// network service — see there). `env` is a parameter workerd hands only to the
// genuinely-dispatched `fetch(request, env)` call; nothing at module-evaluation time
// (including an escaped top-level statement in usercode.js) ever receives a reference to
// it, so there is nothing here for user code to import or steal.
const realFetch = globalThis.fetch.bind(globalThis);

// Every name below is captured HERE, at guard.js's own module-evaluation time — which
// always finishes before usercode.js's module body ever runs (see runner.ts's import-order
// comment) — because an ordinary script, no module-scope escape needed, can reassign or
// monkey-patch any JS builtin this file's (or runner.ts's) security decisions depend on.
// Three attack shapes, all closed the same way (capture the real thing before a script
// gets the chance to touch it):
//   - Reassigning the global itself (`globalThis.URL = FakeClass`,
//     `globalThis.encodeURIComponent = x => x`) — defeated by capturing a direct reference.
//   - Poisoning a shared PROTOTYPE method or static function (`String.prototype.endsWith =
//     () => true`, `Set.prototype.has = () => true`, `Number.isFinite = () => true`) — a
//     captured *constructor* reference does NOT protect this (`RealURL.prototype` IS
//     `URL.prototype`, the same mutable object the still-live global name reaches). Fixed
//     by capturing the METHOD/FUNCTION itself and invoking it directly
//     (`stringEndsWith.call(host, suffix)`), never through the poisonable `value.method()`.
//   - Poisoning a shared PROTOTYPE ACCESSOR/getter (`Object.defineProperty(URL.prototype,
//     'hostname', { get: () => 'apify.com' })`) — same fix, one level removed: capture the
//     getter FUNCTION and invoke it via `.call(instance)` instead of reading
//     `instance.property`.
// This block is the whole audit surface: anything guard.ts or runner.ts uses to make a
// security/allowlist/ownership/budget decision belongs here, not called bare. Multiple real
// bypasses of exactly this shape were found in review before this was made systematic. When
// adding a new capture here, follow the plain descriptive name already used below (not the
// older `real`+Name scheme on the first two, kept as-is to avoid unrelated call-site churn),
// and add a poisoning-regression test in tests/unit/guard.test.ts mirroring the existing ones.
const RealURL = globalThis.URL;
export const realObjectFreeze: typeof Object.freeze = Object.freeze.bind(Object);
const stringToLowerCase = String.prototype.toLowerCase;
const stringToUpperCase = String.prototype.toUpperCase;
const stringEndsWith = String.prototype.endsWith;
const stringSlice = String.prototype.slice;
const setHasMethod = Set.prototype.has;
export const setHas = <T>(set: ReadonlySet<T>, value: T): boolean => setHasMethod.call(set, value);
export const numberIsFinite: (value: unknown) => boolean = Number.isFinite;
export const mathMin: (a: number, b: number) => number = Math.min;
export const realNumber: (value: unknown) => number = Number;
export const encodeUriComponent: (value: string) => string = globalThis.encodeURIComponent;
export const jsonStringify: (value: unknown) => string = JSON.stringify.bind(JSON);
const urlHostnameGetter = Object.getOwnPropertyDescriptor(RealURL.prototype, 'hostname')!.get!;
const urlProtocolGetter = Object.getOwnPropertyDescriptor(RealURL.prototype, 'protocol')!.get!;
export const urlHostname = (url: URL): string => urlHostnameGetter.call(url);
export const urlProtocol = (url: URL): string => urlProtocolGetter.call(url);
const responseOkGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'ok')!.get!;
const responseStatusGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'status')!.get!;
export const responseOk = (response: Response): boolean => responseOkGetter.call(response);
export const responseStatus = (response: Response): number => responseStatusGetter.call(response);

// Exported so runner.ts's own internal-API URL building (buildUrl in runner.ts) uses the
// same captured, un-hijackable constructor this file's own allowlist relies on — a second,
// independent `new URL(...)` call site is just as reachable/poisonable as this file's own,
// and runner.ts's version builds the URL for the unrestricted, token-bearing internal API
// call, making it the higher-severity of the two if missed.
export { RealURL };

// Match apify.com exactly or any subdomain. The leading dot in the suffix is
// what rejects look-alikes: `evilapify.com` (no dot) and `apify.com.evil.com`
// (ends with `.evil.com`) both fail. Uses the captured string-method references above (see
// this file's capture block), not `hostname.toLowerCase()`/`.endsWith()` directly — those
// resolve through the live, poisonable `String.prototype` at call time.
export function isAllowedHost(hostname: string): boolean {
    const lowercased: string = stringToLowerCase.call(hostname);
    // Strip a trailing FQDN dot (`apify.com.` -> `apify.com`) via slice, not `.replace(/\.$/, '')`
    // — same captured-primitive reasoning as everything else in this block, one fewer method
    // to capture.
    const host: string = stringEndsWith.call(lowercased, '.') ? stringSlice.call(lowercased, 0, -1) : lowercased;
    return host === 'apify.com' || stringEndsWith.call(host, '.apify.com');
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
        // (see the capture block above), not the bare global, so a hijacked globalThis.URL
        // can't lie here.
        url = new RealURL(requestUrl(input));
    } catch {
        throw new Error('Blocked fetch: only absolute http(s) URLs to apify.com are allowed');
    }
    // Read via the captured getters (see the capture block above), not `url.protocol`/
    // `url.hostname` directly — those resolve through URL.prototype's own accessors, which
    // are poisonable the same way a prototype method is (RealURL.prototype IS URL.prototype).
    const protocol = urlProtocol(url);
    if (protocol !== 'https:' && protocol !== 'http:') {
        throw new Error(`Blocked fetch: protocol "${protocol}" is not allowed`);
    }
    const hostname = urlHostname(url);
    if (!isAllowedHost(hostname)) {
        throw new Error(`Blocked fetch to "${hostname}": only apify.com and its subdomains are allowed`);
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
    const method: string = stringToUpperCase.call(init?.method ?? 'GET');
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
    const status = responseStatus(response);
    if (!setHas(REDIRECT_STATUSES, status)) return response;
    const location = response.headers.get('location');
    if (!location) return response; // redirect status with no Location: nothing to follow
    const nextUrl = new RealURL(location, url); // resolves a relative Location against the current URL
    return guardedFetchHop(nextUrl.href, nextRedirectInit(init, status), hop + 1);
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
