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

// ---- actor (read) ----
await check('store', async () => {
    const page = await apify.store({ search: 'hello world', limit: 3 });
    if (!Array.isArray(page.items)) throw new Error('expected items array');
    return `${page.count} actors`;
});
await check('store (for await)', async () => {
    let n = 0;
    for await (const _ of apify.store({ search: 'hello world', limit: 3 })) n++;
    return `${n} actors iterated`;
});
await check('actor.get', async () => {
    const d = await apify.actor.get({ actorId: ACTOR });
    return `${d.username}/${d.name}`;
});

// ---- dataset ----
let datasetId = '';
await check('dataset.create', async () => {
    datasetId = (await apify.dataset.create()).id as string;
    return datasetId;
});
await check('dataset.pushItems', async () => {
    await apify.dataset.pushItems({ datasetId, items: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] });
    return '2 pushed';
});
await check('dataset.listItems', async () => {
    const page = await apify.dataset.listItems({ datasetId });
    return `${page.count} items, offset=${page.offset}, limit=${page.limit}`;
});
await check('dataset.inferFields', async () => {
    const s = await apify.dataset.inferFields({ datasetId });
    return `itemCount=${s.itemCount} fields=${s.fields.map((f) => f.name).join(',')}`;
});
await check('dataset.listItems (for await)', async () => {
    let n = 0;
    for await (const _ of apify.dataset.listItems({ datasetId, limit: 1 })) n++;
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
    const obj = await apify.keyValueStore.get({ storeId, key: 'obj' }) as { hello: string };
    const txt = await apify.keyValueStore.get({ storeId, key: 'txt' });
    const missing = await apify.keyValueStore.get({ storeId, key: 'nope' });
    return `obj.hello=${obj.hello} txt=${txt} missing=${missing}`;
});
await check('keyValueStore.list', async () => {
    const l = await apify.keyValueStore.list({ storeId }) as { items: unknown[] };
    return `${l.items.length} keys`;
});

// ---- run lifecycle ----
let runId = '';
await check('actor.start', async () => {
    const run = await apify.actor.start({ actorId: ACTOR });
    runId = run.id as string;
    return `runId=${runId} status=${run.status}`;
});
await check('run.get', async () => {
    return `status=${(await apify.run.get({ runId })).status}`;
});
await check('run.waitForFinish', async () => {
    return `status=${(await apify.run.waitForFinish({ runId, waitForFinishSecs: 60 })).status}`;
});
await check('run.getLog', async () => {
    return `${(await apify.run.getLog({ runId, limit: 200 })).length} chars`;
});

// ---- run + get items (sync) ----
await check('actor.call', async () => {
    return `status=${(await apify.actor.call({ actorId: ACTOR, waitForFinishSecs: 60 })).status}`;
});
await check('actor.callAndGetItems', async () => {
    const { run, items } = await apify.actor.callAndGetItems({ actorId: ACTOR, limit: 5, waitForFinishSecs: 60 });
    return `status=${run.status} items=${items.length}`;
});

// ---- abort ----
await check('run.abort', async () => {
    const run = await apify.actor.start({ actorId: ACTOR });
    return `status=${(await apify.run.abort({ runId: run.id as string })).status}`;
});

const passed = results.filter(Boolean).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
if (passed === results.length) console.log('ALL_TESTS_PASSED');
else console.error(`SOME_TESTS_FAILED (${results.length - passed} failed)`);
