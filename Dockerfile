# Two-stage build: drop the Node runtime entirely. workerd is a standalone
# glibc binary; only libc + libm are needed at runtime (verified via `ldd`).
#
# Stage 1: pull the workerd binary + compile worker/*.ts -> worker/*.js, via a Node
# base. Node already runs here to resolve workerd's binary path, so compiling
# TypeScript is one more RUN line, not a new toolchain. pnpm keeps workerd in the
# virtual store (not hoisted), so resolve the path through `require('workerd')`.
FROM node:24-bookworm-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY worker/ ./worker/
# --ignore-scripts skips workerd's postinstall (a binary-download fallback we
# don't need — the binary ships in the @cloudflare/workerd-linux-64 optional dep)
# and avoids pnpm's hard error on unapproved dependency build scripts. Full
# (non --prod) install: typescript is a devDependency, needed by `pnpm build` below.
RUN corepack enable \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm run build \
    && BIN="$(node -e "process.stdout.write(require('workerd').default)")" \
    && cp "$BIN" /workerd \
    && chmod +x /workerd

# Stage 2: minimal runtime — debian + ca-certificates + the workerd binary + the
# compiled JS. No Node, no TypeScript, no npm packages in this image.
FROM debian:bookworm-slim

# curl: loopback HTTP client + Actor-input fetch; jq: extract `code` from the input JSON.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workerd /usr/local/bin/workerd

WORKDIR /app
COPY worker/entrypoint.sh worker/config.capnp ./worker/
COPY --from=builder /build/worker/runner.js /build/worker/guard.js ./worker/

ENTRYPOINT ["sh", "/app/worker/entrypoint.sh"]
