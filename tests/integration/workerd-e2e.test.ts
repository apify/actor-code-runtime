// End-to-end tests for real workerd, module wiring, and env bindings.
// Run `pnpm build` first; these tests spawn real processes and ports.
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
        // Module-scope capability-theft regression.
        const result = await runScript(`
}
globalThis.__stolenRealFetch = (await import('./guard.js')).claimRealFetch();
;{
        `);
        expect(result.startedCleanly).toBe(false);
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
        const result = await runScript(`
            let firstFailed = false;
            try {
                await apify.actor.start({ actorId: 'apify/hello-world' });
            } catch (e) {
                firstFailed = true;
            }
            let secondSucceeded = false;
            try {
                await apify.actor.start({ actorId: 'apify/hello-world' });
                secondSucceeded = true;
            } catch (e) { /* expected only if rollback fails */ }
            console.log('firstFailed=' + firstFailed + ' secondSucceeded=' + secondSucceeded);
        `, {
            inputFields: { maxActorRuns: 1 },
            beforeStart: (mockApi) => mockApi.failNextRunCreate(400, JSON.stringify({ error: { message: 'bad actorId' } })),
        });
        expect(result.pushedItem?.stdout).toBe('firstFailed=true secondSucceeded=true');
    });

    it('rejects a non-finite/non-positive maxTotalChargeUsd before it touches the budget', async () => {
        const result = await runScript(`
            try {
                await apify.actor.start({ actorId: 'apify/hello-world', maxTotalChargeUsd: NaN });
                console.log('LEAK: did not throw');
            } catch (e) {
                console.log('error: ' + e.message);
            }
        `);
        expect(result.pushedItem?.stdout).toMatch(/^error: Invalid maxTotalChargeUsd/);
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
