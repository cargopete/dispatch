# Multi-stage build for dispatch-service and dispatch-gateway.
# Target a specific stage with --target:
#   docker build --target service -t dispatch-service .
#   docker build --target gateway -t dispatch-gateway .
# docker-compose handles this automatically via the `target:` key.

# ── Builder ─────────────────────────────────────────────────────────────────
FROM rust:slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 1. Copy manifest files only — lets Docker cache the dependency compile layer.
COPY Cargo.toml Cargo.lock ./
COPY crates/dispatch-tap/Cargo.toml     crates/dispatch-tap/
COPY crates/dispatch-service/Cargo.toml crates/dispatch-service/
COPY crates/dispatch-gateway/Cargo.toml crates/dispatch-gateway/

# 2. Stub source files so `cargo build` can resolve and compile all deps.
RUN mkdir -p crates/dispatch-tap/src crates/dispatch-service/src crates/dispatch-gateway/src \
    && echo '' > crates/dispatch-tap/src/lib.rs \
    && echo 'fn main(){}' > crates/dispatch-service/src/main.rs \
    && echo 'fn main(){}' > crates/dispatch-gateway/src/main.rs

RUN cargo build --release --bin dispatch-service --bin dispatch-gateway 2>/dev/null; exit 0

# 3. Copy real source and rebuild (only workspace crates recompile).
COPY crates/ crates/
RUN touch crates/dispatch-tap/src/lib.rs \
          crates/dispatch-service/src/main.rs \
          crates/dispatch-gateway/src/main.rs \
    && cargo build --release --bin dispatch-service --bin dispatch-gateway

# ── Service runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS service

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/dispatch-service /usr/local/bin/dispatch-service

EXPOSE 7700
ENV RUST_LOG=info

ENTRYPOINT ["dispatch-service"]

# ── Gateway runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS gateway

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/dispatch-gateway /usr/local/bin/dispatch-gateway

EXPOSE 8080
ENV RUST_LOG=info

ENTRYPOINT ["dispatch-gateway"]
