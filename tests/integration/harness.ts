// Integration harness for real workerd, module wiring, and env bindings.
// Run `pnpm build` first.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const WORKERD_STARTUP_TIMEOUT_MS = 5_000;
const WORKERD_STARTUP_POLL_INTERVAL_MS = 100;
const WORKERD_EXIT_TIMEOUT_MS = 2_000;

function workerdBinaryPath(): string {
    // Match Dockerfile's workerd binary resolution.
    const require = createRequire(import.meta.url);
    return require('workerd').default;
}

// Ask the OS for a free port instead of guessing.
async function reserveEphemeralPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('failed to reserve an ephemeral port');
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return address.port;
}

// Minimal API stand-in for end-to-end runtime behavior.
export interface MockApi {
    server: Server;
    port: number;
    requests: { method: string; path: string; body: string }[];
    /** Fail the next run-create request once. */
    failNextRunCreate: (status: number, body: string) => void;
    close: () => Promise<void>;
}

export async function startMockApi(): Promise<MockApi> {
    const requests: MockApi['requests'] = [];
    let pendingRunCreateFailure: { status: number; body: string } | null = null;
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            // Match paths without query strings.
            const pathname = new URL(req.url ?? '/', 'http://mock-api.internal').pathname;
            requests.push({ method: req.method ?? '', path: req.url ?? '', body });
            res.setHeader('content-type', 'application/json');
            if (req.method === 'POST' && pathname.startsWith('/v2/datasets/') && pathname.endsWith('/items')) {
                res.writeHead(201);
                res.end('{}');
            } else if (req.method === 'POST' && pathname.startsWith('/v2/acts/') && pathname.endsWith('/runs')) {
                if (pendingRunCreateFailure) {
                    const { status, body: failureBody } = pendingRunCreateFailure;
                    pendingRunCreateFailure = null;
                    res.writeHead(status);
                    res.end(failureBody);
                    return;
                }
                res.writeHead(201);
                res.end(JSON.stringify({ data: { id: `run-${requests.length}`, status: 'READY', defaultDatasetId: 'ds1' } }));
            } else if (req.method === 'GET' && pathname.startsWith('/v2/datasets/') && pathname.endsWith('/items')) {
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
        failNextRunCreate: (status, body) => { pendingRunCreateFailure = { status, body }; },
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

export interface RunOptions {
    /** Input fields beyond `code`. */
    inputFields?: Record<string, unknown>;
    /** Configure the mock before workerd starts. */
    beforeStart?: (mockApi: MockApi) => void;
}

export interface RunResult {
    /** Pushed output, or null if output was never written. */
    pushedItem: Record<string, unknown> | null;
    /** Whether workerd served /health. */
    startedCleanly: boolean;
    /** Workerd stderr. */
    stderr: string;
    mockApi: MockApi;
}

// Boot workerd with wrapped code, run once, and release all resources.
export async function runScript(code: string, options: RunOptions = {}): Promise<RunResult> {
    const mockApi = await startMockApi();
    try {
        options.beforeStart?.(mockApi);
        const workDir = mkdtempSync(join(tmpdir(), 'code-runtime-it-'));
        try {
            return await runInWorkDir(code, options, mockApi, workDir);
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    } finally {
        await mockApi.close();
    }
}

async function runInWorkDir(code: string, options: RunOptions, mockApi: MockApi, workDir: string): Promise<RunResult> {
    const repoRoot = join(import.meta.dirname, '..', '..');

    cpSync(join(repoRoot, 'worker', 'runner.js'), join(workDir, 'runner.js'));
    cpSync(join(repoRoot, 'worker', 'guard.js'), join(workDir, 'guard.js'));
    writeFileSync(join(workDir, 'usercode.js'), `export async function run(apify, console) {\n${code}\n}\n`);

    const port = await reserveEphemeralPort();
    // Replace both config placeholders.
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
    try {
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        const deadline = Date.now() + WORKERD_STARTUP_TIMEOUT_MS;
        let startedCleanly = false;
        while (Date.now() < deadline) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}/health`);
                if (res.ok) { startedCleanly = true; break; }
            } catch { /* retry until timeout */ }
            if (child.exitCode !== null) break;
            await new Promise((resolve) => setTimeout(resolve, WORKERD_STARTUP_POLL_INTERVAL_MS));
        }

        if (startedCleanly) {
            try {
                await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST' });
            } catch { /* assert worker failures from returned state */ }
        }

        const pushRequest = mockApi.requests.find((r) => {
            const pathname = new URL(r.path, 'http://mock-api.internal').pathname;
            return r.method === 'POST' && pathname === '/v2/datasets/ds-default/items';
        });
        return {
            pushedItem: pushRequest ? JSON.parse(pushRequest.body) : null,
            startedCleanly,
            stderr,
            mockApi,
        };
    } finally {
        child.kill();
        // Ensure slow workerd processes cannot hold ports between tests.
        if (child.exitCode === null) {
            await Promise.race([
                new Promise<void>((resolve) => child.once('exit', () => resolve())),
                new Promise<void>((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, WORKERD_EXIT_TIMEOUT_MS)),
            ]);
        }
    }
}
