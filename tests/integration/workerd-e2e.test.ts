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

    it('allows a fetch to an apify.com host', async () => {
        // The Actor's own internal-API mock isn't apify.com, so this only proves the guard's
        // ALLOW path is reachable (doesn't hang/throw before even trying) — the mock returns a
        // real HTTP response for any host once workerd's own DNS/connect succeeds, which for
        // a host that doesn't resolve (apify.com does, publicly) would time out instead of
        // throwing a "Blocked fetch" error. Asserting the ABSENCE of the guard's own blocked-
        // fetch error message is what distinguishes "guard let it through" from "guard blocked
        // it" here, without depending on live internet access from the test runner.
        const result = await runScript(`
            try {
                await fetch('https://apify.com/');
                console.log('reached apify.com (no guard rejection)');
            } catch (e) {
                console.log('error: ' + e.message);
            }
        `);
        expect(result.pushedItem?.stdout).not.toMatch(/Blocked fetch/);
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

    it('actor.callAndGetItems does not double-count against maxActorRuns', async () => {
        const result = await runScript(`
            const { run, items } = await apify.actor.callAndGetItems({ actorId: 'apify/hello-world', limit: 5 });
            console.log('status=' + run.status + ' items=' + items.length);
        `, { inputFields: { maxActorRuns: 1 } });
        expect(result.pushedItem?.stdout).toMatch(/^status=/);
        expect(result.pushedItem?.stdout).not.toMatch(/Blocked actor run/);
    });
});
