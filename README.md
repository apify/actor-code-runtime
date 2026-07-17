# Code Runtime (experimental)

> ⚠️ **Experimental infrastructure Actor.** It powers **Code Mode** on
> [mcp.apify.com](https://mcp.apify.com) and is normally invoked by the Apify
> MCP Server, not run by hand. Its behaviour and API may change without notice.

## What it does

This Actor executes JavaScript that an AI agent submits through the Apify MCP
Server's **Code Mode**, then returns whatever the script printed. JS only —
nothing transpiles it, so a TypeScript type annotation is a SyntaxError at load.

Code Mode exists so an agent can do many Apify operations in **one go** —
search the Store, run an Actor, read its dataset, filter and aggregate the
results — instead of sending every intermediate result back through the model
and wasting tokens. This Actor is the sandbox that runs that script.

**Best suited for data-heavy jobs** — scraping hundreds or thousands of
places/items via an Actor, then filtering, sorting, or aggregating them
locally before returning a small summary. **Weaker fit** for steps that
require reading or judging free text (picking a fact out of an article,
choosing a search term) — keep the model in the loop there instead; a wrong
guess inside the sandbox fails silently until the whole script finishes.

## Calling this Actor

Self-contained — no special MCP-server opt-in required. Any MCP client
already has `search-actors`, `fetch-actor-details`, and `call-actor` as
default tools:

```
call-actor({ actor: "apify/code-runtime", input: { code: "..." } })
```

Or via the raw API: `POST /v2/acts/apify~code-runtime/runs` with `{ code }`
as the body. Results land in the run's default dataset, same as any Actor
call — follow the response's `nextStep` (or call `get-dataset-items`/
`GET /v2/datasets/{datasetId}/items`) to read it.

## How it works

- **One script per run.** The Actor reads your `code`, runs it once, writes the
  result, and exits.
