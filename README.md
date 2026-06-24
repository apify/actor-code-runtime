# Code Runtime (experimental)

> ⚠️ **Experimental infrastructure Actor.** It powers **Code Mode** on
> [mcp.apify.com](https://mcp.apify.com) and is normally invoked by the Apify
> MCP Server, not run by hand. Its behaviour and API may change without notice.

## What it does

This Actor executes TypeScript/JavaScript that an AI agent submits through the
Apify MCP Server's **Code Mode**, then returns whatever the script printed.

Code Mode exists so an agent can do many Apify operations in **one go** —
search the Store, run an Actor, read its dataset, filter and aggregate the
results — instead of sending every intermediate result back through the model
and wasting tokens. This Actor is the sandbox that runs that script.

## Enabling Code Mode on the MCP Server

Code Mode is opt-in. Add the Code Mode tools to the `tools` query parameter of
your mcp.apify.com connection URL:

```
https://mcp.apify.com/?tools=run-code,get-code-docs
```

For full configuration options, use the configurator at
[mcp.apify.com](https://mcp.apify.com).

## How it works

- **One script per run.** The Actor reads your `code`, runs it once, writes the
  result, and exits.
- The code runs inside a [`workerd`](https://github.com/cloudflare/workerd) V8
  isolate: **no filesystem, no package imports**, and outbound network is
  restricted to `*.apify.com`.
- Inside the script a global **`apify`** object exposes a small, typed subset of
  the Apify API — run Actors, read/write datasets and key-value stores — using
  the current run's token (see below).
- `console.log` / `console.info` go to **stdout**; `console.error` /
  `console.warn` go to **stderr**. The two streams are captured separately.

## Input

```json
{
  "code": "const { items } = await apify.actor.runAndGetItems({ actorId: 'apify/rag-web-browser', input: { query: 'apify' }, limit: 3 });\nconsole.log(items.map((i) => i.metadata?.title).join('\\n'));"
}
```

| Field | Type | Description |
|---|---|---|
| `code` | string | The TypeScript/JavaScript script to run. It receives the `apify` binding and `console`. |

## Output

A single **dataset item** with the captured streams:

```json
{ "stdout": "Apify: Full-stack web scraping ...\n...", "stderr": "" }
```

If the script throws, the error lands in `stderr`; `stdout` keeps whatever was
printed before the failure.

## Permissions & safety

- Runs with **limited permissions**: the sandbox has no filesystem and can reach
  only the Apify API (`*.apify.com`).
- It uses the **run's own token**, so the program can access only what you can.
- Each run is an isolated, single-use container — nothing persists between runs.

## The `apify` binding

Every method takes one options object and returns parsed JSON
(`?` = optional, `= x` = default):

```js
// Actors
apify.actor.search({ query, limit?, category? })            // → actors[]
apify.actor.getDetails({ actorId })                         // → actor
apify.actor.start({ actorId, input?, memoryMbytes?, timeoutSecs?, maxTotalChargeUsd?, maxItems? })  // → run
apify.actor.run({ actorId, ...startOpts, waitForFinishSecs = 60 })            // → run (waits)
apify.actor.runAndGetItems({ actorId, input?, fields?, limit?, ...runOpts })  // → { run, items }

// Runs
apify.run.get({ runId })                                    // → run
apify.run.wait({ runId, waitForFinishSecs = 60 })           // → run
apify.run.abort({ runId })                                  // → run
apify.run.getLog({ runId, limit? })                         // → string

// Datasets
apify.dataset.create({ name? })                             // → dataset
apify.dataset.pushItems({ datasetId, items })               // → void
apify.dataset.listItems({ datasetId, fields?, omit?, limit?, offset?, clean?, desc? })  // → items[]
apify.dataset.iterate({ datasetId, batchSize = 1000, ...filters })  // → async iterable
apify.dataset.getSchema({ datasetId, sample = 5 })          // → { itemCount, fields[] }

// Key-value stores
apify.kvs.create({ name? })                                 // → store
apify.kvs.set({ storeId, key, value, contentType? })        // → void
apify.kvs.get({ storeId, key })                             // → value | null
apify.kvs.list({ storeId, limit?, exclusiveStartKey? })     // → { items }
```

## Learn more

- Apify MCP Server: <https://mcp.apify.com>
- Code Mode design: [apify/apify-mcp-server#794](https://github.com/apify/apify-mcp-server/pull/794)
