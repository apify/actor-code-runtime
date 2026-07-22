// Regression probe for the realFetch claim-ordering bug found in PR #1's
// review (2026-07-21):
// https://github.com/apify/actor-code-runtime/pull/1#issuecomment-5037390847
//
// entrypoint.sh splices `code` verbatim (no escaping) into
// `export async function run(apify, console) { <code> }`. The bare `}` right
// after this comment block closes that function early -- deliberately, to
// reproduce the escape -- so `run` becomes a harmless no-op (nothing is left
// in its body once the comments end) and everything after runs as ordinary
// MODULE-SCOPE code in usercode.js: workerd evaluates that unconditionally,
// before this worker ever calls runner.ts's request handler. That used to be
// enough to `await import('./guard.js')` and call claimRealFetch() directly,
// stealing the unrestricted, un-allowlisted fetch before runner.ts's own
// claim (previously made at runner.ts's own module top level) ever ran --
// which made THAT claim get null, throw, and crash the whole Actor run
// (self-DoS; the real exploit payoff for an attacker would be using the
// stolen fetch directly, not reported here).
//
// Not valid JS on its own (it opens with an unbalanced `}`) -- intentionally,
// same shape as the reported PoC. Not TypeScript, not compiled, not
// typechecked (lives under tests/fixtures/, outside tsconfig's `include` and
// outside the `tests/*.js` build-artifact glob): see test.sh, which pushes
// this file's raw content directly as the `code` input.
//
// Expected result with the fix (guard.ts's requestHandlingStarted gate):
// claimRealFetch() called from module scope returns null without consuming
// the resource, so nothing crashes -- this Actor run completes normally
// (exitCode 0, "Script completed"), same as any run of an empty script.
// Before the fix: this run FAILS outright (workerd crashes during module
// evaluation; entrypoint.sh can't tell that apart from a real infra failure
// and fails the whole Actor run). test.sh asserts on `apify call`'s own exit
// status, not a printed sentinel -- this probe's `run` body never executes
// any of its own code, so it has no captured console to report through.
//
// Must be genuine top-level await, not an async IIFE: a module containing
// top-level await defers the evaluation of modules that depend on it (here,
// runner.ts) until that await settles (see MDN/TC39 "Top-level await",
// Asynchronous Module Evaluation) -- an IIFE's internal await does not carry
// that guarantee, so it would not reliably win the race this probe exists to
// exercise.
}
globalThis.__stolenRealFetch = (await import('./guard.js')).claimRealFetch();
;{
