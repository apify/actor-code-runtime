using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
    services = [
        (name = "main", worker = .codeRuntime),
        # User fetches: guard.js allowlists hosts; workerd blocks private addresses.
        (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
        # Internal API binding; user code never receives this service.
        (name = "internalApi", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
    ],
    # entrypoint.sh substitutes __PORT__ before startup.
    sockets = [
        (
            name = "http",
            address = "127.0.0.1:__PORT__",
            http = (),
            service = "main",
        ),
    ],
);

# runner.js is the entrypoint; entrypoint.sh generates usercode.js.
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
        # Forward this run's verified origin to sub-runs.
        (name = "PARENT_ORIGIN", fromEnvironment = "APIFY_META_ORIGIN"),
        # Optional execution limits from Actor input.
        (name = "MAX_ACTOR_RUNS", fromEnvironment = "CODE_RUNTIME_MAX_ACTOR_RUNS"),
        (name = "MAX_TOTAL_CHARGE_USD", fromEnvironment = "CODE_RUNTIME_MAX_TOTAL_CHARGE_USD"),
        (name = "DEFAULT_TIMEOUT_SECS", fromEnvironment = "CODE_RUNTIME_DEFAULT_TIMEOUT_SECS"),
        # Internal API fetch, scoped to internalApi.
        (name = "INTERNAL_API", service = "internalApi"),
    ],
    globalOutbound = "internet",
    compatibilityDate = "2026-01-15",
    # No nodejs_compat: blocks Node egress and process.env token access.
);
