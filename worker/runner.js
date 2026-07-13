// Single worker for the per-run code-runtime Actor. It runs the user's program
// (imported from the generated `usercode.js` module) with the `apify` REST
// binding and a captured `console`, then pushes `{ stdout, stderr, exitCode,
// statusMessage }` to the run's default dataset. The container entrypoint
// generates `usercode.js`, boots workerd, and triggers `/run` once.
//
// Single-tenant: one run = one container = one program = one token. No Worker
// Loader / per-request isolate is needed — the program runs in this worker,
// which is itself the sandbox (no filesystem, restricted outbound network).
// guard.js must be imported before usercode.js: it overrides globalThis.fetch
// to allow only apify.com, and hands us the real, unrestricted fetch via a
// one-shot claimRealFetch() for our own (internal) API calls — see guard.js
// for why this is a claim, not a standing export.
import { claimRealFetch } from './guard.js';
import { run } from './usercode.js';

// Must run before usercode.js's `run()` is ever invoked (it does, here — module
// evaluation order puts this ahead of any dynamic import from inside `run()`).
const realFetch = claimRealFetch();
if (!realFetch) throw new Error('realFetch already claimed — guard.js imported out of order.');

const DEFAULT_ITERATE_BATCH = 1000;
const DEFAULT_GET_SCHEMA_SAMPLE = 5;

function stringify(x) {
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch { return String(x); }
}

