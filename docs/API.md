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
- **Errors.** A non-2xx API response throws an `Error` whose message is
  `<METHOD> <path> failed: <status> <body>`. The one exception is
  [`kvs.get`](#kvsget--value--null), which returns `null` for a missing key
  instead of throwing.
- **Network.** Outbound `fetch` from your script is restricted to `apify.com`
  and its subdomains.

---

## `apify.actor`

### `actor.search({ query, limit?, category? })` → `Actor[]`

Search the Apify Store.

| Param | Type | Required | Description |
|---|---|---|---|
| `query` | `string` | yes | Full-text search query. |
| `limit` | `number` | no | Maximum number of results. |
| `category` | `string` | no | Restrict to a Store category. |

Returns the array of matching Store Actor records.

```js
const actors = await apify.actor.search({ query: 'web scraper', limit: 5 });
console.log(actors.map((a) => `${a.username}/${a.name}`).join('\n'));
```

### `actor.getDetails({ actorId })` → `Actor`

Fetch the full record for one Actor.

| Param | Type | Required | Description |
|---|---|---|---|
| `actorId` | `string` | yes | `username/name` or Actor ID. |

### `actor.start({ actorId, input?, memoryMbytes?, timeoutSecs?, maxTotalChargeUsd?, maxItems? })` → `Run`

Start an Actor **asynchronously** and return immediately with a run record in
`READY`/`RUNNING` state. Use [`run.wait`](#runwait--run) to block for the result.

| Param | Type | Required | Description |
|---|---|---|---|
| `actorId` | `string` | yes | `username/name` or Actor ID. |
| `input` | `object` | no | Actor input (defaults to `{}`). |
| `memoryMbytes` | `number` | no | Memory limit for the run. |
| `timeoutSecs` | `number` | no | Run timeout in seconds. |
| `maxTotalChargeUsd` | `number` | no | Hard cap on the run's cost. |
| `maxItems` | `number` | no | Max dataset items for pay-per-result Actors. |

### `actor.run({ actorId, input?, waitForFinishSecs?, memoryMbytes?, timeoutSecs?, maxTotalChargeUsd?, maxItems? })` → `Run`

Start an Actor and **wait** for it to finish (or until `waitForFinishSecs`
elapses), then return the run record.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `actorId` | `string` | yes | | `username/name` or Actor ID. |
| `input` | `object` | no | `{}` | Actor input. |
| `waitForFinishSecs` | `number` | no | `60` | Seconds to wait. **The Apify API caps a single wait at 60s** — for longer runs use `start()` + a `run.wait()` loop. |
| `memoryMbytes` | `number` | no | | Memory limit. |
| `timeoutSecs` | `number` | no | | Run timeout. |
| `maxTotalChargeUsd` | `number` | no | | Cost cap. |
| `maxItems` | `number` | no | | Max items (pay-per-result). |

The run record exposes `defaultDatasetId` and `defaultKeyValueStoreId` for
reading results.

### `actor.runAndGetItems({ actorId, input?, fields?, limit?, ...runOpts })` → `{ run, items }`

Convenience wrapper: `actor.run(...)` followed by reading the run's default
dataset.

| Param | Type | Required | Description |
|---|---|---|---|
| `actorId` | `string` | yes | `username/name` or Actor ID. |
| `input` | `object` | no | Actor input. |
| `fields` | `string[]` | no | Restrict returned item fields. |
| `limit` | `number` | no | Max items to fetch. |
| `...runOpts` | | no | Any `actor.run` option (`waitForFinishSecs`, `memoryMbytes`, `timeoutSecs`, `maxTotalChargeUsd`, `maxItems`). |

Returns `{ run: Run, items: object[] }`.

```js
const { run, items } = await apify.actor.runAndGetItems({
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

### `run.wait({ runId, waitForFinishSecs? })` → `Run`

Block until the run terminates or `waitForFinishSecs` elapses, whichever comes
first, then return the run record.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `runId` | `string` | yes | | The run ID. |
| `waitForFinishSecs` | `number` | no | `60` | Seconds to wait. **Capped at 60s by the API**; poll in a loop for longer runs. |

### `run.abort({ runId })` → `Run`

Abort a running run. Returns the run record (status transitions to `ABORTING`).

| Param | Type | Required | Description |
|---|---|---|---|
| `runId` | `string` | yes | The run ID. |

### `run.getLog({ runId, limit? })` → `string`

Return the run's log as text.

| Param | Type | Required | Description |
|---|---|---|---|
| `runId` | `string` | yes | The run ID. |
| `limit` | `number` | no | If set, return only the **last** `limit` characters (client-side tail; the full log is fetched). |

---

## `apify.dataset`

### `dataset.create({ name? })` → `Dataset`

Create a dataset and return its record (use `.id` for subsequent calls).

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | no | Named (persistent) dataset; omit for an unnamed (temporary) one. |

### `dataset.pushItems({ datasetId, items })` → `void`

Append one or more items to a dataset.

| Param | Type | Required | Description |
|---|---|---|---|
| `datasetId` | `string` | yes | Target dataset ID. |
| `items` | `object \| object[]` | yes | A single item or an array of items. |

### `dataset.listItems({ datasetId, fields?, omit?, limit?, offset?, clean?, desc? })` → `object[]`

Read a page of items. Returns the items array directly (no pagination wrapper).

| Param | Type | Required | Description |
|---|---|---|---|
| `datasetId` | `string` | yes | Dataset ID. |
| `fields` | `string[]` | no | Only include these fields. |
| `omit` | `string[]` | no | Exclude these fields. |
| `limit` | `number` | no | Page size. |
| `offset` | `number` | no | Starting offset. |
| `clean` | `boolean` | no | Skip empty items / hidden fields. |
| `desc` | `boolean` | no | Reverse (newest first). |

> A dataset's pagination total is eventually consistent right after creation, so
> no `total` is surfaced. Use [`getSchema`](#datasetgetschema--schema) for an
> item count, or [`iterate`](#datasetiterate--asyncgeneratorobject) to consume
> everything.

### `dataset.iterate({ datasetId, fields?, omit?, clean?, desc?, batchSize? })` → `AsyncGenerator<object>`

Async-iterate the **entire** dataset, paging internally so you don't manage
offsets.

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `datasetId` | `string` | yes | | Dataset ID. |
| `fields` | `string[]` | no | | Only include these fields. |
| `omit` | `string[]` | no | | Exclude these fields. |
| `clean` | `boolean` | no | | Skip empty items / hidden fields. |
| `desc` | `boolean` | no | | Reverse order. |
| `batchSize` | `number` | no | `1000` | Items fetched per page. |

```js
let count = 0;
for await (const item of apify.dataset.iterate({ datasetId })) count++;
console.log('total items:', count);
```

### `dataset.getSchema({ datasetId, sample? })` → `Schema`

Infer a lightweight schema from a sample of items (Apify has no schema endpoint).

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `datasetId` | `string` | yes | | Dataset ID. |
| `sample` | `number` | no | `5` | Number of items to inspect. |

Returns:

```js
{
  itemCount,          // number | undefined (dataset metadata; eventually consistent)
  sampleSize,         // number of items actually inspected
  fields: [           // one entry per field seen in the sample
    { name, types, nullable }   // types: string[] (e.g. ['string','null']); nullable: boolean
  ]
}
```

---

## `apify.kvs`

### `kvs.create({ name? })` → `Store`

Create a key-value store and return its record.

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | no | Named (persistent) store; omit for an unnamed (temporary) one. |

### `kvs.set({ storeId, key, value, contentType? })` → `void`

Write a record. The content type is inferred from `value`:

| `value` type | Stored as |
|---|---|
| `object` | `application/json` |
| `string` | `text/plain; charset=utf-8` |
| `Uint8Array` / `ArrayBuffer` | `application/octet-stream` |

| Param | Type | Required | Description |
|---|---|---|---|
| `storeId` | `string` | yes | Store ID. |
| `key` | `string` | yes | Record key. |
| `value` | `object \| string \| Uint8Array \| ArrayBuffer` | yes | Value to store. |
| `contentType` | `string` | no | Override the inferred content type. |

### `kvs.get({ storeId, key })` → `value` \| `null`

Read a record. The return type follows the stored content type:

- `application/json` → parsed **object**
- `text/*` → **string**
- anything else → **`Uint8Array`**

Returns **`null`** when the key does not exist (404), so you can do
lookup-or-default without a `try/catch`.

| Param | Type | Required | Description |
|---|---|---|---|
| `storeId` | `string` | yes | Store ID. |
| `key` | `string` | yes | Record key. |

### `kvs.list({ storeId, limit?, exclusiveStartKey? })` → `{ items, ... }`

List keys in a store.

| Param | Type | Required | Description |
|---|---|---|---|
| `storeId` | `string` | yes | Store ID. |
| `limit` | `number` | no | Max keys to return. |
| `exclusiveStartKey` | `string` | no | Continue listing after this key (pagination). |

Returns the store-keys listing, whose `items` is an array of `{ key, size }`.

---

## `console`

`console` is captured, not printed live:

| Method | Stream |
|---|---|
| `console.log`, `console.info` | **stdout** |
| `console.error`, `console.warn` | **stderr** |

Non-string arguments are `JSON.stringify`'d. When the script finishes, both
streams are written to the run's default dataset as a single item:

```json
{ "stdout": "...", "stderr": "..." }
```

## Error handling

- A non-2xx API response throws `Error: <METHOD> <path> failed: <status> <body>`.
- If your script throws, the error (stack/message) is appended to **stderr** and
  the run still **succeeds** with whatever was printed beforehand — so failures
  are observable in the output rather than crashing the run.
