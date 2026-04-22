# Dispatch Data Service — Roadmap

Aligns with The Graph's 2026 Technical Roadmap ("Experimental JSON-RPC Data Service", Q3 2026).

---

## Phase 1 — MVP ✅ Complete

**Goal:** A minimal, stable, fully working payment loop. Every line of code earns its place.

- [x] `RPCDataService.sol` — register, startService, stopService, collect
- [x] `paymentsDestination` — decouple payment recipient from operator key
- [x] Explicit `QueryFee` enforcement in `collect()` — revert on other payment types
- [x] `dispatch-service` (Rust) — JSON-RPC reverse proxy with TAP receipt validation
- [x] `dispatch-gateway` (Rust) — QoS-aware routing, TAP receipt signing, metrics
- [x] Response attestation — provider signs each response with operator key; gateway verifies
- [x] Quorum consensus — deterministic methods sent to 3 providers; majority result wins; disagreements logged
- [x] RPC network subgraph — indexes RPCDataService events for provider discovery
- [x] 10+ chains — Ethereum, Arbitrum, Optimism, Base, Polygon, BNB, Avalanche, zkSync Era, Linea, Scroll
- [x] CU-weighted pricing — per-method compute units (1–20 CU)
- [x] QoS scoring — latency EMA (35%) + availability (35%) + block freshness (30%)
- [x] Geographic routing — region-aware score bonus
- [x] Capability tiers — Standard / Archive / Debug; gateway filters by required tier per method
- [x] Archive tier routing — inspects block parameters (hex block numbers, `"earliest"`, JSON integers)
- [x] `debug_*` / `trace_*` routing — per-chain capability map
- [x] Dynamic provider discovery — subgraph-driven registry with configurable poll interval
- [x] Per-IP rate limiting — token-bucket via `governor`
- [x] Prometheus metrics — `dispatch_requests_total`, `dispatch_request_duration_seconds`
- [x] JSON-RPC batch support — concurrent dispatch, per-item error isolation
- [x] WebSocket subscriptions — `eth_subscribe` / `eth_unsubscribe` proxied bidirectionally
- [x] Cross-chain unified `/rpc` endpoint — chain via `X-Chain-Id` header
- [x] Indexer agent (`indexer-agent/`) — TypeScript; automates register/startService/stopService lifecycle
- [x] Consumer SDK (`consumer-sdk/`) — TypeScript; receipt signing, provider discovery, QoS selection
- [x] Integration tests — mock HorizonStaking only; real GraphTallyCollector / PaymentsEscrow / GraphPayments
- [x] EIP-712 cross-language compatibility tests (Solidity ↔ Rust)
- [x] Docker Compose full-stack deployment
- [x] GitHub Actions CI (Rust fmt/clippy/test + Solidity fmt/test)

---

## Deliberately out of scope

The following were explored and removed. They are not planned.

| Feature | Reason removed |
|---|---|
| `slash()` / fraud proofs | RPC responses have no canonical on-chain truth to slash against |
| Block header trust oracle | Required for slashing; dropped with it |
| EIP-1186 MPT proof verification | Same dependency on slashing infrastructure |
| Permissionless chain registration (`proposeChain`) | Governance allowlist is sufficient; complexity not warranted |
| GRT issuance / rewards pool | Protocol-level decision; out of scope for this data service |

---

## Potential future work

These are possibilities, not commitments.

- **TEE-based response verification** — cryptographic correctness guarantees via trusted execution; requires enclave hardware and a security audit
- **P2P SDK** — gateway-optional model; consumer connects directly to provider without a centralised gateway
- **Permissionless chain registration** — bond-based governance; deferred until the allowlist becomes a bottleneck
