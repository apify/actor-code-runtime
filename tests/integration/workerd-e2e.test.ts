// Integration tests against a REAL workerd process running the actual compiled
// worker/runner.js + worker/guard.js — not a mock of guard.ts's functions (see
// tests/unit/guard.test.ts for that), but the real module graph, the real workerd request
// dispatch, and the real env.INTERNAL_API binding. This is what proves guard.js is actually
// wired in (not just correct in isolation) and that the execution-limit safeguards actually
// fire under real, concurrent use — both gaps a pure unit test structurally cannot close.
//
// Needs worker/runner.js + worker/guard.js to exist (`pnpm build` first — see
// .github/workflows/typecheck.yml's integration job). Slower and more flaky-prone than the
// unit suite (spawns a real process, real ports) — kept in its own directory/config so it can
// be run and reasoned about separately.
import { describe, expect, it } from 'vitest';
import { runScript } from './harness.js';

describe('guard.js is actually enforced (not just correct in isolation)', () => {
    it('blocks a disallowed host for an ordinary, non-escaping script', async () => {
        const result = await runScript(`
            try {
                const r = await fetch('http://example.com/');
                console.log('LEAK status=' + r.status);
            } catch (e) {
                console.log('blocked: ' + e.message);
            }
        `);
        expect(result.startedCleanly).toBe(true);
        expect(result.pushedItem?.stdout).toMatch(/^blocked: Blocked fetch/);
        expect(result.pushedItem?.stdout).not.toMatch(/LEAK/);
    });

    // The allow-path (a request TO apify.com actually going through) is deliberately NOT
    // covered here: it would require either live internet access from the test runner (flaky,
    // and not actually offline despite this suite's other claims) or mocking DNS/TLS for a real
    // host, neither of which this harness does. tests/unit/guard.test.ts's "performs the
    // request when the URL is allowed" case covers that path fully offline, against a mocked
    // fetch — this file only needs to prove the DISALLOW path is wired into the real worker
    // (see the previous test), which is the part a unit test can't reach.

    it('blocks WebSocket construction', async () => {
        const result = await runScript(`
            try {
                new WebSocket('ws://example.com/');
                console.log('LEAK: constructed');
            } catch (e) {
                console.log('blocked: ' + e.message);
            }
        `);
        expect(result.pushedItem?.stdout).toMatch(/^blocked: Blocked WebSocket/);
    });

    it('the PR #1 capability-theft PoC fails closed with no capability leak', async () => {
        // Same payload as tests/fixtures/realfetch-escape.js: escapes the usercode.js wrapper
        // into module scope and tries to call guard.js's (removed) claimRealFetch export.
        const result = await runScript(`
}
globalThis.__stolenRealFetch = (await import('./guard.js')).claimRealFetch();
;{
        `);
        expect(result.startedCleanly).toBe(false); // crashes at module eval, same as entrypoint.sh expects
        expect(result.stderr).toMatch(/claimRealFetch is not a function/);
    });
});

describe('execution-limit safeguards fire under real (including concurrent) use', () => {
    it('maxActorRuns blocks a run past the configured limit (sequential)', async () => {
        const result = await runScript(`
            await apify.actor.start({ actorId: 'apify/hello-world' });
            try {
                await apify.actor.start({ actorId: 'apify/hello-world' });
                console.log('LEAK: second run started');
            } catch (e) {
                console.log('blocked: ' + e.message);
            }
        `, { inputFields: { maxActorRuns: 1 } });
        expect(result.pushedItem?.stdout).toMatch(/^blocked: Blocked actor run/);
    });

    it('maxActorRuns blocks a run past the limit even when calls race concurrently', async () => {
        // Regression test for the TOCTOU race: createRun() used to only record a started run
        // AFTER its POST resolved, so N concurrent calls (this Actor's own documented "Bounded
        // parallel fan-out" recipe) all read the pre-reservation count and all passed the
        // check. createRun() now reserves synchronously before the first await.
        const result = await runScript(`
            const results = await Promise.allSettled(
                Array.from({ length: 5 }, () => apify.actor.start({ actorId: 'apify/hello-world' })),
            );
            const started = results.filter((r) => r.status === 'fulfilled').length;
            const blocked = results.filter((r) => r.status === 'rejected').length;
            console.log('started=' + started + ' blocked=' + blocked);
        `, { inputFields: { maxActorRuns: 1 } });
        expect(result.pushedItem?.stdout).toBe('started=1 blocked=4');
    });

    it('maxTotalChargeUsd blocks a run once the execution budget is exhausted', async () => {
        const result = await runScript(`
            await apify.actor.start({ actorId: 'apify/hello-world', maxTotalChargeUsd: 5 });
            try {
                await apify.actor.start({ actorId: 'apify/hello-world' });
                console.log('LEAK: second run started');
            } catch (e) {
                console.log('blocked: ' + e.message);
            }
        `, { inputFields: { maxTotalChargeUsd: 5 } });
        expect(result.pushedItem?.stdout).toMatch(/^blocked: Blocked actor run: execution spending budget/);
    });

    it('defaultTimeoutSecs is applied to a run that does not specify its own timeoutSecs', async () => {
        const result = await runScript(`
            await apify.actor.start({ actorId: 'apify/hello-world' });
        `, { inputFields: { defaultTimeoutSecs: 42 } });
        const runCreateRequest = result.mockApi.requests.find((r) => r.method === 'POST' && r.path.includes('/acts/'));
        expect(runCreateRequest?.path).toMatch(/timeout=42/);
    });

    it('a rejected actor.start() releases its reservation (rollback actually fires)', async () => {
        // Regression test for createRun()'s try/catch rollback: without it, a run that fails
        // AFTER being synchronously reserved (bad actorId, API rejection, ...) would
        // permanently eat into maxActorRuns's budget for a run that never actually started.
        const result = await runScript(`
            let firstFailed = false;
            try {
                await apify.actor.start({ actorId: 'apify/hello-world' });
            } catch (e) {
                firstFailed = true;
            }
            // If the failed attempt above wasn't rolled back, this would be blocked too
            // (maxActorRuns: 1 already "spent" by the failed one).
            let secondSucceeded = false;
            try {
                await apify.actor.start({ actorId: 'apify/hello-world' });
                secondSucceeded = true;
            } catch (e) { /* would mean rollback didn't happen */ }
            console.log('firstFailed=' + firstFailed + ' secondSucceeded=' + secondSucceeded);
        `, {
            inputFields: { maxActorRuns: 1 },
            beforeStart: (mockApi) => mockApi.failNextRunCreate(400, JSON.stringify({ error: { message: 'bad actorId' } })),
        });
        expect(result.pushedItem?.stdout).toBe('firstFailed=true secondSucceeded=true');
    });

    it('actor.callAndGetItems does not double-count against maxActorRuns', async () => {
        const result = await runScript(`
            const { run, items } = await apify.actor.callAndGetItems({ actorId: 'apify/hello-world', limit: 5 });
            console.log('status=' + run.status + ' items=' + items.length);
        `, { inputFields: { maxActorRuns: 1 } });
        expect(result.pushedItem?.stdout).toMatch(/^status=/);
        expect(result.pushedItem?.stdout).not.toMatch(/Blocked actor run/);
    });
});