- The code runs inside a [`workerd`](https://github.com/cloudflare/workerd) V8
  isolate: **no imports** — neither npm packages nor Node built-in `node:*`
  modules are available (`import`/`require` of any module fails); web-standard
  globals such as `fetch` are present. Outbound network is restricted to
  `*.apify.com`.
- Inside the script a global **`apify`** object exposes a small, typed subset of
  the Apify API — run Actors, read/write datasets and key-value stores — using
  the current run's token (see below).
- `console.log` / `console.info` go to **stdout**; `console.error` /
  `console.warn` go to **stderr**. The two streams are captured separately.
- Before running an Actor from your script, call `apify.actor.get({ actorId })`
  once to read its input/output schema.
- As each nested run finishes, log its `run.id` / `defaultDatasetId` /
  `defaultKeyValueStoreId` **before** processing its output (nothing persists
  between this Actor's own runs, but the Actors it started keep their
  results). **If a prior attempt's `defaultDatasetId`/`defaultKeyValueStoreId`
  is visible in your own earlier turns, reuse it — do not re-run the same
  Actor call with identical input.** Re-running wastes the compute/cost of a
  call that already succeeded.
- Print a small, JSON-stringified summary of the result — never dump full
  datasets. Only what you `console.log`/`console.info` comes back; a
  top-level `return` value is **not** captured.

## Input

```json
{
  "code": "const { items } = await apify.actor.callAndGetItems({ actorId: 'apify/rag-web-browser', input: { query: 'apify' }, limit: 3 });\nconsole.log(items.map((i) => i.metadata?.title).join('\\n'));"
}
```

| Field | Type | Description |
|---|---|---|
| `code` | string | The JavaScript script to run (JS only, not transpiled). It receives the `apify` binding and `console`. |

## Output

A single **dataset item** with the captured streams, the script's exit
status, and a prose status message:

```json
{ "stdout": "Apify: Full-stack web scraping ...\n...", "stderr": "", "exitCode": 0, "statusMessage": "Script completed" }
```

If the script throws, the error lands in `stderr`, `stdout` keeps whatever was
printed before the failure, `exitCode` is `1`, and `statusMessage` is
`"Script threw: ..."`. The Actor run itself still **succeeds** — check
`exitCode`/`statusMessage`, not `stderr` content, to detect a failed script,
since `stderr` is also a legitimate log channel (`console.error` /
`console.warn`).

If the script fails to **compile** (a syntax error), the same contract
applies — `exitCode: 1`, `statusMessage: "Failed to compile: ..."` — pushed
by the container entrypoint directly, since a malformed script never reaches
the sandboxed worker at all.

A run-level **timeout or out-of-memory kill** is a different, third outcome:
the container is killed before it can push anything, so this dataset item may
not exist for that run at all. That case is signaled by the Actor run's own
status (`SUCCEEDED` vs `FAILED`/`TIMED-OUT`), not by this item's absence —
see [Limits & failure modes](#limits--failure-modes).

## Limits & failure modes

- Default `defaultRunOptions`: `timeoutSecs: 900`, `memoryMbytes: 1024`
  (`.actor/actor.json`). Override per call — e.g. the MCP `call-actor` tool's
  `callOptions.timeout`/`callOptions.memory`, or the API's `timeout`/`memory`
  run options — for scripts that chain several long-running Actor calls.
- `exitCode`/`statusMessage` signal the **script's** outcome only (returned /
  threw / failed to compile). A resource-limit kill is a **run-level**
  outcome instead — check the Actor run's own `status`, not this dataset
  item, for that case (see [Output](#output) above).

## Permissions & safety

- Runs with **limited permissions**: the sandbox has no filesystem and
  outbound `fetch` (including through redirects, which are re-validated per
  hop) is limited to the Apify API (`*.apify.com`).
- **No imports.** The isolate runs without workerd's `nodejs_compat`, so user
  code cannot import Node built-ins (`node:net`, `node:fs`, …) or npm packages.
  This removes `node:net` — a raw-socket egress path that would otherwise bypass
  the `fetch` allowlist — and keeps the run token out of `process.env` (which is
  not defined).
- Each run is an isolated, single-use container — nothing persists between runs.
- This closes off **direct fetch-based exfil** from the container — it does not
  stop every path to move data out (e.g. `actor.start({ input })` on an Actor
  with its own open internet access, or writing to a dataset/key-value store).

## Recipes

### Chain Actors (one run's output feeds the next)

```js
const { items: results } = await apify.actor.callAndGetItems({
    actorId: 'apify/google-search-scraper', input: { queries: 'apify' }, limit: 10,
});
const startUrls = results.flatMap((r) => r.organicResults ?? []).map((r) => ({ url: r.url }));
const { items: pages } = await apify.actor.callAndGetItems({
    actorId: 'apify/website-content-crawler', input: { startUrls },
});
console.log(JSON.stringify(pages.slice(0, 3).map((p) => p.url)));
```

### Bounded parallel fan-out

This Actor's clearest win: run several independent Actors (or the same Actor
over several inputs) concurrently, then reduce before returning. Chunk the
fan-out (e.g. 5–10 at a time) — an unbounded `Promise.all` over many inputs
can hit your account's concurrent-run or memory limits.

```js
const inputs = [{ query: 'a' }, { query: 'b' }, { query: 'c' } /* ... */];
const CHUNK = 5;
const results = [];
for (let i = 0; i < inputs.length; i += CHUNK) {
    const batch = inputs.slice(i, i + CHUNK);
    const batchResults = await Promise.all(
        batch.map((input) => apify.actor.callAndGetItems({ actorId: 'apify/rag-web-browser', input, limit: 5 })),
    );
    results.push(...batchResults.flatMap((r) => r.items));
}
console.log(JSON.stringify(results.slice(0, 5))); // small summary, not the full dump
```

### Read an entire dataset without managing offsets

`dataset.listItems` (and `store`) return a value that's both a `Promise` (one
page) and an `AsyncIterable` (every item, auto-paginated) — pick whichever
you need:

```js
// One page — e.g. a quick peek
const { items, count } = await apify.dataset.listItems({ datasetId, limit: 10 });

// Every item, however many pages that takes
let matches = 0;
for await (const item of apify.dataset.listItems({ datasetId })) {
    if (item.rating >= 4.5) matches++;
}
console.log(`${matches} matching items`);
```

### Runs longer than 60s: start, then poll

`actor.call`'s wait is capped at 60s per request (a REST API limit, not this
Actor's). For a longer-running Actor, start it and poll:

```js
let run = await apify.actor.start({ actorId, input });
const TERMINAL = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'];
while (!TERMINAL.includes(run.status)) {
    run = await apify.run.waitForFinish({ runId: run.id, waitForFinishSecs: 60 });
}
```

## Limitations

Sub-runs started from inside the sandbox (via `apify.actor.start/call/callAndGetItems`)
get `meta.origin: 'MCP'` on the Apify platform, same as this Actor's own run, when
this Actor was itself started via the Apify MCP Server — this Actor reads its own
`APIFY_META_ORIGIN` env var (platform-set, not spoofable from inside the sandbox)
and forwards `X-Apify-Request-Origin: MCP` on its own API calls only when that's
`MCP`. Every sub-run also gets a platform-native `meta.actorRunId` link back to
this run regardless of origin (set automatically from the run-scoped token, no
code needed here) — so even a fully generic query can already walk sub-run →
`meta.actorRunId` → parent `meta.origin` to reconstruct the chain; the origin
forwarding above just makes single-field origin queries work without that join.

What's still not attributed: the specific MCP *session* (which client, which
conversation) that triggered this Actor's own run in the first place — that
context isn't part of the platform's Run schema at all, on or off Code Mode.