function makeApifyBinding(token, apiV2) {
    const baseHeaders = { Authorization: `Bearer ${token}` };

    // Build a URL with optional query params; null/undefined values are dropped.
    const buildUrl = (path, searchParams) => {
        const url = new URL(`${apiV2}${path}`);
        if (searchParams) {
            for (const [key, value] of Object.entries(searchParams)) {
                if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
            }
        }
        return url;
    };

    // Single-source HTTP wrapper. Throws on non-2xx with the response body in the message.
    // `body`: string / Uint8Array passed through; objects are JSON.stringify'd.
    const apiCall = async (method, path, { searchParams, body, contentType } = {}) => {
        const init = { method, headers: { ...baseHeaders } };
        if (body !== undefined) {
            const isRaw = typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer;
            init.body = isRaw ? body : JSON.stringify(body);
            init.headers['content-type'] = contentType ?? (isRaw ? 'application/octet-stream' : 'application/json');
        }
        const response = await realFetch(buildUrl(path, searchParams), init);
        if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
        return response;
    };

    const apiJson = async (...args) => (await apiCall(...args)).json();
    const apiData = async (...args) => (await apiJson(...args)).data;

    // Run IDs this script itself started, via actor.run() / actor.start() (and transitively
    // actor.runAndGetItems(), which calls actor.run()). run.abort() below is scoped to this
    // set — a script can only abort runs it started, not any account-wide runId it's handed
    // or guesses.
    const startedRunIds = new Set();

    // POST /acts/:id/runs, shared by actor.run() (start+wait, waitForFinishSecs defaults to 60,
    // capped at 60s per the Apify API — for longer runs use start() + apify.run.wait()) and
    // actor.start() (async kickoff, no wait). Returns the run record so the caller can read
    // defaultDatasetId / defaultKeyValueStoreId. Intentionally does NOT use /run-sync, which
    // returns the OUTPUT KVS record (a pattern only some Actors follow) rather than the
    // structured run record.
    const createRun = ({ actorId, input, memoryMbytes, timeoutSecs, waitForFinishSecs, maxTotalChargeUsd, maxItems }) =>
        apiData('POST', `/acts/${encodeURIComponent(actorId)}/runs`, {
            searchParams: {
                waitForFinish: waitForFinishSecs,
                memory: memoryMbytes,
                timeout: timeoutSecs,
                maxTotalChargeUsd,
                maxItems,
            },
            body: input ?? {},
        }).then((runRecord) => {
            startedRunIds.add(runRecord.id);
            return runRecord;
        });

    const actor = {
        // GET /v2/store — Apify Store search. Returns the items array directly.
        search: ({ query, limit, category }) =>
            apiData('GET', '/store', { searchParams: { search: query, limit, category } })
                .then((page) => page.items),

        getDetails: ({ actorId }) =>
            apiData('GET', `/acts/${encodeURIComponent(actorId)}`),

        // Shared by run() and start(): both POST /acts/:id/runs, differing only in whether
        // waitForFinish is set. Records the created run's ID in startedRunIds so run.abort()
        // can be scoped to runs this script itself started (see the run.abort definition below).
        run: (opts) => createRun({ waitForFinishSecs: 60, ...opts }),

        // Async kickoff. Returns immediately with a run record in READY/RUNNING state.
        start: (opts) => createRun(opts),
        // runAndGetItems is added below once `dataset.listItems` is defined.
    };

    const run = {
        get: ({ runId }) =>
            apiData('GET', `/actor-runs/${encodeURIComponent(runId)}`),

        // Block until the run terminates or `waitForFinishSecs` elapses (whichever comes first).
        // The Apify API caps this at 60s per request; longer waits require a polling loop.
        wait: ({ runId, waitForFinishSecs = 60 }) =>
            apiData('GET', `/actor-runs/${encodeURIComponent(runId)}`, {
                searchParams: { waitForFinish: waitForFinishSecs },
            }),

        // Scoped to runs this script itself started (see startedRunIds above) — without this,
        // any runId a script is handed (e.g. read from a dataset item, or guessed) could abort
        // an unrelated, account-wide run.
        abort: ({ runId }) => {
            if (!startedRunIds.has(runId)) {
                throw new Error(`Blocked run.abort: "${runId}" was not started by this script`);
            }
            return apiData('POST', `/actor-runs/${encodeURIComponent(runId)}/abort`);
        },

        // Returns the full run log as text. `limit` tails the last N characters; the Apify API
        // does not paginate logs, so this is a client-side slice (the full body is fetched).
        getLog: async ({ runId, limit }) => {
            const response = await apiCall('GET', `/logs/${encodeURIComponent(runId)}`);
            const text = await response.text();
            return limit && text.length > limit ? text.slice(-limit) : text;
        },
    };

    const dataset = {
        // Returns the items array directly (no wrapper). The Apify API's
        // `x-apify-pagination-total` header is unreliable for freshly-created datasets
        // (eventually consistent), so we don't surface a `total`. Use `getSchema` if you
        // need an item count, or iterate to consume the whole dataset.
        listItems: async ({ datasetId, fields, omit, limit, offset, clean, desc }) => {
            const response = await apiCall('GET', `/datasets/${encodeURIComponent(datasetId)}/items`, {
                searchParams: {
                    fields: fields?.join(','),
                    omit: omit?.join(','),
                    limit,
                    offset,
                    clean: clean ? '1' : undefined,
                    desc: desc ? '1' : undefined,
                },
            });
            return response.json();
        },

        // Async generator over the entire dataset. Pages internally in `batchSize` chunks
        // so the user can `for await (const item of apify.dataset.iterate({...}))` without
        // worrying about offsets. Stops when a page returns fewer items than `batchSize`
        // (the natural end-of-data signal — pagination total is not used, see listItems).
        iterate: async function* ({ datasetId, fields, omit, clean, desc, batchSize = DEFAULT_ITERATE_BATCH }) {
            let offset = 0;
            while (true) {
                const items = await dataset.listItems({
                    datasetId, fields, omit, clean, desc,
                    limit: batchSize, offset,
                });
                if (items.length === 0) break;
                for (const item of items) yield item;
                if (items.length < batchSize) break;
                offset += items.length;
            }
        },

        // Apify has no dedicated schema endpoint; we infer one from a small sample of items.
        // Returns { itemCount, sampleSize, fields: [{ name, types, nullable }] }.
        getSchema: async ({ datasetId, sample = DEFAULT_GET_SCHEMA_SAMPLE }) => {
            const meta = await apiData('GET', `/datasets/${encodeURIComponent(datasetId)}`);
            const items = await dataset.listItems({ datasetId, limit: sample });
            const fields = new Map();
            for (const item of items) {
                for (const [name, value] of Object.entries(item ?? {})) {
                    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
                    if (!fields.has(name)) fields.set(name, new Set());
                    fields.get(name).add(type);
                }
            }
            return {
                itemCount: meta?.itemCount,
                sampleSize: items.length,
                fields: [...fields.entries()].map(([name, types]) => ({
                    name,
                    types: [...types],
                    nullable: types.has('null'),
                })),
            };
        },

        create: ({ name } = {}) =>
            apiData('POST', '/datasets', { searchParams: { name } }),

        pushItems: async ({ datasetId, items }) => {
            await apiCall('POST', `/datasets/${encodeURIComponent(datasetId)}/items`, { body: items });
        },
    };

    actor.runAndGetItems = async ({ actorId, input, fields, limit, ...runOpts }) => {
        const runRecord = await actor.run({ actorId, input, ...runOpts });
        const items = await dataset.listItems({
            datasetId: runRecord.defaultDatasetId, fields, limit,
        });
        return { run: runRecord, items };
    };

    const kvs = {
        // Returns the value directly (parsed when JSON, string when text/*, Uint8Array otherwise).
        // Returns null when the key does not exist (404), not an error — this matches the common
        // "lookup or default" pattern in code.
        get: async ({ storeId, key }) => {
            const response = await realFetch(buildUrl(`/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(key)}`), {
                headers: baseHeaders,
            });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`GET kvs.get failed: ${response.status} ${await response.text()}`);
            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('application/json')) return response.json();
            if (contentType.startsWith('text/')) return response.text();
            return new Uint8Array(await response.arrayBuffer());
        },

        // `value`: object → application/json; string → text/plain; Uint8Array/ArrayBuffer →
        // application/octet-stream (or whatever the caller passed via `contentType`).
        set: async ({ storeId, key, value, contentType }) => {
            let body;
            let resolvedContentType = contentType;
            if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
                body = value;
                resolvedContentType = resolvedContentType ?? 'application/octet-stream';
            } else if (typeof value === 'string') {
                body = value;
                resolvedContentType = resolvedContentType ?? 'text/plain; charset=utf-8';
            } else {
                body = JSON.stringify(value);
                resolvedContentType = resolvedContentType ?? 'application/json; charset=utf-8';
            }
            await apiCall('PUT', `/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(key)}`, {
                body, contentType: resolvedContentType,
            });
        },

        list: ({ storeId, limit, exclusiveStartKey }) =>
            apiData('GET', `/key-value-stores/${encodeURIComponent(storeId)}/keys`, {
                searchParams: { limit, exclusiveStartKey },
            }),

        create: ({ name } = {}) =>
            apiData('POST', '/key-value-stores', { searchParams: { name } }),
    };

    // Freeze every namespace (and the wrapper) so the script can't reassign a method to
    // corrupt its own behavior or, for `console` below, its own output capture.
    return Object.freeze({
        actor: Object.freeze(actor),
        run: Object.freeze(run),
        dataset: Object.freeze(dataset),
        kvs: Object.freeze(kvs),
    });
}

