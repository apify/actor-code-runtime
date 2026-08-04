// Run usercode.js in workerd, expose the Apify binding, and push output.
// guard.js must load first to install egress guards before user code runs.
// Internal API access uses env.INTERNAL_API; user code never receives env.
// Security-sensitive builtins come from guard.js captures.
import {
    realObjectFreeze, setHas, numberIsFinite, mathMin, realNumber,
    encodeUriComponent, jsonStringify, responseOk, RealURL,
} from './guard.js';
import { run } from './usercode.js';

type Fetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

const DEFAULT_GET_SCHEMA_SAMPLE = 5;

// Apify caps one wait request at 60 seconds.
const DEFAULT_WAIT_FOR_FINISH_SECS = 60;

// Only fields consumed by this runtime are typed.

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

// One page returned by a paginated endpoint.
interface ItemsPage<T> {
    items: T[];
    count: number;
    offset: number;
    limit: number;
}

interface DatasetItemsPage extends ItemsPage<ApifyRecord> {
    desc: boolean;
}

// Await for one page; use for-await to consume all pages.
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
    // Platform-verified origin; user input cannot spoof it.
    PARENT_ORIGIN?: string;
    // Optional limits for runs started by user code.
    MAX_ACTOR_RUNS?: string;
    MAX_TOTAL_CHARGE_USD?: string;
    DEFAULT_TIMEOUT_SECS?: string;
    // Separate network binding for internal API calls.
    INTERNAL_API: Fetcher;
}

interface OutputItem {
    stdout: string;
    stderr: string;
    exitCode: number;
    statusMessage: string;
}

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

// Return one page as a Promise and all pages through async iteration.
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

// Matches apify-core's existing MCP request-origin value.
const MCP_ORIGIN = 'MCP';
const REQUEST_ORIGIN_HEADER = 'X-Apify-Request-Origin';

