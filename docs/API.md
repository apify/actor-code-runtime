# The `apify` binding — API reference

Inside a Code Mode script a global **`apify`** object exposes a small, typed
subset of the Apify API, authenticated with the current run's token. This
document describes every method in detail.

## Conventions

- **Every method is `async`** — `await` the result (or `for await` for
  `dataset.iterate`).
- **One options object.** Each method takes a single object argument; there are
  no positional parameters.
- **`actorId`** accepts either `username/name` (e.g. `apify/rag-web-browser`) or
  the Actor's ID.
- **Return values.** The Apify API wraps most responses in a `{ "data": … }`
  envelope. These methods **unwrap it for you** and return the inner value; the
  linked API page describes that inner `data` shape. Where a method transforms
  the response further (extracts an array, parses by content type, infers a
  schema, returns plain text), the exact output is spelled out below.
- **`Apify API:`** each method links to its underlying endpoint on
  [docs.apify.com/api/v2](https://docs.apify.com/api/v2) so you can inspect the
  live request/response schema.
- **Errors.** A non-2xx API response throws an `Error` whose message is
  `<METHOD> <path> failed: <status> <body>`. The one exception is
  [`keyValueStore.get`](#keyvaluestoreget--value--null), which returns `null` for a missing key.
- **Network.** Outbound `fetch` from your script is restricted to `apify.com`
  and its subdomains.

---

## `apify.store`

Apify's own API tags this endpoint `Store` — a top-level resource, not an
Actor method — so the binding mirrors that: `apify.store(...)`, not
`apify.actor.store(...)`.

### `apify.store({ search, limit?, category? })` → `Actor[]`

Search the Apify Store.

| Param | Type | Required | Description |
|---|---|---|---|
| `search` | `string` | yes | Full-text search query. |
| `limit` | `number` | no | Maximum number of results. |
| `category` | `string` | no | Restrict to a Store category. |

**Output:** the `data.items` array of the Store listing (the pagination wrapper
is dropped) — i.e. an `Actor[]`.
**Apify API:** [`GET /v2/store`](https://docs.apify.com/api/v2/store-get)

```js
const actors = await apify.store({ search: 'web scraper', limit: 5 });
console.log(actors.map((a) => `${a.username}/${a.name}`).join('\n'));
```

---

## `apify.actor`

### `actor.get({ actorId })` → `Actor`

Fetch the full record for one Actor.

| Param | Type | Required | Description |
|---|---|---|---|
| `actorId` | `string` | yes | `username/name` or Actor ID. |

**Output:** the Actor object (unwrapped `data`).
**Apify API:** [`GET /v2/acts/{actorId}`](https://docs.apify.com/api/v2/act-get)

### `actor.start({ actorId, input?, memoryMbytes?, timeoutSecs?, maxTotalChargeUsd?, maxItems? })` → `Run`

Start an Actor **asynchronously** and return immediately with a run record in
`READY`/`RUNNING` state. Use [`run.waitForFinish`](#runwaitforfinish--run) to block for the result.

| Param | Type | Required | Description |
|---|---|---|---|
| `actorId` | `string` | yes | `username/name` or Actor ID. |
| `input` | `object` | no | Actor input (defaults to `{}`). |
| `memoryMbytes` | `number` | no | Memory limit for the run (`memory` query param). |
| `timeoutSecs` | `number` | no | Run timeout in seconds (`timeout`). |
| `maxTotalChargeUsd` | `number` | no | Hard cap on the run's cost. |
| `maxItems` | `number` | no | Max dataset items for pay-per-result Actors. |

**Output:** the Run object (unwrapped `data`).
**Apify API:** [`POST /v2/acts/{actorId}/runs`](https://docs.apify.com/api/v2/act-runs-post)

### `actor.call({ actorId, input?, waitForFinishSecs?, memoryMbytes?, timeoutSecs?, maxTotalChargeUsd?, maxItems? })` → `Run`

Start an Actor and **wait** for it to finish (or until `waitForFinishSecs`
elapses), then return the run record.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `actorId` | `string` | yes | | `username/name` or Actor ID. |
| `input` | `object` | no | `{}` | Actor input. |
| `waitForFinishSecs` | `number` | no | `60` | Seconds to wait (`waitForFinish`). **The Apify API caps a single wait at 60s** — for longer runs use `start()` + a `run.waitForFinish()` loop. |
| `memoryMbytes` | `number` | no | | Memory limit. |
| `timeoutSecs` | `number` | no | | Run timeout. |
| `maxTotalChargeUsd` | `number` | no | | Cost cap. |
| `maxItems` | `number` | no | | Max items (pay-per-result). |

**Output:** the Run object (unwrapped `data`), exposing `defaultDatasetId` and
`defaultKeyValueStoreId` for reading results. Uses the standard run endpoint
(not `/run-sync`, which returns the output record instead of the run object).
**Apify API:** [`POST /v2/acts/{actorId}/runs`](https://docs.apify.com/api/v2/act-runs-post)

### `actor.callAndGetItems({ actorId, input?, fields?, limit?, ...runOpts })` → `{ run, items }`

Convenience wrapper: `actor.call(...)` followed by reading the run's default
dataset via `dataset.listItems`.

| Param | Type | Required | Description |
|---|---|---|---|
| `actorId` | `string` | yes | `username/name` or Actor ID. |
| `input` | `object` | no | Actor input. |
| `fields` | `string[]` | no | Restrict returned item fields. |
| `limit` | `number` | no | Max items to fetch. |
| `...runOpts` | | no | Any `actor.call` option (`waitForFinishSecs`, `memoryMbytes`, `timeoutSecs`, `maxTotalChargeUsd`, `maxItems`). |

**Output (custom):**

```js
{
  run: Run,        // the run object, as actor.call returns
  items: object[]  // items from run.defaultDatasetId
}
```

**Apify API:** [`POST /v2/acts/{actorId}/runs`](https://docs.apify.com/api/v2/act-runs-post)
then [`GET /v2/datasets/{datasetId}/items`](https://docs.apify.com/api/v2/dataset-items-get)

```js
const { run, items } = await apify.actor.callAndGetItems({
    actorId: 'apify/rag-web-browser',
    input: { query: 'apify' },
    limit: 3,
});
console.log(run.status, items.length);
```

---

## `apify.run`

### `run.get({ runId })` → `Run`

Fetch the current run record (status, stats, default storage IDs).

| Param | Type | Required | Description |
|---|---|---|---|
| `runId` | `string` | yes | The run ID. |

**Output:** the Run object (unwrapped `data`).
**Apify API:** [`GET /v2/actor-runs/{runId}`](https://docs.apify.com/api/v2/actor-run-get)

### `run.waitForFinish({ runId, waitForFinishSecs? })` → `Run`

Block until the run terminates or `waitForFinishSecs` elapses, whichever comes
first, then return the run record.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `runId` | `string` | yes | | The run ID. |
| `waitForFinishSecs` | `number` | no | `60` | Seconds to wait (`waitForFinish`). **Capped at 60s by the API**; poll in a loop for longer runs. |

**Output:** the Run object (unwrapped `data`).
**Apify API:** [`GET /v2/actor-runs/{runId}`](https://docs.apify.com/api/v2/actor-run-get)

### `run.abort({ runId })` → `Run`

Abort a running run. Returns the run record (status transitions to `ABORTING`).
Aborting a finished run is an API error.

| Param | Type | Required | Description |
|---|---|---|---|
| `runId` | `string` | yes | The run ID. |

**Output:** the Run object (unwrapped `data`).
**Apify API:** [`POST /v2/actor-runs/{runId}/abort`](https://docs.apify.com/api/v2/act-run-abort-post)

### `run.getLog({ runId, limit? })` → `string`

Return the run's log as text.

| Param | Type | Required | Description |
|---|---|---|---|
| `runId` | `string` | yes | The run ID. |
| `limit` | `number` | no | If set, return only the **last** `limit` characters (client-side tail; the full log is fetched). |

**Output (custom):** the raw log **text** (not JSON). With `limit`, the last
`limit` characters.
**Apify API:** [`GET /v2/logs/{runId}`](https://docs.apify.com/api/v2/log-get)

---

## `apify.dataset`

### `dataset.create({ name? })` → `Dataset`

Create a dataset and return its record (use `.id` for subsequent calls).

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | no | Named (persistent) dataset; omit for an unnamed (temporary) one. |

**Output:** the Dataset object (unwrapped `data`).
**Apify API:** [`POST /v2/datasets`](https://docs.apify.com/api/v2/datasets-post)

### `dataset.pushItems({ datasetId, items })` → `void`

Append one or more items to a dataset.

| Param | Type | Required | Description |
|---|---|---|---|
| `datasetId` | `string` | yes | Target dataset ID. |
| `items` | `object \| object[]` | yes | A single item or an array of items. |

**Output:** none (resolves once the items are stored).
**Apify API:** [`POST /v2/datasets/{datasetId}/items`](https://docs.apify.com/api/v2/dataset-items-post)

```js
const ds = await apify.dataset.create();
await apify.dataset.pushItems({ datasetId: ds.id, items: [{ a: 1 }, { a: 2 }] });
const items = await apify.dataset.listItems({ datasetId: ds.id });
```

### `dataset.listItems({ datasetId, fields?, omit?, limit?, offset?, clean?, desc? })` → `object[]`

Read a page of items.

| Param | Type | Required | Description |
|---|---|---|---|
| `datasetId` | `string` | yes | Dataset ID. |
| `fields` | `string[]` | no | Only include these fields (joined into `fields`). |
| `omit` | `string[]` | no | Exclude these fields. |
| `limit` | `number` | no | Page size. |
| `offset` | `number` | no | Starting offset. |
| `clean` | `boolean` | no | Skip empty items / hidden fields (`clean=1`). |
| `desc` | `boolean` | no | Reverse (newest first, `desc=1`). |

**Output (custom):** the **items array directly** — this endpoint already
returns a bare array (no `data`/pagination wrapper). A dataset's pagination
total is eventually consistent right after creation, so no `total` is surfaced;
use [`inferFields`](#datasetinferfields--schema) for a count or
[`iterate`](#datasetiterate--asyncgeneratorobject) to consume everything.
**Apify API:** [`GET /v2/datasets/{datasetId}/items`](https://docs.apify.com/api/v2/dataset-items-get)

### `dataset.iterate({ datasetId, fields?, omit?, clean?, desc?, batchSize? })` → `AsyncGenerator<object>`

Async-iterate the **entire** dataset, paging internally so you don't manage
offsets. Stops when a page returns fewer than `batchSize` items.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `datasetId` | `string` | yes | | Dataset ID. |
| `fields` | `string[]` | no | | Only include these fields. |
| `omit` | `string[]` | no | | Exclude these fields. |
| `clean` | `boolean` | no | | Skip empty items / hidden fields. |
| `desc` | `boolean` | no | | Reverse order. |
| `batchSize` | `number` | no | `1000` | Items fetched per page. |

**Output (custom):** an async generator yielding one item (`object`) at a time.
**Apify API:** [`GET /v2/datasets/{datasetId}/items`](https://docs.apify.com/api/v2/dataset-items-get) (paged internally)

```js
let count = 0;
for await (const item of apify.dataset.iterate({ datasetId })) count++;
console.log('total items:', count);
```

### `dataset.inferFields({ datasetId, sample? })` → `Schema`

Infer a lightweight schema from a sample of items (Apify has no schema endpoint).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `datasetId` | `string` | yes | | Dataset ID. |
| `sample` | `number` | no | `5` | Number of items to inspect. |

**Output (custom):**

```js
{
  itemCount,          // number | undefined — from the dataset metadata (eventually consistent)
  sampleSize,         // number of items actually inspected
  fields: [           // one entry per field seen across the sample
    {
      name,           // field name
      types,          // string[], e.g. ['string'] or ['number','null']
      nullable        // boolean — true if any sampled value was null
    }
  ]
}
```

**Apify API:** [`GET /v2/datasets/{datasetId}`](https://docs.apify.com/api/v2/dataset-get)
(for `itemCount`) + [`GET /v2/datasets/{datasetId}/items`](https://docs.apify.com/api/v2/dataset-items-get) (the sample)

---

## `apify.keyValueStore`

### `keyValueStore.create({ name? })` → `KeyValueStore`

Create a key-value store and return its record.

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | no | Named (persistent) store; omit for an unnamed (temporary) one. |

**Output:** the key-value store's record object (unwrapped `data`).
**Apify API:** [`POST /v2/key-value-stores`](https://docs.apify.com/api/v2/key-value-stores-post)

### `keyValueStore.set({ storeId, key, value, contentType? })` → `void`

Write a record. The content type is inferred from `value`:

| `value` type | Stored as |
|---|---|
| `object` | `application/json; charset=utf-8` |
| `string` | `text/plain; charset=utf-8` |
| `Uint8Array` / `ArrayBuffer` | `application/octet-stream` |

| Param | Type | Required | Description |
|---|---|---|---|
| `storeId` | `string` | yes | Store ID. |
| `key` | `string` | yes | Record key. |
| `value` | `object \| string \| Uint8Array \| ArrayBuffer` | yes | Value to store. |
| `contentType` | `string` | no | Override the inferred content type. |

**Output:** none (resolves once the record is stored).
**Apify API:** [`PUT /v2/key-value-stores/{storeId}/records/{key}`](https://docs.apify.com/api/v2/key-value-store-record-put)

### `keyValueStore.get({ storeId, key })` → `value` \| `null`

Read a record.

| Param | Type | Required | Description |
|---|---|---|---|
| `storeId` | `string` | yes | Store ID. |
| `key` | `string` | yes | Record key. |

**Output (custom):** the value, typed by the stored content type —

- `application/json` → parsed **object**
- `text/*` → **string**
- anything else → **`Uint8Array`**

Returns **`null`** when the key does not exist (404) instead of throwing, so you
can do lookup-or-default without a `try/catch`.
**Apify API:** [`GET /v2/key-value-stores/{storeId}/records/{key}`](https://docs.apify.com/api/v2/key-value-store-record-get)

```js
const kv = await apify.keyValueStore.create();
await apify.keyValueStore.set({ storeId: kv.id, key: 'state', value: { seen: [] } });
const state = await apify.keyValueStore.get({ storeId: kv.id, key: 'state' }); // → { seen: [] }
const missing = await apify.keyValueStore.get({ storeId: kv.id, key: 'nope' }); // → null
```

### `keyValueStore.list({ storeId, limit?, exclusiveStartKey? })` → `{ items, … }`

List keys in a store.

| Param | Type | Required | Description |
|---|---|---|---|
| `storeId` | `string` | yes | Store ID. |
| `limit` | `number` | no | Max keys to return. |
| `exclusiveStartKey` | `string` | no | Continue listing after this key (pagination). |

**Output:** the unwrapped `data`: `{ items: [{ key, size }], count, limit,
isTruncated, exclusiveStartKey, nextExclusiveStartKey }`.
**Apify API:** [`GET /v2/key-value-stores/{storeId}/keys`](https://docs.apify.com/api/v2/key-value-store-keys-get)

---

## `console`

`console` is captured, not printed live:

| Method | Stream |
|---|---|
| `console.log`, `console.info` | **stdout** |
| `console.error`, `console.warn` | **stderr** |

Non-string arguments are `JSON.stringify`'d. When the script finishes, both
streams and the script's exit status are written to the run's default dataset as
a single item:

```json
{ "stdout": "...", "stderr": "...", "exitCode": 0 }
```

`exitCode` is the script's effective exit status: `0` when it returns normally,
`1` when it throws. It is distinct from the Actor run's status — see below.

## Error handling

- A non-2xx API response throws `Error: <METHOD> <path> failed: <status> <body>`.
- If your script throws, the error (stack/message) is appended to **stderr**,
  `exitCode` is set to `1`, and the run still **succeeds** with whatever was
  printed beforehand — so failures are observable in the output rather than
  crashing the run. Check `exitCode` (not `stderr`) to detect a failed script:
  `stderr` may be non-empty from ordinary `console.error` / `console.warn`
  logging even on a successful run.
