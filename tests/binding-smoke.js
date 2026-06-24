// Smoke test for the `apify` binding exposed to Code Mode programs. Submitted as
// the Actor's `code` input by test.sh and executed on the built Actor via
// `apify call`. Exercises every binding method and prints a sentinel line
// (ALL_TESTS_PASSED) that test.sh greps for.
const results = [];
async function check(name, fn) {
    try {
        const out = await fn();
        console.log(`PASS ${name}: ${out ?? ''}`);
        results.push(true);
    } catch (e) {
        console.error(`FAIL ${name}: ${e.message}`);
        results.push(false);
    }
}

const ACTOR = 'apify/hello-world';

// ---- actor (read) ----
await check('actor.search', async () => {
    const items = await apify.actor.search({ query: 'hello world', limit: 3 });
    if (!Array.isArray(items)) throw new Error('expected array');
    return `${items.length} actors`;
});
await check('actor.getDetails', async () => {
    const d = await apify.actor.getDetails({ actorId: ACTOR });
    return `${d.username}/${d.name}`;
});

// ---- dataset ----
let datasetId;
await check('dataset.create', async () => {
    datasetId = (await apify.dataset.create()).id;
    return datasetId;
});
await check('dataset.pushItems', async () => {
    await apify.dataset.pushItems({ datasetId, items: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] });
    return '2 pushed';
});
await check('dataset.listItems', async () => {
    const items = await apify.dataset.listItems({ datasetId });
    return `${items.length} items`;
});
await check('dataset.getSchema', async () => {
    const s = await apify.dataset.getSchema({ datasetId });
    return `itemCount=${s.itemCount} fields=${s.fields.map((f) => f.name).join(',')}`;
});
await check('dataset.iterate', async () => {
    let n = 0;
    for await (const _ of apify.dataset.iterate({ datasetId, batchSize: 1 })) n++;
    return `${n} iterated`;
});

// ---- key-value store ----
let storeId;
await check('kvs.create', async () => {
    storeId = (await apify.kvs.create()).id;
    return storeId;
});
await check('kvs.set', async () => {
    await apify.kvs.set({ storeId, key: 'obj', value: { hello: 'world' } });
    await apify.kvs.set({ storeId, key: 'txt', value: 'plain' });
    return 'set obj + txt';
});
await check('kvs.get', async () => {
    const obj = await apify.kvs.get({ storeId, key: 'obj' });
    const txt = await apify.kvs.get({ storeId, key: 'txt' });
    const missing = await apify.kvs.get({ storeId, key: 'nope' });
    return `obj.hello=${obj.hello} txt=${txt} missing=${missing}`;
});
await check('kvs.list', async () => {
    const l = await apify.kvs.list({ storeId });
    return `${l.items.length} keys`;
});

// ---- run lifecycle ----
let runId;
await check('actor.start', async () => {
    const run = await apify.actor.start({ actorId: ACTOR });
    runId = run.id;
    return `runId=${runId} status=${run.status}`;
});
await check('run.get', async () => {
    return `status=${(await apify.run.get({ runId })).status}`;
});
await check('run.wait', async () => {
    return `status=${(await apify.run.wait({ runId, waitForFinishSecs: 60 })).status}`;
});
await check('run.getLog', async () => {
    return `${(await apify.run.getLog({ runId, limit: 200 })).length} chars`;
});

// ---- run + get items (sync) ----
await check('actor.run', async () => {
    return `status=${(await apify.actor.run({ actorId: ACTOR, waitForFinishSecs: 60 })).status}`;
});
await check('actor.runAndGetItems', async () => {
    const { run, items } = await apify.actor.runAndGetItems({ actorId: ACTOR, limit: 5, waitForFinishSecs: 60 });
    return `status=${run.status} items=${items.length}`;
});

// ---- abort ----
await check('run.abort', async () => {
    const run = await apify.actor.start({ actorId: ACTOR });
    return `status=${(await apify.run.abort({ runId: run.id })).status}`;
});

const passed = results.filter(Boolean).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
if (passed === results.length) console.log('ALL_TESTS_PASSED');
else console.error(`SOME_TESTS_FAILED (${results.length - passed} failed)`);
