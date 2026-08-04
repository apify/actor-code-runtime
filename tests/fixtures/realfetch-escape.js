// Capability-theft regression: escaped module code cannot import an unrestricted fetch.
// The unbalanced brace intentionally escapes the generated run() wrapper.
// Genuine top-level await delays runner.ts evaluation until this probe runs.
}
globalThis.__stolenRealFetch = (await import('./guard.js')).claimRealFetch();
;{
