// Guard user fetches to apify.com and its subdomains.
// This module loads before usercode.js, including module-scope code.
// Internal API access uses env.INTERNAL_API, never an exported capability.
const realFetch = globalThis.fetch.bind(globalThis);

// Capture security-sensitive builtins before usercode.js can replace globals,
// prototype methods, static functions, or accessors. Add a poisoning test with each capture.
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

// runner.ts also uses this captured constructor for token-bearing API URLs.
export { RealURL };

// The leading dot rejects look-alikes such as evilapify.com.
export function isAllowedHost(hostname: string): boolean {
    const lowercased: string = stringToLowerCase.call(hostname);
    // Normalize a trailing FQDN dot without using another mutable method.
    const host: string = stringEndsWith.call(lowercased, '.') ? stringSlice.call(lowercased, 0, -1) : lowercased;
    return host === 'apify.com' || stringEndsWith.call(host, '.apify.com');
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof RealURL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return String(input);
}

// Parse and validate one URL; callers use the result for relative redirects.
export function validateUrl(input: RequestInfo | URL): URL {
    let url: URL;
    try {
        // RealURL defeats userinfo and path tricks, and cannot be hijacked by user code.
        url = new RealURL(requestUrl(input));
    } catch {
        throw new Error('Blocked fetch: only absolute http(s) URLs to apify.com are allowed');
    }
    // Captured getters prevent URL.prototype poisoning.
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

// Follow redirects manually so every Location passes the allowlist.
// Preserve WHATWG method/body behavior for 301/302/303/307/308.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

export function nextRedirectInit(init: RequestInit | undefined, status: number): RequestInit | undefined {
    const method: string = stringToUpperCase.call(init?.method ?? 'GET');
    const downgradeToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
    if (!downgradeToGet) return init;
    return { ...init, method: 'GET', body: undefined };
}

// Keep hop private so callers cannot bypass the redirect limit.
async function guardedFetchHop(input: RequestInfo | URL, init: RequestInit | undefined, hop: number): Promise<Response> {
    if (hop > MAX_REDIRECT_HOPS) {
        throw new Error(`Blocked fetch: exceeded ${MAX_REDIRECT_HOPS} redirects`);
    }
    const url = validateUrl(input);
    const response = await realFetch(input, { ...init, redirect: 'manual' });
    const status = responseStatus(response);
    if (!setHas(REDIRECT_STATUSES, status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    const nextUrl = new RealURL(location, url);
    return guardedFetchHop(nextUrl.href, nextRedirectInit(init, status), hop + 1);
}

export function guardedFetch(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
    return guardedFetchHop(input, init, 0);
}

// Lock fetch so user code cannot restore an unrestricted reference.
Object.defineProperty(globalThis, 'fetch', {
    value: (input: RequestInfo | URL, init?: RequestInit) => guardedFetch(input, init),
    writable: false,
    configurable: false,
    enumerable: true,
});

// Remove direct WebSocket and EventSource egress around the fetch guard.
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
