// Shared harness for integration tests that boot a REAL workerd instance against the actual
// compiled worker/runner.js + worker/guard.js (not a mock, not just the pure functions vitest's
// unit suite exercises in isolation). This is what closes the gap unit tests structurally
// cannot: whether guard.js is actually wired into the module graph, whether env.INTERNAL_API
// dispatch actually works, and whether the execution-limit safeguards actually fire end to end.
// Needs `pnpm build` to have produced worker/runner.js + worker/guard.js first (the "build"
// step in .github/workflows/typecheck.yml's integration job — see there).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const WORKERD_STARTUP_TIMEOUT_MS = 5_000;
const WORKERD_STARTUP_POLL_INTERVAL_MS = 100;

function workerdBinaryPath(): string {
    // Same resolution Dockerfile's builder stage uses: workerd ships its binary path via the
    // package's own `default` export, one level of indirection because the platform-specific
    // binary lives in an optional dependency (@cloudflare/workerd-linux-64 etc). `workerd`
    // itself is a CommonJS package with no ESM entry point, hence createRequire rather than a
    // static import.
    const require = createRequire(import.meta.url);
    return require('workerd').default;
}

// A minimal stand-in for the platform-internal Apify API — just enough to make
// actor.start/dataset operations/pushOutput resolve, so a script's real behavior (including
// safeguard rejections, which happen before any HTTP call) is observable end to end.
export interface MockApi {
    server: Server;
    port: number;
    requests: { method: string; path: string; body: string }[];
    close: () => Promise<void>;
}

export async function startMockApi(): Promise<MockApi> {
    const requests: MockApi['requests'] = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            requests.push({ method: req.method ?? '', path: req.url ?? '', body });
            res.setHeader('content-type', 'application/json');
            if (req.method === 'POST' && req.url?.includes('/datasets/') && req.url.endsWith('/items')) {
                res.writeHead(201);
                res.end('{}');
            } else if (req.method === 'POST' && req.url?.includes('/acts/') && req.url.endsWith('/runs')) {
                res.writeHead(201);
                res.end(JSON.stringify({ data: { id: `run-${requests.length}`, status: 'READY', defaultDatasetId: 'ds1' } }));
            } else if (req.method === 'GET' && req.url?.includes('/datasets/') && req.url.includes('/items')) {
                res.writeHead(200);
                res.end('[]');
            } else {
                res.writeHead(200);
                res.end(JSON.stringify({ data: { id: 'x', status: 'SUCCEEDED' } }));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock API failed to bind a port');
    return {
        server,
        port: address.port,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

export interface RunOptions {
    /** Actor input fields beyond `code`, e.g. { maxActorRuns: 1 } — mirrors what entrypoint.sh reads. */
    inputFields?: Record<string, unknown>;
}

export interface RunResult {
    /** The pushed dataset item, if pushOutput ran (empty object if the worker crashed at startup). */
    pushedItem: Record<string, unknown> | null;
    /** True if workerd itself started and served /health before we tore it down. */
    startedCleanly: boolean;
    /** Raw stderr from the workerd process (useful for asserting startup-crash diagnostics). */
    stderr: string;
    mockApi: MockApi;
}

// Boots a fresh workerd instance with `code` wrapped exactly like entrypoint.sh does, against a
// fresh MockApi standing in for the internal Apify API, sends one /run request, and tears both
// down. Mirrors entrypoint.sh's own env var wiring (CODE_RUNTIME_* for the execution limits)
// rather than reinventing a second convention.
export async function runScript(code: string, options: RunOptions = {}): Promise<RunResult> {
    const mockApi = await startMockApi();
    const workDir = mkdtempSync(join(tmpdir(), 'code-runtime-it-'));
    const repoRoot = join(import.meta.dirname, '..', '..');

    cpSync(join(repoRoot, 'worker', 'runner.js'), join(workDir, 'runner.js'));
    cpSync(join(repoRoot, 'worker', 'guard.js'), join(workDir, 'guard.js'));
    writeFileSync(join(workDir, 'usercode.js'), `export async function run(apify, console) {\n${code}\n}\n`);

    const port = 10_000 + Math.floor(Math.random() * 10_000);
    // config.capnp's __PORT__ placeholder appears twice (once in a comment, once in the real
    // socket address) — replaceAll, not replace, or the comment's occurrence "wins" and the
    // real one is left as the literal string "__PORT__" (workerd then fails DNS-resolving it
    // as a port/service name).
    const configTemplate = readFileSync(join(repoRoot, 'worker', 'config.capnp'), 'utf8');
    writeFileSync(join(workDir, 'config.capnp'), configTemplate.replaceAll('__PORT__', String(port)));

    const inputFields = options.inputFields ?? {};
    const child: ChildProcess = spawn(workerdBinaryPath(), ['serve', '--experimental', join(workDir, 'config.capnp')], {
        env: {
            ...process.env,
            APIFY_TOKEN: 'fake-token',
            ACTOR_DEFAULT_DATASET_ID: 'ds-default',
            APIFY_API_BASE_URL: `http://127.0.0.1:${mockApi.port}`,
            APIFY_META_ORIGIN: '',
            CODE_RUNTIME_MAX_ACTOR_RUNS: inputFields.maxActorRuns !== undefined ? String(inputFields.maxActorRuns) : '',
            CODE_RUNTIME_MAX_TOTAL_CHARGE_USD: inputFields.maxTotalChargeUsd !== undefined ? String(inputFields.maxTotalChargeUsd) : '',
            CODE_RUNTIME_DEFAULT_TIMEOUT_SECS: inputFields.defaultTimeoutSecs !== undefined ? String(inputFields.defaultTimeoutSecs) : '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    const deadline = Date.now() + WORKERD_STARTUP_TIMEOUT_MS;
    let startedCleanly = false;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) { startedCleanly = true; break; }
        } catch { /* not up yet, or crashed — keep polling until the deadline */ }
        if (child.exitCode !== null) break; // crashed at startup, no point polling further
        await new Promise((resolve) => setTimeout(resolve, WORKERD_STARTUP_POLL_INTERVAL_MS));
    }

    if (startedCleanly) {
        try {
            await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST' });
        } catch { /* the /run call itself may crash the worker — that's a result to assert on, not a harness failure */ }
    }

    child.kill();
    await mockApi.close();

    const pushRequest = mockApi.requests.find((r) => r.method === 'POST' && r.path.endsWith('/items') && r.path.includes('ds-default'));
    return {
        pushedItem: pushRequest ? JSON.parse(pushRequest.body) : null,
        startedCleanly,
        stderr,
        mockApi,
    };
}
