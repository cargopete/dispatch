# dRPC Data Service — Roadmap

Aligns with The Graph's 2026 Technical Roadmap ("Experimental JSON-RPC Data Service", Q3 2026).

---

## Phase 1 — MVP ✅ Complete

**Goal:** Prove the architecture. Minimal viable service on Horizon.

- [x] `RPCDataService.sol` — register, startService, stopService, collect, slash
- [x] `paymentsDestination` — decouple payment recipient from operator key
- [x] Explicit `QueryFee` enforcement in `collect()` — revert on other payment types
- [x] `drpc-service` (Rust) — JSON-RPC reverse proxy with TAP receipt validation
- [x] `drpc-gateway` (Rust) — QoS-aware routing, TAP receipt signing, metrics
- [x] RPC attestation scheme — `keccak256(method || params || response || blockHash)` signed by indexer
- [x] RPC network subgraph — indexes RPCDataService events for provider discovery
- [x] Integration tests — mock HorizonStaking only; real GraphTallyCollector/PaymentsEscrow/GraphPayments
- [x] EIP-712 cross-language compatibility tests (Solidity ↔ Rust)
- [x] Docker Compose full-stack deployment
- [x] GitHub Actions CI (Rust fmt/clippy/test + Solidity fmt/test)

---

## Phase 2 — Production Foundation ✅ Complete

Originally targeted Q4 2026. Completed ahead of schedule.

- [x] `eth_call` and `eth_getLogs` — multi-provider quorum consensus; minority providers penalised
- [x] 10+ chains — Ethereum, Arbitrum, Optimism, Base, Polygon, BNB, Avalanche, zkSync Era, Linea, Scroll
- [x] CU-weighted pricing — per-method compute units (1–20 CU); receipt value = CU × `base_price_per_cu`
- [x] QoS scoring — latency + availability + freshness, weighted random selection
- [x] Geographic routing — region-aware score bonus, proximity preference before latency data exists
- [x] Provider capability tiers — Standard / Archive / Debug; gateway filters by required tier per method
- [x] Dynamic provider discovery — subgraph-driven registry with configurable poll interval
- [x] Per-IP rate limiting — token-bucket via `governor`, configurable RPS + burst
- [x] Prometheus metrics — `drpc_requests_total`, `drpc_request_duration_seconds`
- [x] JSON-RPC batch support — concurrent dispatch, per-item error isolation

---

## Phase 3 — Full Feature Parity ✅ Complete

Originally targeted Q1 2027.

- [x] WebSocket subscriptions — `eth_subscribe` / `eth_unsubscribe` proxied bidirectionally
- [x] Tier 1 fraud proof slashing — `slash()` with EIP-1186 MPT proofs via `StateProofVerifier.sol`
- [x] Block header trust oracle — `drpc-oracle` polls L1, submits state roots to Arbitrum for on-chain verification
- [x] Archive tier routing — `requires_archive()` inspects block parameters; hex block numbers, `"earliest"`, and JSON integers route to Archive tier
- [x] `debug_*` / `trace_*` routing — per-chain capability map (not global union); providers advertising Debug on chain X are only routed debug requests for chain X

---

## Phase 4 — Production Readiness ✅ Complete (except deferred items)

Originally targeted Q2 2027.

- [x] Cross-chain unified `/rpc` endpoint — chain selected via `X-Chain-Id` header; defaults to chain 1
- [x] Permissionless chain registration — `proposeChain()` locks 100k GRT bond; governance approves/rejects
- [x] GRT issuance groundwork — `issuancePerCU` storage + `setIssuancePerCU()` governance setter; wiring to RewardsManager is governance-gated (Phase 5)
- [x] Indexer agent — TypeScript package (`indexer-agent/`) automating register/startService/stopService lifecycle with graceful shutdown
- [x] Subgraph schema v2 — `Protocol` aggregate entity (total providers, active registrations), `ChainProposal` entity for bond lifecycle
- [ ] TEE-based response verification — deferred; requires enclave hardware + security audit (~6 months design)
- [ ] P2P SDK — deferred; rethinks the payment trust model; gateway-optional considered for Phase 5

---

## Phase 5 — Consumer SDK & Rewards Pool ✅ Complete

Originally targeted Q3 2027.

- [x] Consumer SDK (`consumer-sdk/`) — TypeScript package for dApp developers
  - EIP-712 TAP receipt signing (`tap.ts`) — cross-language compatible with provider TAP v2 verification
  - Subgraph-driven provider discovery (`discovery.ts`) — live registry via GraphQL
  - Weighted QoS selection (`selector.ts`) — probability proportional to score; EMA update after each request
  - Attestation verification utilities (`attestation.ts`) — hash computation + signer recovery
  - `DRPCClient` (`client.ts`) — single-call `request()` with automatic receipt signing, provider selection, QoS tracking, and 60s discovery TTL
- [x] Rewards pool — `depositRewardsPool` / `withdrawRewardsPool` (governance); `claimRewards()` (provider)
  - Issuance accrues on every `collect()`: `reward = fees × issuancePerCU / 1e18`, capped at remaining pool
  - `pendingRewards` mapping stores per-recipient unclaimed GRT
- [x] Dynamic thawing period — `setMinThawingPeriod()` live; lower-bounded by `MIN_THAWING_PERIOD` constant; `collect()` uses `minThawingPeriod` storage variable

---

## Before deployment (pre-testnet checklist)

All five phases are feature-complete. The following work remains before a live network run:

- [ ] **Contract deployment** — run `forge script script/Deploy.s.sol` on Arbitrum Sepolia; propagate address to all configs
- [ ] **Subgraph deployment** — `graph deploy` with correct `startBlock`; update `subgraphUrl` in all configs and SDK examples
- [ ] **End-to-end integration test** — full cycle: consumer → gateway → drpc-service → backend node → TAP receipt → `RPCDataService.collect()`; currently only unit-tested
- [ ] **npm publish** — `consumer-sdk` and `indexer-agent` need `publishConfig`, `files`, and `prepublishOnly` build hook before publishing to npm
- [ ] **Indexer agent tests** — agent has no automated tests; basic Anvil-backed smoke test before anyone runs it against mainnet
- [ ] **Light security review** — `RPCDataService.sol` handles real GRT; worth a focused audit pass before live funds

---

## Deferred (no current timeline)

- **TEE-based response verification** — enclave hardware + security audit; ~6 months minimum design work
- **P2P SDK** — gateway-optional payment model; rethinks trust assumptions end-to-end
