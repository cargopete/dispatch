# Multi-stage build for drpc-service and drpc-gateway.
# Target a specific stage with --target:
#   docker build --target service -t drpc-service .
#   docker build --target gateway -t drpc-gateway .
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
COPY crates/drpc-tap/Cargo.toml     crates/drpc-tap/
COPY crates/drpc-service/Cargo.toml crates/drpc-service/
COPY crates/drpc-gateway/Cargo.toml crates/drpc-gateway/

# 2. Stub source files so `cargo build` can resolve and compile all deps.
RUN mkdir -p crates/drpc-tap/src crates/drpc-service/src crates/drpc-gateway/src \
    && echo '' > crates/drpc-tap/src/lib.rs \
    && echo 'fn main(){}' > crates/drpc-service/src/main.rs \
    && echo 'fn main(){}' > crates/drpc-gateway/src/main.rs

RUN cargo build --release --bin drpc-service --bin drpc-gateway 2>/dev/null; exit 0

# 3. Copy real source and rebuild (only workspace crates recompile).
COPY crates/ crates/
RUN touch crates/drpc-tap/src/lib.rs \
          crates/drpc-service/src/main.rs \
          crates/drpc-gateway/src/main.rs \
    && cargo build --release --bin drpc-service --bin drpc-gateway

# ── Service runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS service

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/drpc-service /usr/local/bin/drpc-service

EXPOSE 7700
ENV RUST_LOG=info

ENTRYPOINT ["drpc-service"]

# ── Gateway runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS gateway

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/drpc-gateway /usr/local/bin/drpc-gateway

EXPOSE 8080
ENV RUST_LOG=info

ENTRYPOINT ["drpc-gateway"]
