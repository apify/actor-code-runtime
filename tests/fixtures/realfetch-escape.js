// Regression probe for the guard.js capability-theft bug found in PR #1 review
// (2026-07-21, and again 2026-08-01 against the first attempted fix):
// https://github.com/apify/actor-code-runtime/pull/1#discussion_r3707244830
//
// entrypoint.sh splices `code` verbatim (no escaping) into
// `export async function run(apify, console) { <code> }`. The bare `}` right
// after this comment block closes that function early -- deliberately, to
// reproduce the escape -- so `run` becomes a harmless no-op (nothing is left
// in its body once the comments end) and everything after runs as ordinary
// MODULE-SCOPE code in usercode.js: workerd evaluates that unconditionally,
// before this worker ever calls runner.ts's request handler.
//
// The first fix attempt (guard.ts's requestHandlingStarted gate) still
// exported a setter (markRequestHandlingStarted) and getter (claimRealFetch)
// that escaped code could call directly, since usercode.js shares guard.js's
// module graph -- any export is equally reachable from both. This probe's
// payload (below) calls exactly that: `claimRealFetch()`, expecting it back
// as a callable, unrestricted fetch function.
//
// The actual fix (see guard.ts/runner.ts/config.capnp) removes that export
// surface entirely: this worker's own internal-API access is now a workerd
// env binding (env.INTERNAL_API), which only ever reaches the genuinely-
// dispatched fetch(request, env) call -- nothing at module-evaluation time
// receives a reference to it, exported or otherwise. guard.js now only
// exports pure allowlist helpers (isAllowedHost, validateUrl, nextRedirectInit,
// guardedFetch -- see tests/unit/guard.test.ts's "never exports a raw/
// unrestricted fetch capability" regression test for that invariant directly).
//
// So `claimRealFetch` no longer exists on the imported module: this line now
// throws a plain TypeError ("claimRealFetch is not a function") during module
// evaluation -- an uncaught exception at that point crashes workerd's own
// startup, which entrypoint.sh's push_compile_failure() already detects and
// reports as a normal, SUCCEEDED Actor run with a "Failed to compile: ..."
// diagnostic item (exitCode 1) -- not a hard Actor run failure, and no
// capability is exposed either way. See test.sh for how this is asserted.
//
// Not valid JS on its own (it opens with an unbalanced `}`) -- intentionally,
// same shape as the reported PoC. Not TypeScript, not compiled, not
// typechecked (lives under tests/fixtures/, outside tsconfig's `include` and
// outside the `tests/*.js` build-artifact glob): see test.sh, which pushes
// this file's raw content directly as the `code` input.
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
