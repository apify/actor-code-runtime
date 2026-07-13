// usercode.js is generated at container startup by entrypoint.sh (gitignored, never
// checked in) — it wraps the run's `code` input in `export async function run(apify,
// console) { ...code... }`. This declaration lets `tsc` resolve runner.ts's import
// without the generated file present. The user's code is untyped JS text spliced
// into the function body, so `apify`/`console` stay `unknown` here on purpose —
// runner.ts's own ApifyBinding/ConsoleLike types describe what's actually passed in.
export function run(apify: unknown, consoleLike: unknown): Promise<void>;
