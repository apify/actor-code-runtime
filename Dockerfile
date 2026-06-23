# Two-stage build: drop the Node runtime entirely. workerd is a standalone
# glibc binary; only libc + libm are needed at runtime (verified via `ldd`).
#
# Stage 1: pull the workerd binary via a Node base. pnpm keeps it in the virtual
# store (not hoisted), so resolve the path through `require('workerd')`.
FROM node:24-bookworm-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts skips workerd's postinstall (a binary-download fallback we
# don't need — the binary ships in the @cloudflare/workerd-linux-64 optional dep)
# and avoids pnpm's hard error on unapproved dependency build scripts.
RUN corepack enable \
    && pnpm install --prod --frozen-lockfile --ignore-scripts \
    && BIN="$(node -e "process.stdout.write(require('workerd').default)")" \
    && cp "$BIN" /workerd \
    && chmod +x /workerd

# Stage 2: minimal runtime — debian + ca-certificates + the workerd binary.
FROM debian:bookworm-slim

# curl: loopback HTTP client + Actor-input fetch; jq: extract `code` from the input JSON.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workerd /usr/local/bin/workerd

WORKDIR /app
COPY worker/ ./worker/

ENTRYPOINT ["sh", "/app/worker/entrypoint.sh"]
