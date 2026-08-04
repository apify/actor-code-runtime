// Single worker for the per-run code-runtime Actor. It runs the user's program
// (imported from the generated `usercode.js` module) with the `apify` REST
// binding and a captured `console`, then pushes `{ stdout, stderr, exitCode,
// statusMessage }` to the run's default dataset. The container entrypoint
// generates `usercode.js`, boots workerd, and triggers `/run` once.
//
// Single-tenant: one run = one container = one program = one token. No Worker
// Loader / per-request isolate is needed — the program runs in this worker,
// which is itself the sandbox (no filesystem, restricted outbound network).
// guard.js overrides globalThis.fetch to allow only apify.com.
//
// This worker's own (internal) API calls need an unrestricted, un-allowlisted
// fetch — the internal API is a private IP, not *.apify.com. That capability
// is bound as `env.INTERNAL_API` (config.capnp), a workerd service binding
// wired to a separate outbound network, not a shared/exported fetch reference.
// `env` is only ever handed to the genuinely-dispatched `fetch(request, env)`
// call below by workerd's own runtime — nothing at module-evaluation time
// (including attacker-controlled top-level code that escapes usercode.js's
// wrapper, see entrypoint.sh) ever receives a reference to it, so there is
// nothing for user code to import or steal. See guard.ts for why an
// export-based handoff (this worker's previous design) could not be made
// sound: usercode.js shares guard.js's module graph, so any function guard.js
// exported was equally callable by escaped user code.
//
// guard.js MUST be the first import in this file, whether or not a name is bound from it.
// Import declarations are hoisted and dependencies evaluate in the order first
// encountered; guard.js has to install its fetch/WebSocket/EventSource overrides (and
// capture RealURL/realObjectFreeze — see guard.ts) before usercode.js's module body runs,
// including any attacker-controlled top-level statement that escapes usercode.js's
// wrapper (see entrypoint.sh). Reversing this order (or dropping the import) silently
// makes the entire allowlist dead code — `globalThis.fetch` stays the real, unrestricted
// fetch for every script this Actor runs. tests/sandbox-isolation.ts is the regression
// test for this: it fails loudly (`allow https://example.com/` check reports NOT blocked)
// if this import is ever missing or reordered.
//
// realObjectFreeze (used below instead of the bare global `Object.freeze`) is guard.js's
// own pre-captured reference, for the same reason: this file's Object.freeze calls are
// top-level code that runs AFTER usercode.js's module body, so a script could otherwise
// shadow the global `Object.freeze` to a no-op before any of them ever run. See guard.ts's
// comment on realObjectFreeze.
import { realObjectFreeze } from './guard.js';
import { run } from './usercode.js';

type Fetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

const DEFAULT_GET_SCHEMA_SAMPLE = 5;

// The Apify API caps a single actor.call/run.waitForFinish wait at 60s
// (a REST API limit, not this Actor's) — see docs/API.md's Recipes section
// for the poll-in-a-loop pattern for longer runs.
const DEFAULT_WAIT_FOR_FINISH_SECS = 60;

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
    status: string;
    defaultDatasetId: string;
}

type SearchParamValue = string | number | boolean | undefined | null;
type SearchParams = Record<string, SearchParamValue>;

interface ApiCallOptions {
    searchParams?: SearchParams;
    body?: unknown;
    contentType?: string;
}

