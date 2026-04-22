# Roadmap

Aligns with The Graph's 2026 Technical Roadmap ("Experimental JSON-RPC Data Service", Q3 2026).

---

## MVP ✅ Complete

The full working system is shipped. The goal was a minimal, stable payment loop — no dead weight.

**Payment infrastructure**
- `RPCDataService.sol` — register, startService, stopService, collect
- `paymentsDestination` — decouple payment recipient from operator key
- TAP receipt validation, RAV aggregation, on-chain `collect()`
- Integration tests against real Horizon payment contracts (mock staking only)
- EIP-712 cross-language compatibility tests (Solidity ↔ Rust)

**Gateway & routing**
- QoS routing — latency EMA (35%) + availability (35%) + block freshness (30%)
- Capability tiers — Standard / Archive / Debug; per-method tier detection
- Archive tier routing — inspects block parameters (hex numbers, `"earliest"`)
- `debug_*` / `trace_*` routing — per-chain capability map
- 10+ chains — Ethereum, Arbitrum, Optimism, Base, Polygon, BNB, Avalanche, zkSync Era, Linea, Scroll
- CU-weighted pricing — 1–20 CU per method
- Geographic routing — region-aware score bonus
- Cross-chain unified `/rpc` endpoint — chain via `X-Chain-Id` header
- JSON-RPC batch support
- WebSocket subscriptions — `eth_subscribe` / `eth_unsubscribe` proxied bidirectionally
- Per-IP rate limiting, Prometheus metrics

**Verification**
- Response attestation — provider signs every response with operator key; gateway verifies before forwarding
- Quorum consensus — deterministic methods sent to 3 providers; majority wins; disagreements logged

**Discovery & operations**
- RPC network subgraph — indexes RPCDataService events for dynamic provider discovery
- Indexer agent — TypeScript; automates provider lifecycle (register, startService, stopService)
- Consumer SDK — TypeScript; receipt signing, provider discovery, QoS-weighted selection
- Docker Compose full-stack deployment
- CI (Rust + Solidity)

---

## Not planned

These were considered and deliberately excluded.

| Feature | Why |
|---|---|
| `slash()` / fraud proofs | RPC responses have no canonical on-chain truth to slash against |
| Block header trust oracle | Dependency of slashing; dropped with it |
| EIP-1186 MPT proof verification | Same |
| Permissionless chain registration | Governance allowlist is sufficient |
| GRT issuance / rewards pool | Out of scope for this data service |

---

## Potential future work

- **TEE-based response verification** — cryptographic correctness via trusted execution; requires enclave hardware and a security audit
- **P2P SDK** — gateway-optional model; consumer connects directly to provider
- **Permissionless chain registration** — bond-based governance; deferred until the allowlist becomes a bottleneck