// Push the captured streams as a single item to the run's default dataset.
async function pushOutput(apiV2, token, env, item) {
    const datasetId = env.DEFAULT_DATASET_ID || env.DEFAULT_DATASET_ID_LEGACY;
    if (!datasetId) throw new Error('Default dataset ID missing from Actor run environment.');
    const response = await realFetch(`${apiV2}/datasets/${encodeURIComponent(datasetId)}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(item),
    });
    if (!response.ok) throw new Error(`Failed to push dataset item: ${response.status} ${await response.text()}`);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/health') return new Response('ok');
        if (url.pathname !== '/run') return new Response('Not found', { status: 404 });

        const token = env.APIFY_TOKEN;
        if (!token) throw new Error('APIFY_TOKEN missing from Actor run environment.');
        // APIFY_API_BASE_URL is the platform-internal API (may have a trailing slash).
        const apiV2 = `${(env.API_BASE_URL || 'https://api.apify.com').replace(/\/+$/, '')}/v2`;

        const stdout = [];
        const stderr = [];
        // Frozen so the script can't reassign e.g. console.log to corrupt its own capture.
        const captureConsole = Object.freeze({
            log:   (...args) => stdout.push(args.map(stringify).join(' ')),
            error: (...args) => stderr.push(args.map(stringify).join(' ')),
            warn:  (...args) => stderr.push(args.map(stringify).join(' ')),
            info:  (...args) => stdout.push(args.map(stringify).join(' ')),
        });

        // A thrown program is a user-level failure: capture it in stderr and still
        // push the output, so the run SUCCEEDS with diagnostics. Infra failures
        // (missing env, dataset push) throw and fail the run.
        //
        // exitCode is the user script's effective status, distinct from the Actor run's
        // status: 0 when the script returns normally, 1 when it throws. The run itself
        // still SUCCEEDS on a throw, so callers detect a failed script via this field
        // rather than heuristics on stderr (console.error is a legitimate log channel).
        // statusMessage carries the same signal in prose, for callers that don't want to
        // branch on exitCode. A script that fails to *compile* never reaches this handler at
        // all (workerd fails the whole run before any request arrives) — entrypoint.sh
        // handles that case directly, see its statusMessage "Failed to compile: ...".
        let exitCode = 0;
        let statusMessage = 'Script completed';
        try {
            await run(makeApifyBinding(token, apiV2), captureConsole);
        } catch (err) {
            const message = err?.message ?? String(err);
            stderr.push(err?.stack ?? message);
            exitCode = 1;
            statusMessage = `Script threw: ${message}`;
        }

        await pushOutput(apiV2, token, env, {
            stdout: stdout.join('\n'),
            stderr: stderr.join('\n'),
            exitCode,
            statusMessage,
        });
        return Response.json({ ok: true });
    },
};
