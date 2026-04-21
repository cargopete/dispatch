# Roadmap

Aligns with The Graph's 2026 Technical Roadmap ("Experimental JSON-RPC Data Service", Q3 2026).

---

## Phase 1 — MVP ✅

- `RPCDataService.sol` — register, startService, stopService, collect
- `paymentsDestination` — decouple payment recipient from operator key
- `dispatch-service` — JSON-RPC proxy with TAP receipt validation
- `dispatch-gateway` — QoS routing, TAP receipt signing, metrics
- RPC attestation scheme
- RPC network subgraph
- Integration tests (real Horizon payment contracts, mock staking only)
- EIP-712 cross-language compatibility tests (Solidity ↔ Rust)
- Docker Compose full-stack deployment
- CI (Rust + Solidity)

## Phase 2 — Production Foundation ✅

- Quorum consensus for `eth_call` and `eth_getLogs`
- 10+ chains
- CU-weighted pricing (1–20 CU per method)
- QoS scoring with latency, availability, freshness
- Geographic routing
- Capability tiers (Standard / Archive / Debug)
- Dynamic provider discovery via subgraph
- Per-IP rate limiting
- Prometheus metrics
- JSON-RPC batch support

## Phase 3 — Full Feature Parity ✅

- WebSocket subscriptions (`eth_subscribe` / `eth_unsubscribe`)
- Archive tier routing (hex block numbers, `"earliest"`)
- `debug_*` / `trace_*` routing per chain capability

## Phase 4 — Production Readiness ✅

- Cross-chain unified `/rpc` endpoint with `X-Chain-Id` header
- Permissionless chain registration (100k GRT bond, governance approval)
- GRT issuance groundwork
- Indexer agent (`@dispatch/indexer-agent`)
- Subgraph schema v2

## Phase 5 — Consumer SDK & Rewards ✅

- Consumer SDK (`@dispatch/consumer-sdk`)
- Rewards pool (`depositRewardsPool`, `claimRewards`)
- Dynamic thawing period governance setter

---

## Deployment ✅

- Contract deployed on Arbitrum One
- Subgraph live on The Graph Studio
- npm packages published
- e2e tests passing
- Security review done (2 mediums fixed, redeployed)

---

## Deferred

- **TEE-based response verification** — requires enclave hardware and security audit (~6 months minimum)
- **P2P SDK** — gateway-optional payment model; rethinks trust assumptions end-to-end
