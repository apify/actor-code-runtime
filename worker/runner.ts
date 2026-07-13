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
// Factored into a function (rather than a bare `const` + `if (!x) throw`) so the
// non-null guarantee is encoded in the return type once, here — TS doesn't carry
// a narrowed-from-null check across the later function declarations that close
// over `realFetch`, but a return type with the `null` branch already thrown away
// needs no further narrowing anywhere downstream.
function requireRealFetch(): typeof globalThis.fetch {
    const fetchFn = claimRealFetch();
    if (!fetchFn) throw new Error('realFetch already claimed — guard.js imported out of order.');
    return fetchFn;
}
const realFetch = requireRealFetch();

const DEFAULT_ITERATE_BATCH = 1000;
const DEFAULT_GET_SCHEMA_SAMPLE = 5;

// --- Types ---------------------------------------------------------------
// The Apify API returns many more fields per record than this code reads. Rather
// than inventing a full schema we don't have, ApifyRecord asserts nothing beyond
// "a JSON object" and each specific shape below only names the fields this code
// actually consumes.

interface ApifyRecord {
    [key: string]: unknown;
}

interface RunRecord extends ApifyRecord {
    id: string;
}

type SearchParamValue = string | number | boolean | undefined | null;
type SearchParams = Record<string, SearchParamValue>;

interface ApiCallOptions {
    searchParams?: SearchParams;
    body?: unknown;
    contentType?: string;
}

interface SearchOptions {
    query: string;
    limit?: number;
    category?: string;
}

interface ActorIdOptions {
    actorId: string;
}

interface StartOptions {
    actorId: string;
    input?: unknown;
    memoryMbytes?: number;
    timeoutSecs?: number;
    waitForFinishSecs?: number;
    maxTotalChargeUsd?: number;
    maxItems?: number;
}

interface RunAndGetItemsOptions extends StartOptions {
    fields?: string[];
    limit?: number;
}

interface RunIdOptions {
    runId: string;
}

interface WaitOptions extends RunIdOptions {
    waitForFinishSecs?: number;
}

interface GetLogOptions extends RunIdOptions {
    limit?: number;
}

interface DatasetListOptions {
    datasetId: string;
    fields?: string[];
    omit?: string[];
    limit?: number;
    offset?: number;
    clean?: boolean;
    desc?: boolean;
}

interface DatasetIterateOptions extends Omit<DatasetListOptions, 'offset'> {
    batchSize?: number;
}

interface DatasetSchemaOptions {
    datasetId: string;
    sample?: number;
}

interface DatasetSchema {
    itemCount: unknown;
    sampleSize: number;
    fields: { name: string; types: string[]; nullable: boolean }[];
}

interface CreateOptions {
    name?: string;
}

interface PushItemsOptions {
    datasetId: string;
    items: unknown[];
}

interface KvsGetOptions {
    storeId: string;
    key: string;
}

interface KvsSetOptions extends KvsGetOptions {
    value: unknown;
    contentType?: string;
}

interface KvsListOptions {
    storeId: string;
    limit?: number;
    exclusiveStartKey?: string;
}

interface ConsoleLike {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
}

interface Env {
    APIFY_TOKEN?: string;
    DEFAULT_DATASET_ID?: string;
    DEFAULT_DATASET_ID_LEGACY?: string;
    API_BASE_URL?: string;
}

interface OutputItem {
    stdout: string;
    stderr: string;
    exitCode: number;
    statusMessage: string;
}

// ---------------------------------------------------------------------------

