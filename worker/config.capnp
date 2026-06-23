using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
    services = [
        (name = "main", worker = .codeRuntime),
        # Outbound for fetch(). Apify's api.apify.com may resolve to a private
        # address inside the platform network, so allow private/local too.
        # tlsOptions enables HTTPS egress (trust workerd's built-in CA set);
        # the hostname allowlist is enforced by guard.js, not here.
        (name = "internet", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
    ],
    sockets = [
        (
            name = "http",
            address = "127.0.0.1:8787",
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
    ],
    globalOutbound = "internet",
    compatibilityDate = "2026-01-15",
    compatibilityFlags = ["nodejs_compat"],
);
