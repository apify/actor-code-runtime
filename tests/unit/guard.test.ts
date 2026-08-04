// Offline unit tests for URL validation, redirects, and builtin captures.
// Stub fetch before importing guard.ts because import installs the guard.
import { describe, expect, it, vi, beforeAll } from 'vitest';

let guard: typeof import('../../worker/guard.js');
let mockFetch: ReturnType<typeof vi.fn>;

beforeAll(async () => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    guard = await import('../../worker/guard.js');
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function redirectResponse(location: string, status: number): Response {
    return new Response(null, { status, headers: { location } });
}

describe('isAllowedHost', () => {
    it.each([
        ['apify.com', true],
        ['api.apify.com', true],
        ['deeply.nested.apify.com', true],
        ['APIFY.COM', true],
        ['apify.com.', true],
        ['evilapify.com', false],
        ['apify.com.evil.com', false],
        ['notapify.com', false],
        ['example.com', false],
    ])('%s -> %s', (hostname, expected) => {
        expect(guard.isAllowedHost(hostname)).toBe(expected);
    });

    // Regression test for String.prototype poisoning.
    it('still rejects a disallowed host after String.prototype.endsWith is poisoned', () => {
        const original = String.prototype.endsWith;
        // eslint-disable-next-line no-extend-native -- deliberately simulating the attack this test guards against
        String.prototype.endsWith = () => true;
        try {
            expect(guard.isAllowedHost('evil.com')).toBe(false);
        } finally {
            String.prototype.endsWith = original;
        }
    });
});

describe('validateUrl', () => {
    it('accepts an allowed https URL', () => {
        expect(guard.validateUrl('https://api.apify.com/v2/foo').hostname).toBe('api.apify.com');
    });

    it('accepts an allowed http URL', () => {
        expect(guard.validateUrl('http://apify.com/').hostname).toBe('apify.com');
    });

    it('rejects a disallowed host', () => {
        expect(() => guard.validateUrl('https://example.com/')).toThrow(/only apify\.com and its subdomains/);
    });

    it('rejects the userinfo trick (real host is evil.com)', () => {
        expect(() => guard.validateUrl('https://apify.com@evil.com/')).toThrow(/evil\.com/);
    });

    it('rejects the path trick (real host is evil.com)', () => {
        expect(() => guard.validateUrl('https://evil.com/apify.com')).toThrow(/evil\.com/);
    });

    it('rejects a non-http(s) protocol', () => {
        expect(() => guard.validateUrl('ftp://apify.com/')).toThrow(/protocol/);
    });

    it('rejects an unparseable URL', () => {
        expect(() => guard.validateUrl('not a url')).toThrow(/only absolute http\(s\) URLs/);
    });

    it('resolves a Request object by its .url', () => {
        expect(guard.validateUrl(new Request('https://apify.com/x')).hostname).toBe('apify.com');
    });

    // Regression test for URL constructor poisoning.
    it('still rejects a disallowed host after globalThis.URL is replaced with a lying constructor', () => {
        const OriginalURL = globalThis.URL;
        class LyingURL extends OriginalURL {
            get hostname() { return 'apify.com'; }
        }
        globalThis.URL = LyingURL;
        try {
            expect(() => guard.validateUrl('http://example.com/')).toThrow(/only apify\.com/);
        } finally {
            globalThis.URL = OriginalURL;
        }
    });
});

describe('nextRedirectInit', () => {
    it('303 downgrades GET regardless of original method', () => {
        expect(guard.nextRedirectInit({ method: 'POST', body: 'x' }, 303)).toEqual({ method: 'GET', body: undefined });
    });

    it('301 downgrades POST to GET', () => {
        expect(guard.nextRedirectInit({ method: 'POST', body: 'x' }, 301)).toEqual({ method: 'GET', body: undefined });
    });

    it('302 downgrades POST to GET', () => {
        expect(guard.nextRedirectInit({ method: 'POST', body: 'x' }, 302)).toEqual({ method: 'GET', body: undefined });
    });

    it('301 preserves a GET request unchanged', () => {
        const init = { method: 'GET' };
        expect(guard.nextRedirectInit(init, 301)).toBe(init);
    });

    it('307 preserves method and body', () => {
        const init = { method: 'POST', body: 'x' };
        expect(guard.nextRedirectInit(init, 307)).toBe(init);
    });

    it('308 preserves method and body', () => {
        const init = { method: 'POST', body: 'x' };
        expect(guard.nextRedirectInit(init, 308)).toBe(init);
    });

    it('defaults to GET when no method given', () => {
        expect(guard.nextRedirectInit(undefined, 303)).toEqual({ method: 'GET', body: undefined });
    });
});

describe('guardedFetch', () => {
    it('rejects a disallowed URL before making any request', async () => {
        mockFetch.mockClear();
        await expect(guard.guardedFetch('https://example.com/', undefined)).rejects.toThrow(/only apify\.com/);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('performs the request when the URL is allowed', async () => {
        mockFetch.mockClear();
        mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const response = await guard.guardedFetch('https://api.apify.com/v2/browser-info', undefined);
        expect(response.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(init.redirect).toBe('manual');
    });

    it('follows a redirect to another allowed host', async () => {
        mockFetch.mockClear();
        mockFetch
            .mockResolvedValueOnce(redirectResponse('https://sub.apify.com/next', 302))
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const response = await guard.guardedFetch('https://apify.com/start', undefined);
        expect(response.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[1][0]).toBe('https://sub.apify.com/next');
    });

    it('re-validates each redirect hop and blocks a hop to a disallowed host', async () => {
        mockFetch.mockClear();
        mockFetch.mockResolvedValueOnce(redirectResponse('https://evil.com/steal', 302));
        await expect(guard.guardedFetch('https://apify.com/start', undefined)).rejects.toThrow(/only apify\.com/);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('resolves a relative redirect Location against the current URL', async () => {
        mockFetch.mockClear();
        mockFetch
            .mockResolvedValueOnce(redirectResponse('/v2/next', 302))
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        await guard.guardedFetch('https://api.apify.com/v2/start', undefined);
        expect(mockFetch.mock.calls[1][0]).toBe('https://api.apify.com/v2/next');
    });

    it('downgrades a POST to GET on a 302, dropping the body', async () => {
        mockFetch.mockClear();
        mockFetch
            .mockResolvedValueOnce(redirectResponse('https://apify.com/next', 302))
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        await guard.guardedFetch('https://apify.com/start', { method: 'POST', body: 'payload' });
        const [, secondInit] = mockFetch.mock.calls[1];
        expect(secondInit.method).toBe('GET');
        expect(secondInit.body).toBeUndefined();
    });

    it('gives up after exactly MAX_REDIRECT_HOPS redirects to allowed hosts', async () => {
        // Pins the redirect limit through observable request count.
        mockFetch.mockClear();
        for (let i = 0; i < 10; i++) mockFetch.mockResolvedValueOnce(redirectResponse('https://apify.com/loop', 302));
        await expect(guard.guardedFetch('https://apify.com/start', undefined)).rejects.toThrow(/exceeded 5 redirects/);
        expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    it('returns a redirect response unchanged when it carries no Location header', async () => {
        mockFetch.mockClear();
        mockFetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
        const response = await guard.guardedFetch('https://apify.com/start', undefined);
        expect(response.status).toBe(302);
    });
});

describe('module exports', () => {
    it('never exports a raw/unrestricted fetch capability', () => {
        // Guard against exporting unrestricted fetch capabilities.
        const knownSafeExports = new Set([
            'isAllowedHost', 'validateUrl', 'nextRedirectInit', 'guardedFetch',
            'realObjectFreeze', 'setHas', 'numberIsFinite', 'mathMin', 'realNumber',
            'encodeUriComponent', 'jsonStringify', 'urlHostname', 'urlProtocol',
            'responseOk', 'responseStatus', 'RealURL',
        ]);
        for (const key of Object.keys(guard)) {
            expect(knownSafeExports.has(key)).toBe(true);
        }
    });
});

// Each captured builtin gets a poisoning regression test.
describe('captured builtins resist prototype/static-method poisoning', () => {
    it('realObjectFreeze still freezes after the global Object.freeze is replaced with a no-op', () => {
        const original = Object.freeze;
        Object.freeze = (<T>(o: T) => o) as typeof Object.freeze;
        try {
            const obj = guard.realObjectFreeze({ x: 1 });
            expect(Object.isFrozen(obj)).toBe(true);
        } finally {
            Object.freeze = original;
        }
    });

    it('setHas still reports true membership after Set.prototype.has is poisoned to always return false', () => {
        const original = Set.prototype.has;
        Set.prototype.has = () => false;
        try {
            expect(guard.setHas(new Set(['a']), 'a')).toBe(true);
        } finally {
            Set.prototype.has = original;
        }
    });

    it('numberIsFinite still rejects Infinity after the global Number.isFinite is poisoned to always return true', () => {
        const original = Number.isFinite;
        Number.isFinite = () => true;
        try {
            expect(guard.numberIsFinite(Infinity)).toBe(false);
        } finally {
            Number.isFinite = original;
        }
    });

    it('mathMin still returns the real minimum after the global Math.min is poisoned', () => {
        const original = Math.min;
        Math.min = (a) => a;
        try {
            expect(guard.mathMin(5, 2)).toBe(2);
        } finally {
            Math.min = original;
        }
    });

    it('realNumber still coerces correctly after the global Number is poisoned', () => {
        const original = globalThis.Number;
        // @ts-expect-error -- simulate a poisoned global.
        globalThis.Number = () => 999;
        try {
            expect(guard.realNumber('42')).toBe(42);
        } finally {
            globalThis.Number = original;
        }
    });

    it('encodeUriComponent still escapes after the global encodeURIComponent is poisoned to a no-op', () => {
        const original = globalThis.encodeURIComponent;
        globalThis.encodeURIComponent = (x) => String(x);
        try {
            expect(guard.encodeUriComponent('../secret')).toBe('..%2Fsecret');
        } finally {
            globalThis.encodeURIComponent = original;
        }
    });

    it('jsonStringify still serializes real data after the global JSON.stringify is poisoned', () => {
        const original = JSON.stringify;
        JSON.stringify = () => '{"forged":true}';
        try {
            expect(guard.jsonStringify({ real: 1 })).toBe('{"real":1}');
        } finally {
            JSON.stringify = original;
        }
    });

    it('responseOk still reads the real status after Response.prototype.ok is poisoned to always return true', () => {
        const original = Object.getOwnPropertyDescriptor(Response.prototype, 'ok')!;
        Object.defineProperty(Response.prototype, 'ok', { get: () => true, configurable: true });
        try {
            const failedResponse = new Response(null, { status: 500 });
            expect(guard.responseOk(failedResponse)).toBe(false);
        } finally {
            Object.defineProperty(Response.prototype, 'ok', original);
        }
    });

    it('urlHostname/urlProtocol still read the real values after URL.prototype accessors are poisoned', () => {
        const originalHostname = Object.getOwnPropertyDescriptor(URL.prototype, 'hostname')!;
        const originalProtocol = Object.getOwnPropertyDescriptor(URL.prototype, 'protocol')!;
        Object.defineProperty(URL.prototype, 'hostname', { get: () => 'apify.com', configurable: true });
        Object.defineProperty(URL.prototype, 'protocol', { get: () => 'https:', configurable: true });
        try {
            // Regression test for URL accessor poisoning.
            expect(() => guard.validateUrl('http://example.com/')).toThrow(/only apify\.com/);
        } finally {
            Object.defineProperty(URL.prototype, 'hostname', originalHostname);
            Object.defineProperty(URL.prototype, 'protocol', originalProtocol);
        }
    });
});
