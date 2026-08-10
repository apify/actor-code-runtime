# Build with Node; run with only workerd and required utilities.
FROM node:24-bookworm-slim AS builder
WORKDIR /build
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY worker/ ./worker/
# The binary ships in an optional dependency; compile worker files directly.
RUN corepack enable \
    && pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm exec tsc -p tsconfig.json \
    && BIN="$(node -e "process.stdout.write(require('workerd').default)")" \
    && cp "$BIN" /workerd \
    && chmod +x /workerd

# Minimal runtime image: workerd, compiled JS, and certificates.
FROM debian:bookworm-slim

# curl fetches input; jq extracts user code.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workerd /usr/local/bin/workerd

WORKDIR /app
COPY worker/entrypoint.sh worker/config.capnp ./worker/
COPY --from=builder /build/worker/runner.js /build/worker/guard.js ./worker/

ENTRYPOINT ["sh", "/app/worker/entrypoint.sh"]
