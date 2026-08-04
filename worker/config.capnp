using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
    services = [
        (name = "main", worker = .codeRuntime),
        # Ambient outbound for the sandboxed script's own fetch() calls (guard.js allowlists
        # the hostname on top of this; this is a second, independent layer — restricted to
        # "public" so that even a JS-level guard bug can't reach private/link-local addresses
        # (e.g. cloud metadata) via a stolen or unwrapped fetch reference).
        (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
        # This worker's own calls to the platform-internal Apify API (bound as env.INTERNAL_API
        # in runner.ts, not exposed to the ambient/guarded fetch above). api.apify.com may
        # resolve to a private address inside the platform network, hence the broader allowlist
        # here — this service is never reachable from usercode.js: it's only ever passed as
        # part of `env`, which workerd hands solely to the genuinely-dispatched
        # `fetch(request, env)` call, never to any module-scope code. See runner.ts/guard.ts.
        (name = "internalApi", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
    ],
    # __PORT__ is substituted by entrypoint.sh from its own $PORT before workerd
    # starts — single source of truth, see entrypoint.sh.
    sockets = [
        (
            name = "http",
            address = "127.0.0.1:__PORT__",
            http = (),
            service = "main",
        ),
    ],
);

# runner.js is the entrypoint module; usercode.js is generated at container
# start by entrypoint.sh (the Actor input wrapped as `export async function run`).
const codeRuntime :Workerd.Worker = (
    modules = [
        (name = "runner.js", esModule = embed "runner.js"),
        (name = "guard.js", esModule = embed "guard.js"),
        (name = "usercode.js", esModule = embed "usercode.js"),
    ],
    bindings = [
        (name = "APIFY_TOKEN", fromEnvironment = "APIFY_TOKEN"),
        (name = "DEFAULT_DATASET_ID", fromEnvironment = "ACTOR_DEFAULT_DATASET_ID"),
        (name = "DEFAULT_DATASET_ID_LEGACY", fromEnvironment = "APIFY_DEFAULT_DATASET_ID"),
        (name = "API_BASE_URL", fromEnvironment = "APIFY_API_BASE_URL"),
        # This run's own meta.origin (e.g. "MCP" when apify-mcp-server started it),
        # forwarded to sub-runs this script starts — see PARENT_ORIGIN in runner.ts.
        (name = "PARENT_ORIGIN", fromEnvironment = "APIFY_META_ORIGIN"),
        # Execution-level safeguards on Actor runs this script starts (all optional —
        # see runner.ts's Limits and docs/API.md's "Execution limits"). Sourced from the
        # Actor's own input fields, exported as env vars by entrypoint.sh.
        (name = "MAX_ACTOR_RUNS", fromEnvironment = "CODE_RUNTIME_MAX_ACTOR_RUNS"),
        (name = "MAX_TOTAL_CHARGE_USD", fromEnvironment = "CODE_RUNTIME_MAX_TOTAL_CHARGE_USD"),
        (name = "DEFAULT_TIMEOUT_SECS", fromEnvironment = "CODE_RUNTIME_DEFAULT_TIMEOUT_SECS"),
        # Unrestricted fetch to the platform-internal API, scoped to its own outbound network
        # service above — see this file's "internalApi" service and runner.ts/guard.ts.
        (name = "INTERNAL_API", service = "internalApi"),
    ],
    globalOutbound = "internet",
    compatibilityDate = "2026-01-15",
    # No nodejs_compat: user code runs with web-standard APIs only. This is a
    # security boundary, not a convenience toggle — the flag would expose node:net
    # (a raw-socket egress path that bypasses guard.js's *.apify.com fetch allowlist)
    # and process.env (which holds the run's APIFY_TOKEN). runner.js and guard.js use
    # only web-standard APIs (fetch/URL/Response/Uint8Array), so they need nothing here.
);
