// Smoke test for the `apify` binding exposed to Code Mode programs. Submitted as
// the Actor's `code` input by test.sh and executed on the built Actor via
// `apify call`. Exercises every binding method and prints a sentinel line
// (ALL_TESTS_PASSED) that test.sh greps for.
//
// `export {}` marks this file as its own ES module, so its top-level consts
// don't collide with the other probe's (both are type-checked in one tsc
// program) and top-level await below is legal. `pnpm build` strips this line
// post-compile (see package.json) -- left in, it would be a syntax error once
// spliced into the wrapping `async function run(apify, console) { ... }`.
export {};

const results: boolean[] = [];
async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
        const out = await fn();
        console.log(`PASS ${name}: ${out ?? ''}`);
        results.push(true);
    } catch (e) {
        console.error(`FAIL ${name}: ${(e as Error).message}`);
        results.push(false);
    }
}

const ACTOR = 'apify/hello-world';
const [ACTOR_USERNAME, ACTOR_NAME] = ACTOR.split('/');

// Every status the Apify API can return for a run. Used to check a returned status is a
// real value, not just any truthy string -- mirrors TERMINAL_STATUSES in worker/runner.ts.
const RUN_STATUSES = new Set(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTING', 'ABORTED', 'TIMING-OUT', 'TIMED-OUT']);

// ---- actor (read) ----
await check('store', async () => {
    const page = await apify.store({ search: 'hello world', limit: 3 });
    if (!Array.isArray(page.items) || page.items.length === 0) throw new Error(`expected non-empty items array, got ${JSON.stringify(page.items)}`);
    if (typeof page.items[0].name !== 'string') throw new Error(`expected item.name string, got ${JSON.stringify(page.items[0])}`);
    return `${page.count} actors`;
});
await check('store (for await)', async () => {
    let n = 0;
    for await (const _ of apify.store({ search: 'hello world', limit: 3 })) n++;
    if (n === 0) throw new Error('expected at least 1 actor iterated, got 0');
    return `${n} actors iterated`;
});
await check('actor.get', async () => {
    const d = await apify.actor.get({ actorId: ACTOR });
    if (d.username !== ACTOR_USERNAME || d.name !== ACTOR_NAME) {
        throw new Error(`actor.get returned username=${d.username} name=${d.name}, expected ${ACTOR_USERNAME}/${ACTOR_NAME}`);
    }
    return `${d.username}/${d.name}`;
});

// ---- dataset ----
let datasetId = '';
await check('dataset.create', async () => {
    datasetId = (await apify.dataset.create()).id as string;
    if (!datasetId) throw new Error('dataset.create returned no id');
    return datasetId;
});
await check('dataset.pushItems', async () => {
    await apify.dataset.pushItems({ datasetId, items: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] });
    return '2 pushed';
});
await check('dataset.listItems', async () => {
    const page = await apify.dataset.listItems({ datasetId });
    if (page.count !== 2 || page.items[0]?.a !== 1 || page.items[0]?.b !== 'x' || page.items[1]?.a !== 2 || page.items[1]?.b !== 'y') {
        throw new Error(`expected 2 pushed items round-tripped, got ${JSON.stringify(page.items)}`);
    }
    return `${page.count} items, offset=${page.offset}, limit=${page.limit}`;
});
await check('dataset.inferFields', async () => {
    const s = await apify.dataset.inferFields({ datasetId });
    const fieldNames = s.fields.map((f) => f.name).sort();
    if (fieldNames.join(',') !== 'a,b') throw new Error(`expected fields a,b, got ${fieldNames.join(',')}`);
    const a = s.fields.find((f) => f.name === 'a');
    const b = s.fields.find((f) => f.name === 'b');
    if (!a?.types.includes('number')) throw new Error(`expected field a to include type number, got ${JSON.stringify(a)}`);
    if (!b?.types.includes('string')) throw new Error(`expected field b to include type string, got ${JSON.stringify(b)}`);
    return `itemCount=${s.itemCount} fields=${fieldNames.join(',')}`;
});
await check('dataset.listItems (for await)', async () => {
    let n = 0;
    for await (const _ of apify.dataset.listItems({ datasetId, limit: 1 })) n++;
    if (n !== 2) throw new Error(`expected 2 pushed items iterated, got ${n}`);
    return `${n} iterated`;
});

