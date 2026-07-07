// Restrict the user program's outbound network to apify.com and its subdomains.
// Imported before usercode.js so the overrides are in place even for code that
// runs at module-evaluation time. Our own Apify API calls use the exported
// realFetch (the internal API is a private IP, not *.apify.com), so they are
// unaffected by this guard.
//
// Egress surface (workerd, no nodejs_compat): the only JS-reachable outbound
// primitives are fetch, WebSocket, and EventSource. Raw sockets (node:net,
// cloudflare:sockets connect()) need module imports, which are already blocked.
// fetch is allowlisted below; WebSocket and EventSource are removed outright
// because runner.js and the apify binding never use them — leaving them would
// be a non-fetch egress path around the allowlist (apify/ai-team#216 finding A,
// via WebSocket). If a future need arises, wrap them like fetch instead.

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

// Remove the non-fetch egress primitives. These are web-standard globals present
// even without nodejs_compat, and they connect directly (not through the fetch
// guard), so a script could otherwise open a wss:// or SSE connection to any
// public host and exfiltrate data around the *.apify.com allowlist.
function blockGlobal(name) {
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

export { realFetch };
