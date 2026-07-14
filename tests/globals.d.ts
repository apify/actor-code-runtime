// Ambient declarations for probes in this directory. Each probe is compiled
// standalone by tsc, then submitted as the Actor's `code` input — entrypoint.sh
// splices that text into `export async function run(apify, console) { ... }`
// (see worker/usercode.d.ts), so `apify` and `console` are real function
// parameters at runtime, not globals. `declare global` here only satisfies the
// compiler for these standalone probe files; nothing in this file is emitted to JS.
import type { ApifyBinding } from '../worker/runner.js';

declare global {
    const apify: ApifyBinding;

    // Sandbox-isolation probe checks `typeof process`/`typeof require` — both are
    // genuinely absent at runtime (no nodejs_compat). `typeof` never throws on an
    // undeclared identifier, so declaring these here doesn't change that: a
    // `declare` emits no JS, so the runtime binding stays exactly as absent as
    // the probe expects.
    const process: unknown;
    const require: unknown;
}