// Limits apply across runs started by one script.
interface Limits {
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
    // Forward MCP origin only when platform metadata verified it.
    const baseHeaders: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'apify-code-runtime',
        ...(parentOrigin === MCP_ORIGIN ? { [REQUEST_ORIGIN_HEADER]: MCP_ORIGIN } : {}),
    };

    const buildUrl = (path: string, searchParams?: SearchParams): URL => {
        const url = new RealURL(`${apiV2}${path}`);
        if (searchParams) {
            for (const [key, value] of Object.entries(searchParams)) {
                if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
            }
        }
        return url;
    };

    // Shared HTTP wrapper; errors include response bodies.
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
                requestBody = jsonStringify(body);
                headers['content-type'] = contentType ?? 'application/json';
            }
        }
        const response = await internalFetch(buildUrl(path, searchParams), { method, headers, body: requestBody });
        if (!responseOk(response)) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
        return response;
    };

    // API envelopes are untyped because endpoint shapes vary.
    const apiJson = async (method: string, path: string, options?: ApiCallOptions): Promise<any> =>
        (await apiCall(method, path, options)).json();
    const apiData = async (method: string, path: string, options?: ApiCallOptions): Promise<any> =>
        (await apiJson(method, path, options)).data;

    // Scope run.abort() and crash cleanup to runs started by this script.
    const startedRunIds = new Set<string>();
    // ABORTING needs no second abort; unknown statuses stay tracked conservatively.
    const DONE_TRACKING_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'ABORTING', 'TIMED-OUT']);
    const nonTerminalRunIds = new Set<string>();

    // Track committed run ceilings, not realized spend.
    let committedChargeUsd = 0;
    // Reserve synchronously so concurrent starts cannot bypass maxActorRuns.
    let reservedRunCount = 0;

    // Start one Actor run; actor.call() and actor.start() share this path.
    const createRun = async ({ actorId, input, memoryMbytes, timeoutSecs, waitForFinishSecs, maxTotalChargeUsd, maxItems }: StartOptions): Promise<RunRecord> => {
        if (limits.maxActorRuns !== undefined && reservedRunCount >= limits.maxActorRuns) {
            throw new Error(`Blocked actor run: this script already started/is starting ${reservedRunCount} Actor run(s), the configured limit is ${limits.maxActorRuns}`);
        }
        // Reject non-finite or non-positive caps before budget arithmetic.
        if (maxTotalChargeUsd !== undefined && !(numberIsFinite(maxTotalChargeUsd) && maxTotalChargeUsd > 0)) {
            throw new Error(`Invalid maxTotalChargeUsd: ${maxTotalChargeUsd} (must be a finite number greater than 0)`);
        }
        let effectiveMaxCharge = maxTotalChargeUsd;
        if (limits.maxTotalChargeUsd !== undefined) {
            const remaining = limits.maxTotalChargeUsd - committedChargeUsd;
            if (remaining <= 0) {
                throw new Error(`Blocked actor run: execution spending budget of $${limits.maxTotalChargeUsd} is exhausted`);
            }
            // Uncapped runs consume the remainder; larger caps are clamped.
            effectiveMaxCharge = effectiveMaxCharge === undefined ? remaining : mathMin(effectiveMaxCharge, remaining);
        }
        // Reserve before the network request to close the concurrency race.
        reservedRunCount += 1;
        if (effectiveMaxCharge !== undefined) committedChargeUsd += effectiveMaxCharge;
        try {
            const runRecord: RunRecord = await apiData('POST', `/acts/${encodeUriComponent(actorId)}/runs`, {
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
            if (!setHas(DONE_TRACKING_STATUSES, runRecord.status)) nonTerminalRunIds.add(runRecord.id);
            return runRecord;
        } catch (err) {
            // Failed requests release their reservations.
            reservedRunCount -= 1;
            if (effectiveMaxCharge !== undefined) committedChargeUsd -= effectiveMaxCharge;
            throw err;
        }
    };

    const actor = {
        get: ({ actorId }: ActorIdOptions): Promise<ApifyRecord> =>
            apiData('GET', `/acts/${encodeUriComponent(actorId)}`),

        call: (opts: StartOptions): Promise<RunRecord> => createRun({ waitForFinishSecs: DEFAULT_WAIT_FOR_FINISH_SECS, ...opts }),

        start: (opts: StartOptions): Promise<RunRecord> => createRun(opts),

        // Start, wait up to 60 seconds, and read a dataset snapshot.
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
            apiData('GET', `/actor-runs/${encodeUriComponent(runId)}`),

        // Wait for termination or the API's 60-second cap.
        waitForFinish: async ({ runId, waitForFinishSecs = DEFAULT_WAIT_FOR_FINISH_SECS }: WaitOptions): Promise<RunRecord> => {
            const runRecord: RunRecord = await apiData('GET', `/actor-runs/${encodeUriComponent(runId)}`, {
                searchParams: { waitForFinish: waitForFinishSecs },
            });
            if (setHas(DONE_TRACKING_STATUSES, runRecord.status)) nonTerminalRunIds.delete(runId);
            return runRecord;
        },

        // Only runs started by this script may be aborted.
        abort: ({ runId }: RunIdOptions): Promise<RunRecord> => {
            if (!setHas(startedRunIds, runId)) {
                throw new Error(`Blocked run.abort: "${runId}" was not started by this script`);
            }
            nonTerminalRunIds.delete(runId);
            return apiData('POST', `/actor-runs/${encodeUriComponent(runId)}/abort`);
        },

        // Return the full log, optionally limited to its last N characters.
        getLog: async ({ runId, limit }: GetLogOptions): Promise<string> => {
            const response = await apiCall('GET', `/logs/${encodeUriComponent(runId)}`);
            const text = await response.text();
            return limit && text.length > limit ? text.slice(-limit) : text;
        },
    };

    const dataset = {
        // Await for one page; for-await iterates all pages.
        listItems: ({ datasetId, fields, omit, limit, offset = 0, clean, desc }: DatasetListOptions): PaginatedItems<DatasetItemsPage> => {
            const fetchPage = async (pageOffset: number, pageLimit?: number): Promise<DatasetItemsPage> => {
                const response = await apiCall('GET', `/datasets/${encodeUriComponent(datasetId)}/items`, {
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

        // Infer fields from a sample because the API has no schema endpoint.
        inferFields: async ({ datasetId, sample = DEFAULT_GET_SCHEMA_SAMPLE }: DatasetSchemaOptions): Promise<DatasetSchema> => {
            const meta = await apiData('GET', `/datasets/${encodeUriComponent(datasetId)}`);
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
            await apiCall('POST', `/datasets/${encodeUriComponent(datasetId)}/items`, { body: items });
        },
    };

    const keyValueStore = {
        // Parse JSON/text values; return null for a missing key.
        get: async ({ storeId, key }: KeyValueStoreGetOptions): Promise<unknown> => {
            const response = await internalFetch(buildUrl(`/key-value-stores/${encodeUriComponent(storeId)}/records/${encodeUriComponent(key)}`), {
                headers: baseHeaders,
            });
            if (response.status === 404) return null;
            if (!responseOk(response)) throw new Error(`GET keyValueStore.get failed: ${response.status} ${await response.text()}`);
            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('application/json')) return response.json();
            if (contentType.startsWith('text/')) return response.text();
            return new Uint8Array(await response.arrayBuffer());
        },

        // Objects, strings, and binary values use matching content types.
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
                body = jsonStringify(value);
                resolvedContentType = resolvedContentType ?? 'application/json; charset=utf-8';
            }
            await apiCall('PUT', `/key-value-stores/${encodeUriComponent(storeId)}/records/${encodeUriComponent(key)}`, {
                body, contentType: resolvedContentType,
            });
        },

        list: ({ storeId, limit, exclusiveStartKey }: KeyValueStoreListOptions): Promise<ApifyRecord> =>
            apiData('GET', `/key-value-stores/${encodeUriComponent(storeId)}/keys`, {
                searchParams: { limit, exclusiveStartKey },
            }),

        create: ({ name }: CreateOptions = {}): Promise<ApifyRecord> =>
            apiData('POST', '/key-value-stores', { searchParams: { name } }),
    };

    // Search the top-level Store resource with the shared paginator.
    const store = ({ search, limit, offset = 0, category }: StoreSearchOptions): PaginatedItems<ItemsPage<ApifyRecord>> => {
        const fetchPage = async (pageOffset: number, pageLimit: number | undefined): Promise<ItemsPage<ApifyRecord>> => {
            const page = await apiData('GET', '/store', { searchParams: { search, limit: pageLimit, offset: pageOffset, category } });
            const items: ApifyRecord[] = page.items;
            return { items, count: items.length, offset: pageOffset, limit: pageLimit ?? items.length };
        };
        return makePaginatedList(fetchPage, offset, limit);
    };

    // Best-effort cleanup; one failed abort must not stop the others.
    const abortTrackedRuns = async (): Promise<{ runId: string; error: string }[]> => {
        const runIds = [...nonTerminalRunIds];
        const results = await Promise.allSettled(runIds.map((runId) => run.abort({ runId })));
        return results.flatMap((result, i) => result.status === 'rejected' ? [{ runId: runIds[i], error: errorMessage(result.reason) }] : []);
    };

    // Freeze the binding so user code cannot replace its methods.
    const binding = realObjectFreeze({
        actor: realObjectFreeze(actor),
        store,
        run: realObjectFreeze(run),
        dataset: realObjectFreeze(dataset),
        keyValueStore: realObjectFreeze(keyValueStore),
    });
    return { binding, abortTrackedRuns };
}

// Type-only binding surface used by tests.
export type ApifyBinding = ReturnType<typeof makeApifyBinding>['binding'];

async function pushOutput({ apiV2, token, internalFetch, env, item }: {
    apiV2: string;
    token: string;
    internalFetch: Fetcher['fetch'];
    env: Env;
    item: OutputItem;
}): Promise<void> {
    const datasetId = env.DEFAULT_DATASET_ID || env.DEFAULT_DATASET_ID_LEGACY;
    if (!datasetId) throw new Error('Default dataset ID missing from Actor run environment.');
    const response = await internalFetch(`${apiV2}/datasets/${encodeUriComponent(datasetId)}/items`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: jsonStringify(item),
    });
    if (!responseOk(response)) throw new Error(`Failed to push dataset item: ${response.status} ${await response.text()}`);
}

// Blank or invalid values mean no configured limit.
function parsePositiveNumberEnv(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = realNumber(value);
    return numberIsFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// Freeze fetch so escaped module code cannot replace it.
export default realObjectFreeze({
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new RealURL(request.url);
        if (url.pathname === '/health') return new Response('ok');
        if (url.pathname !== '/run') return new Response('Not found', { status: 404 });

        const token = env.APIFY_TOKEN;
        if (!token) throw new Error('APIFY_TOKEN missing from Actor run environment.');
        const apiV2 = `${(env.API_BASE_URL || 'https://api.apify.com').replace(/\/+$/, '')}/v2`;
        const internalFetch: Fetcher['fetch'] = (input, init) => env.INTERNAL_API.fetch(input, init);

        const limits: Limits = {
            maxActorRuns: parsePositiveNumberEnv(env.MAX_ACTOR_RUNS),
            maxTotalChargeUsd: parsePositiveNumberEnv(env.MAX_TOTAL_CHARGE_USD),
            defaultTimeoutSecs: parsePositiveNumberEnv(env.DEFAULT_TIMEOUT_SECS),
        };

        const stdout: string[] = [];
        const stderr: string[] = [];
        // Freeze the captured console methods.
        const captureConsole: ConsoleLike = realObjectFreeze({
            log:   (...args: unknown[]) => stdout.push(args.map(stringify).join(' ')),
            error: (...args: unknown[]) => stderr.push(args.map(stringify).join(' ')),
            warn:  (...args: unknown[]) => stderr.push(args.map(stringify).join(' ')),
            info:  (...args: unknown[]) => stdout.push(args.map(stringify).join(' ')),
        });

        const { binding, abortTrackedRuns } = makeApifyBinding({ token, apiV2, parentOrigin: env.PARENT_ORIGIN, internalFetch, limits });

        // User errors become diagnostics; infrastructure errors fail the run.
        let exitCode = 0;
        let statusMessage = 'Script completed';
        try {
            await run(binding, captureConsole);
        } catch (err) {
            stderr.push(errorDetail(err));
            exitCode = 1;
            statusMessage = `Script threw: ${errorMessage(err)}`;
            // Cleanup failures are diagnostics, not a second script failure.
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
