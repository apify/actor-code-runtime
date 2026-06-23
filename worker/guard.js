// Restrict the user program's global fetch() to apify.com and its subdomains.
// Imported before usercode.js so the override is in place even for code that
// runs at module-evaluation time. Our own Apify API calls use the exported
// realFetch (the internal API is a private IP, not *.apify.com), so they are
// unaffected by this guard.
//
// NOTE: this guards the fetch() API only. It is not a complete egress boundary —
// the airtight control is workerd's globalOutbound. See SECURITY notes in the repo.

const realFetch = globalThis.fetch.bind(globalThis);

// Match apify.com exactly or any subdomain. The leading dot in the suffix is
// what rejects look-alikes: `evilapify.com` (no dot) and `apify.com.evil.com`
// (ends with `.evil.com`) both fail.
function isAllowedHost(hostname) {
    const host = hostname.toLowerCase().replace(/\.$/, ''); // strip FQDN trailing dot
    return host === 'apify.com' || host.endsWith('.apify.com');
}

function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url; // Request
    return String(input);
}

globalThis.fetch = (input, init) => {
    let url;
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
    return realFetch(input, init);
};

export { realFetch };
