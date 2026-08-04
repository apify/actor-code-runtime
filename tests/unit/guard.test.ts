// Token-free, CI-runnable unit tests for worker/guard.ts's allowlist logic — no workerd,
// no `apify push`/`apify call`, no live Actor run. Fills the gap flagged in PR #1 review
// (2026-07-21): CI only ran `pnpm run typecheck`; every behavioral test required a live
// token, so `isAllowedHost`/`validateUrl`'s allowlist paths and `guardedFetch`'s redirect
// re-validation (the entire reason that function exists) had no test of any kind.
//
// guard.ts overrides `globalThis.fetch` as a side effect of being imported, and captures
// whatever `globalThis.fetch` was *at that moment* as its own internal `realFetch` (used by
// guardedFetch to perform the actual, pre-validated request). So: stub `globalThis.fetch`
// with a controllable mock BEFORE importing guard.ts, then call the exported `guardedFetch`
// directly — it runs against the mock, no network I/O, fully deterministic.
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
        ['APIFY.COM', true], // case-insensitive
        ['apify.com.', true], // trailing FQDN dot stripped
        ['evilapify.com', false], // suffix without the separating dot
        ['apify.com.evil.com', false], // real host is evil.com
        ['notapify.com', false],
        ['example.com', false],
    ])('%s -> %s', (hostname, expected) => {
        expect(guard.isAllowedHost(hostname)).toBe(expected);
    });

    // Regression test for a real bypass found in review: isAllowedHost used to call
    // `hostname.toLowerCase()`/`.endsWith()` directly, resolving through the live,
    // ordinary-script-writable `String.prototype` — no module-scope escape needed. See
    // guard.ts's capture-block comment for the fix (capture the actual method functions,
    // call them via .call() instead of value.method()).
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

    // Regression test for a real bypass found in review: validateUrl used to call the bare
    // `new URL(...)`, which resolves whatever `globalThis.URL` currently is. A script that
    // replaces it with a lying implementation (real .href, faked .hostname) could make
    // validateUrl believe a disallowed host was apify.com, with no module-scope-escape trick
    // needed at all — see guard.ts's capture-block comment for the fix (capture the real URL
    // constructor before usercode.js can ever run).
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
        expect(init.redirect).toBe('manual'); // never lets the underlying fetch auto-follow
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
        expect(mockFetch).toHaveBeenCalledTimes(1); // never followed the malicious hop
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
        // MAX_REDIRECT_HOPS is module-private (not exported — see guard.ts's own comment on
        // why nothing beyond the pure allowlist helpers is), so this pins the boundary by its
        // observable effect instead: guard.ts's `hop > MAX_REDIRECT_HOPS` check means calls at
        // hop 0..5 each make a real fetch (6 calls, MAX_REDIRECT_HOPS=5 + the initial request)
        // before hop 6 throws without calling fetch again. A change to MAX_REDIRECT_HOPS's
        // value, or an off-by-one in the `>` check, changes this exact count.
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
        // Regression guard for PR #1's finding: guard.js must never export anything that
        // hands the caller an unwrapped fetch function or a way to bypass the allowlist.
        // Every export must be one of these known-safe, pure helpers — realObjectFreeze/
        // setHas/numberIsFinite/mathMin are safe by the same reasoning: each is still just
        // the ordinary builtin operation, the concept itself carries no capability. See
        // guard.ts's capture-block comment for why they need to be exported at all.
        const knownSafeExports = new Set([
            'isAllowedHost', 'validateUrl', 'nextRedirectInit', 'guardedFetch',
            'realObjectFreeze', 'setHas', 'numberIsFinite', 'mathMin',
        ]);
        for (const key of Object.keys(guard)) {
            expect(knownSafeExports.has(key)).toBe(true);
        }
    });
});

// Regression tests for guard.ts's capture-block: capturing a builtin's *reference* only
// protects against `globalThis.X = somethingElse`. It does NOT protect a shared PROTOTYPE
// method or static function (`X.prototype.method = ...`, `Number.isFinite = ...`), which
// stays reachable through the still-live global name even if some OTHER code holds a
// captured constructor reference — a captured URL constructor's `.prototype` IS the same
// mutable object as the global `URL.prototype`. Each capture below needs its own resistance
// test; sharing one wouldn't prove the others are covered.
describe('captured builtins resist prototype/static-method poisoning', () => {
    it('realObjectFreeze still freezes after the global Object.freeze is replaced with a no-op', () => {
        const original = Object.freeze;
        Object.freeze = (<T>(o: T) => o) as typeof Object.freeze; // simulates a hijacked global, not a real no-op call site
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
        Math.min = (a) => a; // always "returns the first argument", the wrong answer when a > b
        try {
            expect(guard.mathMin(5, 2)).toBe(2);
        } finally {
            Math.min = original;
        }
    });
});