function stringify(x: unknown): string {
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch { return String(x); }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function errorDetail(err: unknown): string {
    return err instanceof Error && err.stack ? err.stack : errorMessage(err);
}

function makeApifyBinding(token: string, apiV2: string) {
    const baseHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };

    // Build a URL with optional query params; null/undefined values are dropped.
    const buildUrl = (path: string, searchParams?: SearchParams): URL => {
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
    const apiCall = async (method: string, path: string, options: ApiCallOptions = {}): Promise<Response> => {
        const { searchParams, body, contentType } = options;
        const headers: Record<string, string> = { ...baseHeaders };
        let requestBody: BodyInit | undefined;
        if (body !== undefined) {
            if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
                // Cast: this TS/DOM-lib pairing types Uint8Array generically over its buffer,
                // which doesn't structurally match BodyInit here even though it's a valid
                // fetch body at runtime (an ArrayBufferView).
                requestBody = body as BodyInit;
                headers['content-type'] = contentType ?? 'application/octet-stream';
            } else {
                requestBody = JSON.stringify(body);
                headers['content-type'] = contentType ?? 'application/json';
            }
        }
        const response = await realFetch(buildUrl(path, searchParams), { method, headers, body: requestBody });
        if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
        return response;
    };

    // The Apify API's JSON envelope (`{ data: ... }`) carries whatever shape the endpoint
    // returns; there's no schema to check it against here, so this stays honestly `any`
    // rather than asserting a shape we haven't verified.
    const apiJson = async (method: string, path: string, options?: ApiCallOptions): Promise<any> =>
        (await apiCall(method, path, options)).json();
    const apiData = async (method: string, path: string, options?: ApiCallOptions): Promise<any> =>
        (await apiJson(method, path, options)).data;

    // Run IDs this script itself started, via actor.call() / actor.start() (and transitively
    // actor.callAndGetItems(), which shares createRun() below). run.abort() below is scoped to
    // this set — a script can only abort runs it started, not any account-wide runId it's
    // handed or guesses.
    const startedRunIds = new Set<string>();

    // POST /acts/:id/runs, shared by actor.call() (start+wait, waitForFinishSecs defaults to 60,
    // capped at 60s per the Apify API — for longer runs use start() + apify.run.waitForFinish())
    // and actor.start() (async kickoff, no wait). Returns the run record so the caller can read
    // defaultDatasetId / defaultKeyValueStoreId. Intentionally does NOT use /run-sync, which
    // returns the OUTPUT KVS record (a pattern only some Actors follow) rather than the
    // structured run record.
    const createRun = ({ actorId, input, memoryMbytes, timeoutSecs, waitForFinishSecs, maxTotalChargeUsd, maxItems }: StartOptions): Promise<RunRecord> =>
        apiData('POST', `/acts/${encodeURIComponent(actorId)}/runs`, {
            searchParams: {
                waitForFinish: waitForFinishSecs,
                memory: memoryMbytes,
                timeout: timeoutSecs,
                maxTotalChargeUsd,
                maxItems,
            },
            body: input ?? {},
        }).then((runRecord: RunRecord) => {
            startedRunIds.add(runRecord.id);
            return runRecord;
        });

    const actor = {
        // GET /v2/store — Apify Store search. Returns the items array directly.
        search: ({ query, limit, category }: SearchOptions): Promise<ApifyRecord[]> =>
            apiData('GET', '/store', { searchParams: { search: query, limit, category } })
                .then((page: { items: ApifyRecord[] }) => page.items),

        get: ({ actorId }: ActorIdOptions): Promise<ApifyRecord> =>
            apiData('GET', `/acts/${encodeURIComponent(actorId)}`),

        // Shared by run() and start(): both POST /acts/:id/runs, differing only in whether
        // waitForFinish is set. Records the created run's ID in startedRunIds so run.abort()
        // can be scoped to runs this script itself started (see the run.abort definition below).
        call: (opts: StartOptions): Promise<RunRecord> => createRun({ waitForFinishSecs: 60, ...opts }),

        // Async kickoff. Returns immediately with a run record in READY/RUNNING state.
        start: (opts: StartOptions): Promise<RunRecord> => createRun(opts),

        // Runs an Actor (same as call(), waitForFinishSecs defaults to 60) and returns its
        // dataset items in one call. Calls createRun() directly rather than through
        // `actor.call()` — same underlying request, no self-reference to `actor` needed.
        callAndGetItems: async ({ actorId, input, fields, limit, ...runOpts }: RunAndGetItemsOptions): Promise<{ run: RunRecord; items: ApifyRecord[] }> => {
            const runRecord = await createRun({ actorId, input, waitForFinishSecs: 60, ...runOpts });
            const items = await dataset.listItems({
                datasetId: runRecord.defaultDatasetId as string, fields, limit,
            });
            return { run: runRecord, items };
        },
    };

    const run = {
        get: ({ runId }: RunIdOptions): Promise<RunRecord> =>
            apiData('GET', `/actor-runs/${encodeURIComponent(runId)}`),

        // Block until the run terminates or `waitForFinishSecs` elapses (whichever comes first).
        // The Apify API caps this at 60s per request; longer waits require a polling loop.
        waitForFinish: ({ runId, waitForFinishSecs = 60 }: WaitOptions): Promise<RunRecord> =>
            apiData('GET', `/actor-runs/${encodeURIComponent(runId)}`, {
                searchParams: { waitForFinish: waitForFinishSecs },
            }),

        // Scoped to runs this script itself started (see startedRunIds above) — without this,
        // any runId a script is handed (e.g. read from a dataset item, or guessed) could abort
        // an unrelated, account-wide run.
        abort: ({ runId }: RunIdOptions): Promise<RunRecord> => {
            if (!startedRunIds.has(runId)) {
                throw new Error(`Blocked run.abort: "${runId}" was not started by this script`);
            }
            return apiData('POST', `/actor-runs/${encodeURIComponent(runId)}/abort`);
        },

        // Returns the full run log as text. `limit` tails the last N characters; the Apify API
        // does not paginate logs, so this is a client-side slice (the full body is fetched).
        getLog: async ({ runId, limit }: GetLogOptions): Promise<string> => {
            const response = await apiCall('GET', `/logs/${encodeURIComponent(runId)}`);
            const text = await response.text();
            return limit && text.length > limit ? text.slice(-limit) : text;
        },
    };

    const dataset = {
        // Returns the items array directly (no wrapper). The Apify API's
        // `x-apify-pagination-total` header is unreliable for freshly-created datasets
        // (eventually consistent), so we don't surface a `total`. Use `inferFields` if you
        // need an item count, or iterate to consume the whole dataset.
        listItems: async ({ datasetId, fields, omit, limit, offset, clean, desc }: DatasetListOptions): Promise<ApifyRecord[]> => {
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
        iterate: async function* ({ datasetId, fields, omit, clean, desc, batchSize = DEFAULT_ITERATE_BATCH }: DatasetIterateOptions): AsyncGenerator<ApifyRecord> {
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
        // Named inferFields (not getSchema) to avoid colliding with the Actor's own *declared*
        // dataset schema (a different concept, described in this Actor's own actor.json).
        inferFields: async ({ datasetId, sample = DEFAULT_GET_SCHEMA_SAMPLE }: DatasetSchemaOptions): Promise<DatasetSchema> => {
            const meta = await apiData('GET', `/datasets/${encodeURIComponent(datasetId)}`);
            const items = await dataset.listItems({ datasetId, limit: sample });
            const fields = new Map<string, Set<string>>();
            for (const item of items) {
                for (const [name, value] of Object.entries(item ?? {})) {
                    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
                    if (!fields.has(name)) fields.set(name, new Set());
                    fields.get(name)!.add(type);
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

        create: ({ name }: CreateOptions = {}): Promise<ApifyRecord> =>
            apiData('POST', '/datasets', { searchParams: { name } }),

        pushItems: async ({ datasetId, items }: PushItemsOptions): Promise<void> => {
            await apiCall('POST', `/datasets/${encodeURIComponent(datasetId)}/items`, { body: items });
        },
    };

    const kvs = {
        // Returns the value directly (parsed when JSON, string when text/*, Uint8Array otherwise).
        // Returns null when the key does not exist (404), not an error — this matches the common
        // "lookup or default" pattern in code.
        get: async ({ storeId, key }: KvsGetOptions): Promise<unknown> => {
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
        set: async ({ storeId, key, value, contentType }: KvsSetOptions): Promise<void> => {
            let body: BodyInit;
            let resolvedContentType = contentType;
            if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
                // Cast: see the equivalent Uint8Array-vs-BodyInit comment in apiCall() above.
                body = value as BodyInit;
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

        list: ({ storeId, limit, exclusiveStartKey }: KvsListOptions): Promise<ApifyRecord> =>
            apiData('GET', `/key-value-stores/${encodeURIComponent(storeId)}/keys`, {
                searchParams: { limit, exclusiveStartKey },
            }),

        create: ({ name }: CreateOptions = {}): Promise<ApifyRecord> =>
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
async function pushOutput(apiV2: string, token: string, env: Env, item: OutputItem): Promise<void> {
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
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/health') return new Response('ok');
        if (url.pathname !== '/run') return new Response('Not found', { status: 404 });

        const token = env.APIFY_TOKEN;
        if (!token) throw new Error('APIFY_TOKEN missing from Actor run environment.');
        // APIFY_API_BASE_URL is the platform-internal API (may have a trailing slash).
        const apiV2 = `${(env.API_BASE_URL || 'https://api.apify.com').replace(/\/+$/, '')}/v2`;

        const stdout: string[] = [];
        const stderr: string[] = [];
        // Frozen so the script can't reassign e.g. console.log to corrupt its own capture.
        const captureConsole: ConsoleLike = Object.freeze({
            log:   (...args: unknown[]) => stdout.push(args.map(stringify).join(' ')),
            error: (...args: unknown[]) => stderr.push(args.map(stringify).join(' ')),
            warn:  (...args: unknown[]) => stderr.push(args.map(stringify).join(' ')),
            info:  (...args: unknown[]) => stdout.push(args.map(stringify).join(' ')),
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
            stderr.push(errorDetail(err));
            exitCode = 1;
            statusMessage = `Script threw: ${errorMessage(err)}`;
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
