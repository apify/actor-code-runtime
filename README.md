# Code Runtime (experimental)

> ⚠️ **Experimental infrastructure Actor.** It powers **Code Mode** on
> [mcp.apify.com](https://mcp.apify.com) and is normally invoked by the Apify
> MCP Server, not run by hand. Its behaviour and API may change without notice.

## What it does

This Actor executes a single TypeScript/JavaScript program that an AI agent
submits through the Apify MCP Server's **Code Mode**, then returns whatever the
program printed.

Code Mode exists so an agent can do many Apify operations in **one** program —
search the Store, run an Actor, read its dataset, filter and aggregate the
results — instead of sending every intermediate result back through the model.
This Actor is the sandbox that runs that program.

## Enabling Code Mode on the MCP Server

Code Mode is opt-in. Add the Code Mode tools to the `tools` query parameter of
your mcp.apify.com connection URL:

```
https://mcp.apify.com/?tools=run-code,get-code-docs
```

For full configuration options, use the configurator at
[mcp.apify.com](https://mcp.apify.com).

## How it works

- **One program per run.** The Actor reads your `code`, runs it once, writes the
  result, and exits.
- The code runs inside a [`workerd`](https://github.com/cloudflare/workerd) V8
  isolate: **no filesystem, no package imports**, and outbound network is
  restricted to `*.apify.com`.
- Inside the program a global **`apify`** object exposes a small, typed subset of
  the Apify API — run Actors, read/write datasets and key-value stores — using
  the current run's token.
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
| `code` | string | The TypeScript/JavaScript program to run. It receives the `apify` binding and `console`. |

## Output

A single **dataset item** with the captured streams:

```json
{ "stdout": "Apify: Full-stack web scraping ...\n...", "stderr": "" }
```

If the program throws, the error lands in `stderr`; `stdout` keeps whatever was
printed before the failure.

## Permissions & safety

- Runs with **limited permissions**: the sandbox has no filesystem and can reach
  only the Apify API (`*.apify.com`).
- It uses the **run's own token**, so the program can access only what you can.
- Each run is an isolated, single-use container — nothing persists between runs.

## Learn more

- Apify MCP Server: <https://mcp.apify.com>
- Code Mode design: [apify/apify-mcp-server#794](https://github.com/apify/apify-mcp-server/pull/794)
