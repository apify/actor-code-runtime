// Ambient types for probes compiled into run(apify, console) bodies.
import type { ApifyBinding } from '../worker/runner.js';

declare global {
    const apify: ApifyBinding;

    // Declared for typeof checks; workerd has no process or require globals.
    const process: unknown;
    const require: unknown;
}
