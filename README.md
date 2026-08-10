# Code Runtime (experimental)

> ⚠️ **Experimental infrastructure Actor.** It powers **Code Mode** on
> [mcp.apify.com](https://mcp.apify.com) and is normally invoked by the Apify
> MCP Server, not run by hand. Its behaviour and API may change without notice.

## What it does

Executes one JS script that an AI agent submits through the Apify MCP
Server, then returns whatever the script printed.

Lets an agent do many Apify operations in **one call** — search the Store,
run an Actor, read its dataset, filter and aggregate — instead of sending
every intermediate result back through the model. This Actor is the sandbox
that runs that script.

**Worth it only for bulk work** (measured, A/B eval vs. calling Actor tools
directly):

| Workload | Verdict |
|---|---|
| Filter/sort/aggregate 50+ dataset records | Modest win — ~20-35% less time, ~20% fewer tokens |
| Fan out over 10+ sub-resources with a sizeable payload each (visit many pages, chain Actors) | Decisive win — ~60% less time, ~75% fewer tokens |
| Under 10 items, no fan-out | **Don't use this Actor** — ~20K-token sandbox overhead isn't paid back |

## Calling this Actor

Self-contained — no special MCP-server opt-in required. Any MCP client
already has `search-actors`, `fetch-actor-details`, and `call-actor` as
default tools:

```
call-actor({ actor: "apify/code-runtime", input: { code: "..." } })
```

Default `timeoutSecs: 900`, `memoryMbytes: 1024` (`.actor/actor.json`) —
override per call for scripts chaining several long Actor runs (MCP
`call-actor`'s `callOptions.timeout`/`callOptions.memory`, or the API's
`timeout`/`memory`).

## How it works

- **One script per run.** Reads `code`, runs it once, writes the result, exits.
- Runs inside a sandboxed [`workerd`](https://github.com/cloudflare/workerd)
  V8 isolate — see [Permissions & safety](#permissions--safety) for what's allowed.
- A global **`apify`** object exposes a small, typed subset of the Apify API
  — run Actors, read/write datasets and key-value stores — using the
  current run's token.
- `console.log`/`console.info` → **stdout**; `console.error`/`console.warn`
  → **stderr**, captured separately.
- Call `apify.actor.get({ actorId })` before running an Actor you haven't
  checked — don't guess its input schema.
- Log a nested run's `run.id`/`defaultDatasetId`/`defaultKeyValueStoreId`
  before processing its output — nothing persists between this Actor's own
  runs, but the Actors it started keep theirs.
- Already have a dataset/store ID from an earlier turn? Reuse it — don't
  re-run an identical call, it wastes cost.
- Print a small JSON summary, never a full dataset — only `console.log`/
  `console.info` output comes back; a top-level `return` is **not** captured.
- `callAndGetItems` reads the dataset once, right after its (max 60s) wait —
  if the child run is still `RUNNING` at that point, `items` may be empty or
  partial. Check the returned `run.status` before treating it as final.

## Input

```json
{
  "code": "const { items } = await apify.actor.callAndGetItems({ actorId: 'apify/rag-web-browser', input: { query: 'apify' }, limit: 3 });\nconsole.log(items.map((i) => i.metadata?.title).join('\\n'));"
}
```

| Field | Type | Description |
|---|---|---|
| `code` | string | The JavaScript script to run (JS only, not transpiled). It receives the `apify` binding and `console`. |
| `maxActorRuns` | number | *Optional.* Caps how many Actor runs the script may start in total; exceeding it throws inside the script. |
| `maxTotalChargeUsd` | number | *Optional.* Execution-level spending budget across all runs the script starts (distinct from a single run's own `maxTotalChargeUsd`); exhausting it throws inside the script. |
| `defaultTimeoutSecs` | number | *Optional.* Default `timeoutSecs` for child runs that don't set their own. |

## Output

A single **dataset item**:

```json
{ "stdout": "Apify: Full-stack web scraping ...\n...", "stderr": "", "exitCode": 0, "statusMessage": "Script completed" }
```

| Outcome | `exitCode` | `statusMessage` |
|---|---|---|
| Script returned | `0` | `Script completed` |
| Script threw | `1` | `Script threw: ...` |
| Failed to compile (syntax error) | `1` | `Failed to compile: ...` |
| Run-level timeout / OOM kill | — | item may not exist for this run at all |

Check `exitCode`/`statusMessage`, not `stderr` content, to detect a failed
script — `stderr` also carries `console.error`/`console.warn` output, so its
presence alone isn't failure. A timeout/OOM kill is signaled by the Actor
run's own status (`SUCCEEDED` vs `FAILED`/`ABORTED`/`TIMED-OUT`), not by this
item's absence.

## Permissions & safety

- Sandbox has **no filesystem**; outbound `fetch` (redirects re-validated
  per hop) is limited to the Apify API (`*.apify.com`).
- **No imports** — runs without workerd's `nodejs_compat`, so no Node
  built-ins (`node:net`, `node:fs`, …) or npm packages. This also removes
  `node:net` (a raw-socket path that would bypass the `fetch` allowlist) and
  keeps the run token out of `process.env` (undefined here).
- Each run is an isolated, single-use container — nothing persists between runs.
- This closes **direct fetch-based exfil** — it does not close every path to
  move data out (e.g. `actor.start({ input })` on an Actor with its own
  internet access, or writing to a dataset/key-value store).

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

This Actor's clearest win: run several Actors (or the same Actor over
several inputs) concurrently, then reduce before returning. Chunk it (5–10
at a time) — an unbounded `Promise.all` can hit your account's
concurrent-run or memory limits.

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

`dataset.listItems`/`store` work two ways — `await` for one page, `for
await` to auto-paginate every item (see [the apify binding](#the-apify-binding)):

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

## The `apify` binding

Every method takes one options object and returns parsed JSON — except
`store` and `dataset.listItems`, which return a value that's both a
`Promise` (one page) and an `AsyncIterable` (every match/item,
auto-paginated). Full API docs:
[API.md](https://github.com/apify/actor-code-runtime/blob/master/docs/API.md).
(`?` = optional, `= x` = default)

```js
// Store — GET /v2/store, a top-level Apify API resource (not an Actor method)
apify.store({ search, limit?, offset?, category? })  // → { items, count, offset, limit }; dual Promise/AsyncIterable, see above

// Actors
apify.actor.get({ actorId })                                  // → actor
apify.actor.start({ actorId, input?, memoryMbytes?, timeoutSecs?, maxTotalChargeUsd?, maxItems? })  // → run
apify.actor.call({ actorId, ...startOpts, waitForFinishSecs = 60 })           // → run (may be non-terminal READY/RUNNING past the 60s cap — not an error, see Recipes)
apify.actor.callAndGetItems({ actorId, input?, fields?, limit?, ...runOpts })  // → { run, items } (items may be partial if run is still RUNNING — check run.status)

// Runs
apify.run.get({ runId })                                    // → run
apify.run.waitForFinish({ runId, waitForFinishSecs = 60 })  // → run (same non-terminal caveat)
apify.run.abort({ runId })                                  // → run
apify.run.getLog({ runId, limit? })                         // → string

// Datasets
apify.dataset.create({ name? })                             // → dataset
apify.dataset.pushItems({ datasetId, items })               // → void
apify.dataset.listItems({ datasetId, fields?, omit?, limit?, offset?, clean?, desc? })  // → { items, count, offset, limit, desc }; dual Promise/AsyncIterable, see above
apify.dataset.inferFields({ datasetId, sample = 5 })        // → { itemCount, fields[] }

// Key-value stores
apify.keyValueStore.create({ name? })                        // → store
apify.keyValueStore.set({ storeId, key, value, contentType? })  // → void
apify.keyValueStore.get({ storeId, key })                    // → value | null
apify.keyValueStore.list({ storeId, limit?, exclusiveStartKey? })  // → { items }
```

## Learn more

- Apify MCP Server: <https://mcp.apify.com>