interface StoreSearchOptions {
    search: string;
    limit?: number;
    offset?: number;
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

// One page, from a single request. Mirrors apify-client's PaginatedList shape (items, count,
// offset, limit, desc) except `total`, which stays deliberately unsurfaced — see makePaginatedList.
interface ItemsPage<T> {
    items: T[];
    count: number;
    offset: number;
    limit: number;
}

interface DatasetItemsPage extends ItemsPage<ApifyRecord> {
    desc: boolean;
}

// Awaiting this value resolves to one page (ItemsPage); `for await`-ing it auto-paginates
// through every item, one at a time. Same dual nature as apify-client's own PaginatedIterator
// (one call, one name, two ways to consume it) — see makePaginatedList for the mechanism.
type PaginatedItems<Page extends ItemsPage<unknown>> = Promise<Page> & AsyncIterable<Page['items'][number]>;

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

interface KeyValueStoreGetOptions {
    storeId: string;
    key: string;
}

interface KeyValueStoreSetOptions extends KeyValueStoreGetOptions {
    value: unknown;
    contentType?: string;
}

interface KeyValueStoreListOptions {
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
    // APIFY_META_ORIGIN, forwarded from the platform's own env var of the same
    // name (bound as PARENT_ORIGIN in config.capnp). Reflects this run's own
    // meta.origin, set by apify-core from the X-Apify-Request-Origin request
    // header the caller sent when creating THIS run — 'MCP' when apify-mcp-server
    // started it. Platform-injected, not user-settable: unlike an Actor input
    // field, a script running inside this Actor cannot spoof it.
    PARENT_ORIGIN?: string;
    // Execution-level safeguards on Actor runs a script starts via
    // actor.start/call/callAndGetItems — see makeApifyBinding's `Limits` and
    // docs/API.md's "Execution limits" section. All optional; unset means
    // "no limit beyond the Apify API's own defaults".
    MAX_ACTOR_RUNS?: string;
    MAX_TOTAL_CHARGE_USD?: string;
    DEFAULT_TIMEOUT_SECS?: string;
    // Unrestricted (non-allowlisted) fetch for this worker's own calls to the
    // platform-internal Apify API. Bound to a separate outbound network
    // service in config.capnp — see this file's header comment and guard.ts.
    INTERNAL_API: Fetcher;
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

// Wraps a page-fetcher into a value that's both a Promise (awaits to the first page) and an
// AsyncIterable (walks every page, yielding one item at a time) — the same dual nature as
// apify-client's own PaginatedIterator, implemented via the same trick it uses: attach
// Symbol.asyncIterator to a live Promise object (a Promise is a plain object at runtime, so
// this is legal, no class or wrapper needed).
//
// One shared implementation, unlike apify-client itself, which independently re-implements
// this exact trick three times (dataset items, key-value-store keys, request-queue requests)
// with three subtly different cursor/offset conventions — see docs/API.md's Conventions
// section for that comparison. Every paginated method in this binding goes through this one
// function instead.
//
// Continuation stops the same way the old dataset.iterate() did: a page shorter than the
// limit it was asked for is the natural end-of-data signal (no dataset `total` is trusted —
// see the listItems comment below for why).
function makePaginatedList<T, Page extends ItemsPage<T>>(
    fetchPage: (offset: number, limit: number | undefined) => Promise<Page>,
    offset: number,
    limit: number | undefined,
): PaginatedItems<Page> {
    const firstPagePromise = fetchPage(offset, limit);

    async function* iterateAll(): AsyncGenerator<T> {
        let page = await firstPagePromise;
        yield* page.items;
        let nextOffset = page.offset + page.items.length;
        while (page.items.length > 0 && page.items.length >= page.limit) {
            page = await fetchPage(nextOffset, page.limit);
            yield* page.items;
            nextOffset += page.items.length;
        }
    }

    return Object.defineProperty(firstPagePromise, Symbol.asyncIterator, {
        value: iterateAll,
    }) as PaginatedItems<Page>;
}

// 'MCP' matches apify-core's META_ORIGINS.MCP / apify-mcp-server's own
// X-Apify-Request-Origin header value — reusing the platform's existing
// convention rather than inventing a new one.
const MCP_ORIGIN = 'MCP';
const REQUEST_ORIGIN_HEADER = 'X-Apify-Request-Origin';

// Execution-level safeguards on Actor runs a script starts (actor.start/call/
// callAndGetItems, which all funnel through createRun() below). Independent of
// any single run's own timeoutSecs/waitForFinishSecs/maxTotalChargeUsd, which
// only bound THAT run — nothing previously bounded how many runs one script
// could start, or their combined cost. See docs/API.md's "Execution limits".
interface Limits {
    // Always constructed with all three keys present (the fetch handler below never omits
    // one) — `| undefined` documents "may be undefined" without implying a caller can leave
    // the key out entirely, per this codebase's own `?` vs `| undefined` convention.
    maxActorRuns: number | undefined;
    maxTotalChargeUsd: number | undefined;
    defaultTimeoutSecs: number | undefined;
}

function makeApifyBinding({ token, apiV2, parentOrigin, internalFetch, limits }: {
    token: string;
    apiV2: string;
    parentOrigin: string | undefined;
    internalFetch: Fetcher['fetch'];
    limits: Limits;
}) {
    // Every request this Actor makes identifies itself; requests made while THIS
    // run's own origin is MCP additionally forward that origin so runs started by
    // apify.actor.start/call/callAndGetItems() below get meta.origin: 'MCP' too,
    // instead of the platform's default meta.origin: 'ACTOR' for actor-to-actor
    // calls. Gated on parentOrigin (verified server-side, see the Env.PARENT_ORIGIN
    // comment) rather than any Actor input, so a script can't forge an origin this
    // run wasn't actually started with.
    const baseHeaders: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'apify-code-runtime',
        ...(parentOrigin === MCP_ORIGIN ? { [REQUEST_ORIGIN_HEADER]: MCP_ORIGIN } : {}),
    };

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
        const response = await internalFetch(buildUrl(path, searchParams), { method, headers, body: requestBody });
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
    // handed or guesses. Also used by abortTrackedRuns() (called from the top-level exception
    // handler below) to clean up runs still going when the script itself crashed.
    const startedRunIds = new Set<string>();
    // Gates nonTerminalRunIds membership: createRun() (below) adds a run's id here unless its
    // status is already one of these; waitForFinish() removes it once the status becomes one
    // of these. A status in this set means this script no longer needs to track (and
    // therefore abortTrackedRuns(), below, no longer needs to abort) that run. Deliberately
    // broader than the API's own terminal-status set (docs/API.md's
    // SUCCEEDED/FAILED/ABORTED/TIMED-OUT) by one: ABORTING means a run is already mid-abort
    // (e.g. this script already called run.abort() on it), so re-aborting it would just be a
    // redundant API call, not a real cleanup action.
    const DONE_TRACKING_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'ABORTING', 'TIMED-OUT']);
    const nonTerminalRunIds = new Set<string>();

    // Conservative execution-level cost cap: each run's OWN maxTotalChargeUsd is a ceiling,
    // not a bill, so this tracks committed ceilings (not realized spend) against
    // limits.maxTotalChargeUsd and never lets a script authorize more combined ceiling than
    // that budget, even though actual spend will usually be lower.
    let committedChargeUsd = 0;
    // Separate from startedRunIds.size: reserved synchronously (see createRun below) so two
    // concurrent createRun() calls — e.g. docs/API.md's own "Bounded parallel fan-out" recipe,
    // `Promise.all(batch.map(() => apify.actor.start(...)))` — can't both read the
    // pre-reservation count before either's POST resolves and both pass the cap check.
    let reservedRunCount = 0;

    // POST /acts/:id/runs, shared by actor.call() (start+wait, waitForFinishSecs defaults to
    // DEFAULT_WAIT_FOR_FINISH_SECS, capped at 60s per the Apify API — for longer runs use
    // start() + apify.run.waitForFinish()) and actor.start() (async kickoff, no wait). Returns
    // the run record so the caller can read defaultDatasetId / defaultKeyValueStoreId.
    // Intentionally does NOT use /run-sync, which returns the OUTPUT KVS record (a pattern
    // only some Actors follow) rather than the structured run record.
    const createRun = async ({ actorId, input, memoryMbytes, timeoutSecs, waitForFinishSecs, maxTotalChargeUsd, maxItems }: StartOptions): Promise<RunRecord> => {
        if (limits.maxActorRuns !== undefined && reservedRunCount >= limits.maxActorRuns) {
            throw new Error(`Blocked actor run: this script already started/is starting ${reservedRunCount} Actor run(s), the configured limit is ${limits.maxActorRuns}`);
        }
        // Reject a malformed script-supplied maxTotalChargeUsd before it ever reaches
        // committedChargeUsd's arithmetic below: NaN in particular is silently absorbing —
        // `NaN - anything` and `anything - NaN` both stay NaN, so a single bad call would
        // permanently corrupt the running total and (since `NaN <= 0` is false) defeat the
        // whole execution-level budget check for the rest of the script, with no way to
        // recover it via the catch block's rollback (subtracting NaN from NaN is still NaN).
        if (maxTotalChargeUsd !== undefined && !(Number.isFinite(maxTotalChargeUsd) && maxTotalChargeUsd > 0)) {
            throw new Error(`Invalid maxTotalChargeUsd: ${maxTotalChargeUsd} (must be a finite number greater than 0)`);
        }
        let effectiveMaxCharge = maxTotalChargeUsd;
        if (limits.maxTotalChargeUsd !== undefined) {
            const remaining = limits.maxTotalChargeUsd - committedChargeUsd;
            if (remaining <= 0) {
                throw new Error(`Blocked actor run: execution spending budget of $${limits.maxTotalChargeUsd} is exhausted`);
            }
            // A run without its own cap could spend the whole remaining budget; a run with
            // its own cap higher than what's left gets clamped down to what's left.
            effectiveMaxCharge = effectiveMaxCharge === undefined ? remaining : Math.min(effectiveMaxCharge, remaining);
        }
        // Reserve BEFORE the network round-trip below (nothing here awaits yet, so this runs
        // to completion in one synchronous tick relative to any other createRun() call — see
        // the comment on reservedRunCount above for why that matters).
        reservedRunCount += 1;
        if (effectiveMaxCharge !== undefined) committedChargeUsd += effectiveMaxCharge;
        try {
            const runRecord: RunRecord = await apiData('POST', `/acts/${encodeURIComponent(actorId)}/runs`, {
                searchParams: {
                    waitForFinish: waitForFinishSecs,
                    memory: memoryMbytes,
                    timeout: timeoutSecs ?? limits.defaultTimeoutSecs,
                    maxTotalChargeUsd: effectiveMaxCharge,
                    maxItems,
                },
                body: input ?? {},
            });
            startedRunIds.add(runRecord.id);
            if (!DONE_TRACKING_STATUSES.has(runRecord.status)) nonTerminalRunIds.add(runRecord.id);
            return runRecord;
        } catch (err) {
            // The reservation never became a real run — release it, so a failed attempt
            // (bad actorId, network error, ...) doesn't permanently eat into the script's
            // run-count/budget allowance.
            reservedRunCount -= 1;
            if (effectiveMaxCharge !== undefined) committedChargeUsd -= effectiveMaxCharge;
            throw err;
        }
    };

    const actor = {
        get: ({ actorId }: ActorIdOptions): Promise<ApifyRecord> =>
            apiData('GET', `/acts/${encodeURIComponent(actorId)}`),

        // Shared by run() and start(): both POST /acts/:id/runs, differing only in whether
        // waitForFinish is set. Records the created run's ID in startedRunIds so run.abort()
        // can be scoped to runs this script itself started (see the run.abort definition below).
        call: (opts: StartOptions): Promise<RunRecord> => createRun({ waitForFinishSecs: DEFAULT_WAIT_FOR_FINISH_SECS, ...opts }),

        // Async kickoff. Returns immediately with a run record in READY/RUNNING state.
        start: (opts: StartOptions): Promise<RunRecord> => createRun(opts),

        // Runs an Actor (same as call(), waitForFinishSecs defaults to DEFAULT_WAIT_FOR_FINISH_SECS)
        // and returns its dataset items in one call. Calls createRun() directly rather than
        // through `actor.call()` — same underlying request, no self-reference to `actor` needed.
        //
        // If the run is still RUNNING when the wait elapses, this reads whatever the dataset
        // holds at that moment — items may be empty or a partial subset of the eventual total.
        // Check `run.status` (returned alongside `items`); a non-terminal status means the
        // items are a snapshot, not the final result — see docs/API.md.
        callAndGetItems: async ({ actorId, input, fields, limit, ...runOpts }: RunAndGetItemsOptions): Promise<{ run: RunRecord; items: ApifyRecord[] }> => {
            const runRecord = await createRun({ actorId, input, waitForFinishSecs: DEFAULT_WAIT_FOR_FINISH_SECS, ...runOpts });
            const { items } = await dataset.listItems({
                datasetId: runRecord.defaultDatasetId, fields, limit,
            });
            return { run: runRecord, items };
        },
    };

    const run = {
        get: ({ runId }: RunIdOptions): Promise<RunRecord> =>
            apiData('GET', `/actor-runs/${encodeURIComponent(runId)}`),

        // Block until the run terminates or `waitForFinishSecs` elapses (whichever comes first).
        // The Apify API caps this at 60s per request; longer waits require a polling loop.
        waitForFinish: async ({ runId, waitForFinishSecs = DEFAULT_WAIT_FOR_FINISH_SECS }: WaitOptions): Promise<RunRecord> => {
            const runRecord: RunRecord = await apiData('GET', `/actor-runs/${encodeURIComponent(runId)}`, {
                searchParams: { waitForFinish: waitForFinishSecs },
            });
            if (DONE_TRACKING_STATUSES.has(runRecord.status)) nonTerminalRunIds.delete(runId);
            return runRecord;
        },

        // Scoped to runs this script itself started (see startedRunIds above) — without this,
        // any runId a script is handed (e.g. read from a dataset item, or guessed) could abort
        // an unrelated, account-wide run.
        abort: ({ runId }: RunIdOptions): Promise<RunRecord> => {
            if (!startedRunIds.has(runId)) {
                throw new Error(`Blocked run.abort: "${runId}" was not started by this script`);
            }
            nonTerminalRunIds.delete(runId);
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
        // `await` resolves to one page: { items, count, offset, limit, desc }. `for await`
        // auto-paginates through the entire dataset, one item at a time (replaces the old,
        // separate dataset.iterate() method — see makePaginatedList). offset/limit/desc echo
        // back what the API actually applied (read from its x-apify-pagination-* response
        // headers, not just the request), except `total`: the Apify API's
        // `x-apify-pagination-total` header is unreliable for freshly-created datasets
        // (eventually consistent), so it's never surfaced — `count` (this page's actual item
        // count) is what you want instead. Use `inferFields` if you need an approximate total.
        listItems: ({ datasetId, fields, omit, limit, offset = 0, clean, desc }: DatasetListOptions): PaginatedItems<DatasetItemsPage> => {
            const fetchPage = async (pageOffset: number, pageLimit?: number): Promise<DatasetItemsPage> => {
                const response = await apiCall('GET', `/datasets/${encodeURIComponent(datasetId)}/items`, {
                    searchParams: {
                        fields: fields?.join(','),
                        omit: omit?.join(','),
                        limit: pageLimit,
                        offset: pageOffset,
                        clean: clean ? '1' : undefined,
                        desc: desc ? '1' : undefined,
                    },
                });
                const items: ApifyRecord[] = await response.json();
                return {
                    items,
                    count: items.length,
                    offset: Number(response.headers.get('x-apify-pagination-offset') ?? pageOffset),
                    limit: Number(response.headers.get('x-apify-pagination-limit') ?? pageLimit ?? items.length),
                    desc: response.headers.get('x-apify-pagination-desc') === 'true',
                };
            };
            return makePaginatedList(fetchPage, offset, limit);
        },

        // Apify has no dedicated schema endpoint; we infer one from a small sample of items.
        // Named inferFields (not getSchema) to avoid colliding with the Actor's own *declared*
        // dataset schema (a different concept, described in this Actor's own actor.json).
        inferFields: async ({ datasetId, sample = DEFAULT_GET_SCHEMA_SAMPLE }: DatasetSchemaOptions): Promise<DatasetSchema> => {
            const meta = await apiData('GET', `/datasets/${encodeURIComponent(datasetId)}`);
            const { items } = await dataset.listItems({ datasetId, limit: sample });
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

    const keyValueStore = {
        // Returns the value directly (parsed when JSON, string when text/*, Uint8Array otherwise).
        // Returns null when the key does not exist (404), not an error — this matches the common
        // "lookup or default" pattern in code.
        get: async ({ storeId, key }: KeyValueStoreGetOptions): Promise<unknown> => {
            const response = await internalFetch(buildUrl(`/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(key)}`), {
                headers: baseHeaders,
            });
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`GET keyValueStore.get failed: ${response.status} ${await response.text()}`);
            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('application/json')) return response.json();
            if (contentType.startsWith('text/')) return response.text();
            return new Uint8Array(await response.arrayBuffer());
        },

        // `value`: object → application/json; string → text/plain; Uint8Array/ArrayBuffer →
        // application/octet-stream (or whatever the caller passed via `contentType`).
        set: async ({ storeId, key, value, contentType }: KeyValueStoreSetOptions): Promise<void> => {
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

        list: ({ storeId, limit, exclusiveStartKey }: KeyValueStoreListOptions): Promise<ApifyRecord> =>
            apiData('GET', `/key-value-stores/${encodeURIComponent(storeId)}/keys`, {
                searchParams: { limit, exclusiveStartKey },
            }),

        create: ({ name }: CreateOptions = {}): Promise<ApifyRecord> =>
            apiData('POST', '/key-value-stores', { searchParams: { name } }),
    };

    // GET /v2/store — Apify Store search (a top-level resource in the Apify API,
    // tagged `Store`, distinct from `Actors` — hence a top-level binding rather
    // than an `actor.*` method). Same dual nature as dataset.listItems: `await` for one
    // page, `for await` to walk every match. offset/limit echo back the request (the
    // endpoint's own JSON body doesn't carry pagination metadata beyond `items`, unlike
    // dataset's header-based pagination — see makePaginatedList).
    const store = ({ search, limit, offset = 0, category }: StoreSearchOptions): PaginatedItems<ItemsPage<ApifyRecord>> => {
        const fetchPage = async (pageOffset: number, pageLimit: number | undefined): Promise<ItemsPage<ApifyRecord>> => {
            const page = await apiData('GET', '/store', { searchParams: { search, limit: pageLimit, offset: pageOffset, category } });
            const items: ApifyRecord[] = page.items;
            return { items, count: items.length, offset: pageOffset, limit: pageLimit ?? items.length };
        };
        return makePaginatedList(fetchPage, offset, limit);
    };

    // Best-effort cleanup for runs this script started but left non-terminal (e.g. the
    // script itself threw with a run still in progress). Not part of the frozen `apify`
    // binding handed to user code — called directly by the top-level exception handler
    // below. One bad abort must not stop the others (the run tracking loop's whole point is
    // to catch stragglers after an error): a run that already finished on the platform
    // between our last check and now is an *expected* abort failure (the API rejects
    // aborting a finished run), not a bug, so failures are reported back for logging, never
    // thrown.
    const abortTrackedRuns = async (): Promise<{ runId: string; error: string }[]> => {
        const runIds = [...nonTerminalRunIds];
        const results = await Promise.allSettled(runIds.map((runId) => run.abort({ runId })));
        return results.flatMap((result, i) => result.status === 'rejected' ? [{ runId: runIds[i], error: errorMessage(result.reason) }] : []);
    };

    // Freeze every namespace (and the wrapper) so the script can't reassign a method to
    // corrupt its own behavior or, for `console` below, its own output capture.
    const binding = realObjectFreeze({
        actor: realObjectFreeze(actor),
        store,
        run: realObjectFreeze(run),
        dataset: realObjectFreeze(dataset),
        keyValueStore: realObjectFreeze(keyValueStore),
    });
    return { binding, abortTrackedRuns };
}

// The shape handed to user code as the `apify` binding. Exported (type-only —
// erased at compile time) so tests/*.ts can type-check probes against the same
// surface real usercode.js runs against, without importing runner.ts at runtime.
export type ApifyBinding = ReturnType<typeof makeApifyBinding>['binding'];

// Push the captured streams as a single item to the run's default dataset.
async function pushOutput({ apiV2, token, internalFetch, env, item }: {
    apiV2: string;
    token: string;
    internalFetch: Fetcher['fetch'];
    env: Env;
    item: OutputItem;
}): Promise<void> {
    const datasetId = env.DEFAULT_DATASET_ID || env.DEFAULT_DATASET_ID_LEGACY;
    if (!datasetId) throw new Error('Default dataset ID missing from Actor run environment.');
    const response = await internalFetch(`${apiV2}/datasets/${encodeURIComponent(datasetId)}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(item),
    });
    if (!response.ok) throw new Error(`Failed to push dataset item: ${response.status} ${await response.text()}`);
}

// Parses an optional positive-number env var (as set by entrypoint.sh from Actor input).
// Absent or blank means "field omitted" -> no limit, matching .actor/actor.json's own
// description for each field. The platform validates the input schema's types/minimums
// before this code ever runs, so non-numeric/non-positive shouldn't reach here in
// practice — treating it as "no limit" rather than crashing is a deliberate fallback for
// that already-unlikely case, not a substitute for the schema validation.
function parsePositiveNumberEnv(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// Frozen so escaped usercode.js module-scope code (which shares this module's namespace via
// `import('./runner.js')`, the same reachability every export in this file has — see guard.ts's
// header comment) can't reassign `.fetch` to a wrapper that captures the real `request`/`env`
// (APIFY_TOKEN, INTERNAL_API) the next time workerd genuinely dispatches to this worker.
export default realObjectFreeze({
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/health') return new Response('ok');
        if (url.pathname !== '/run') return new Response('Not found', { status: 404 });

        const token = env.APIFY_TOKEN;
        if (!token) throw new Error('APIFY_TOKEN missing from Actor run environment.');
        // APIFY_API_BASE_URL is the platform-internal API (may have a trailing slash).
        const apiV2 = `${(env.API_BASE_URL || 'https://api.apify.com').replace(/\/+$/, '')}/v2`;
        const internalFetch: Fetcher['fetch'] = (input, init) => env.INTERNAL_API.fetch(input, init);

        const limits: Limits = {
            maxActorRuns: parsePositiveNumberEnv(env.MAX_ACTOR_RUNS),
            maxTotalChargeUsd: parsePositiveNumberEnv(env.MAX_TOTAL_CHARGE_USD),
            defaultTimeoutSecs: parsePositiveNumberEnv(env.DEFAULT_TIMEOUT_SECS),
        };

        const stdout: string[] = [];
        const stderr: string[] = [];
        // Frozen so the script can't reassign e.g. console.log to corrupt its own capture.
        const captureConsole: ConsoleLike = realObjectFreeze({
            log:   (...args: unknown[]) => stdout.push(args.map(stringify).join(' ')),
            error: (...args: unknown[]) => stderr.push(args.map(stringify).join(' ')),
            warn:  (...args: unknown[]) => stderr.push(args.map(stringify).join(' ')),
            info:  (...args: unknown[]) => stdout.push(args.map(stringify).join(' ')),
        });

        const { binding, abortTrackedRuns } = makeApifyBinding({ token, apiV2, parentOrigin: env.PARENT_ORIGIN, internalFetch, limits });

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
            await run(binding, captureConsole);
        } catch (err) {
            stderr.push(errorDetail(err));
            exitCode = 1;
            statusMessage = `Script threw: ${errorMessage(err)}`;
            // Best-effort: a script that started Actor runs and then crashed shouldn't leave
            // them running unattended. Failures here don't change exitCode/statusMessage —
            // the script's own failure is the primary signal; cleanup is secondary.
            const abortFailures = await abortTrackedRuns();
            for (const { runId, error } of abortFailures) {
                stderr.push(`Cleanup: failed to abort run ${runId}: ${error}`);
            }
        }

        await pushOutput({
            apiV2, token, internalFetch, env,
            item: { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode, statusMessage },
        });
        return Response.json({ ok: true });
    },
});