## The `apify` binding

Every method takes one options object and returns parsed JSON — except
`store` and `dataset.listItems`, which return a value that's both a `Promise`
(one page) and an `AsyncIterable` (every match/item, auto-paginated) — see
their own lines below (`?` = optional, `= x` = default). Full API
documentation is available
[here](https://github.com/apify/actor-code-runtime/blob/master/docs/API.md).

```js
// Store — GET /v2/store, a top-level Apify API resource (not an Actor method)
// `await` for one page, `for await` to walk every match (same dual nature as
// dataset.listItems below).
apify.store({ search, limit?, offset?, category? })  // → { items, count, offset, limit }

// Actors
apify.actor.get({ actorId })                                  // → actor
apify.actor.start({ actorId, input?, memoryMbytes?, timeoutSecs?, maxTotalChargeUsd?, maxItems? })  // → run
apify.actor.call({ actorId, ...startOpts, waitForFinishSecs = 60 })           // → run (waits; may return non-terminal READY/RUNNING if the 60s cap elapses first — not an error, poll run.waitForFinish)
apify.actor.callAndGetItems({ actorId, input?, fields?, limit?, ...runOpts })  // → { run, items }

// Runs
apify.run.get({ runId })                                    // → run
apify.run.waitForFinish({ runId, waitForFinishSecs = 60 })  // → run (same non-terminal caveat as actor.call above)
apify.run.abort({ runId })                                  // → run
apify.run.getLog({ runId, limit? })                         // → string

// Datasets
apify.dataset.create({ name? })                             // → dataset
apify.dataset.pushItems({ datasetId, items })               // → void
// `await` for one page: { items, count, offset, limit, desc }. `for await` auto-paginates
// through the whole dataset, one item at a time — no separate iterate() method needed.
apify.dataset.listItems({ datasetId, fields?, omit?, limit?, offset?, clean?, desc? })
apify.dataset.inferFields({ datasetId, sample = 5 })        // → { itemCount, fields[] }

// Key-value stores
apify.keyValueStore.create({ name? })                        // → store
apify.keyValueStore.set({ storeId, key, value, contentType? })  // → void
apify.keyValueStore.get({ storeId, key })                    // → value | null
apify.keyValueStore.list({ storeId, limit?, exclusiveStartKey? })  // → { items }
```

## Learn more

- Apify MCP Server: <https://mcp.apify.com>
- Code Mode design: [apify/apify-mcp-server#794](https://github.com/apify/apify-mcp-server/pull/794)