// ---- key-value store ----
let storeId = '';
await check('keyValueStore.create', async () => {
    storeId = (await apify.keyValueStore.create()).id as string;
    return storeId;
});
await check('keyValueStore.set', async () => {
    await apify.keyValueStore.set({ storeId, key: 'obj', value: { hello: 'world' } });
    await apify.keyValueStore.set({ storeId, key: 'txt', value: 'plain' });
    return 'set obj + txt';
});
await check('keyValueStore.get', async () => {
    const obj = await apify.keyValueStore.get({ storeId, key: 'obj' }) as { hello?: unknown } | null;
    if (obj?.hello !== 'world') throw new Error(`kvs.get returned ${JSON.stringify(obj)}`);
    const txt = await apify.keyValueStore.get({ storeId, key: 'txt' });
    if (txt !== 'plain') throw new Error(`kvs.get txt returned ${JSON.stringify(txt)}`);
    const missing = await apify.keyValueStore.get({ storeId, key: 'nope' });
    if (missing !== null) throw new Error(`kvs.get missing key returned ${JSON.stringify(missing)}, expected null`);
    return `obj.hello=${obj.hello} txt=${txt} missing=${missing}`;
});
await check('keyValueStore.list', async () => {
    const l = await apify.keyValueStore.list({ storeId }) as { items: { key: string }[] };
    const keys = l.items.map((i) => i.key);
    if (!keys.includes('obj') || !keys.includes('txt')) throw new Error(`expected keys obj+txt in list, got ${JSON.stringify(keys)}`);
    return `${l.items.length} keys`;
});

// ---- run lifecycle ----
let runId = '';
await check('actor.start', async () => {
    const run = await apify.actor.start({ actorId: ACTOR });
    runId = run.id as string;
    if (!runId) throw new Error('actor.start returned no run id');
    if (!RUN_STATUSES.has(run.status)) throw new Error(`actor.start returned unexpected status: ${JSON.stringify(run.status)}`);
    return `runId=${runId} status=${run.status}`;
});
await check('run.get', async () => {
    const run = await apify.run.get({ runId });
    if (run.id !== runId) throw new Error(`run.get returned id=${run.id}, expected ${runId}`);
    if (!RUN_STATUSES.has(run.status)) throw new Error(`run.get returned unexpected status: ${JSON.stringify(run.status)}`);
    return `status=${run.status}`;
});
await check('run.waitForFinish', async () => {
    const run = await apify.run.waitForFinish({ runId, waitForFinishSecs: 60 });
    if (!RUN_STATUSES.has(run.status)) throw new Error(`run.waitForFinish returned unexpected status: ${JSON.stringify(run.status)}`);
    return `status=${run.status}`;
});
await check('run.getLog', async () => {
    const log = await apify.run.getLog({ runId, limit: 200 });
    if (typeof log !== 'string' || log.length === 0) throw new Error(`run.getLog returned ${JSON.stringify(log)}`);
    return `${log.length} chars`;
});

// ---- run + get items (sync) ----
await check('actor.call', async () => {
    const run = await apify.actor.call({ actorId: ACTOR, waitForFinishSecs: 60 });
    if (!RUN_STATUSES.has(run.status)) throw new Error(`actor.call returned unexpected status: ${JSON.stringify(run.status)}`);
    return `status=${run.status}`;
});
await check('actor.callAndGetItems', async () => {
    const { run, items } = await apify.actor.callAndGetItems({ actorId: ACTOR, limit: 5, waitForFinishSecs: 60 });
    if (!RUN_STATUSES.has(run.status)) throw new Error(`actor.callAndGetItems returned unexpected status: ${JSON.stringify(run.status)}`);
    if (!Array.isArray(items)) throw new Error(`actor.callAndGetItems returned non-array items: ${JSON.stringify(items)}`);
    return `status=${run.status} items=${items.length}`;
});

// ---- abort ----
await check('run.abort', async () => {
    const run = await apify.actor.start({ actorId: ACTOR });
    const aborted = await apify.run.abort({ runId: run.id as string });
    if (aborted.status !== 'ABORTING' && aborted.status !== 'ABORTED') {
        throw new Error(`run.abort returned unexpected status: ${JSON.stringify(aborted.status)}`);
    }
    return `status=${aborted.status}`;
});

const passed = results.filter(Boolean).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
if (passed === results.length) console.log('ALL_TESTS_PASSED');
else console.error(`SOME_TESTS_FAILED (${results.length - passed} failed)`);
