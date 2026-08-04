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

    it('gives up after MAX_REDIRECT_HOPS redirects to allowed hosts', async () => {
        mockFetch.mockClear();
        for (let i = 0; i < 10; i++) mockFetch.mockResolvedValueOnce(redirectResponse('https://apify.com/loop', 302));
        await expect(guard.guardedFetch('https://apify.com/start', undefined)).rejects.toThrow(/exceeded/);
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
        // Every export must be one of these known-safe, pure helpers.
        const knownSafeExports = new Set(['isAllowedHost', 'validateUrl', 'nextRedirectInit', 'guardedFetch']);
        for (const key of Object.keys(guard)) {
            expect(knownSafeExports.has(key)).toBe(true);
        }
    });
});
