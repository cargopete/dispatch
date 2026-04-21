# Architecture

Dispatch has two deployment paths: a managed gateway (centralised routing, good for apps) and a direct consumer SDK (trustless, peer-to-peer).

```
Consumer (dApp)
   │
   ├── via consumer-sdk (trustless, direct)
   │     signs receipts locally, discovers providers via subgraph
   │
   └── via dispatch-gateway (managed)
         QoS-scored selection, TAP receipt signing, quorum consensus
   │
   │  POST /rpc/{chain_id}
   │  TAP-Receipt: { signed EIP-712 receipt }
   ▼
dispatch-service          ← JSON-RPC proxy, TAP receipt validation,
   │                         response attestation, receipt persistence
   ▼
Ethereum client           ← Geth / Erigon / Reth / Nethermind
(full or archive)

dispatch-oracle           ← polls L1 every ~12s, submits state roots
                            to Arbitrum for on-chain fraud proof verification
```

---

## Payment flow

Receipts accumulate off-chain and settle on-chain in batches via GraphTally (TAP v2):

```
receipts (per request)
  → dispatch-service aggregates into RAV (every 60s)
  → RPCDataService.collect() (every hour)
  → GraphTallyCollector
  → PaymentsEscrow
  → GraphPayments
  → GRT to indexer (via paymentsDestination)
```

`valueAggregate` in a RAV is cumulative and never resets. The collector tracks previously collected amounts to calculate deltas on each `collect()` call.

---

## Workspace layout

```
crates/
├── dispatch-tap/      EIP-712 types, receipt signing (shared by service + gateway)
├── dispatch-service/  Indexer-side JSON-RPC proxy with TAP middleware
├── dispatch-gateway/  Gateway: QoS scoring, provider selection, receipt issuance
├── dispatch-oracle/   Block header oracle: L1 state roots → Arbitrum for slash()
└── dispatch-smoke/    End-to-end smoke test against a live provider

contracts/
├── src/RPCDataService.sol         IDataService implementation (Horizon)
├── src/interfaces/
└── src/lib/StateProofVerifier.sol  EIP-1186 MPT proof verification

consumer-sdk/   TypeScript SDK — direct provider access without a gateway
indexer-agent/  TypeScript agent — automates provider lifecycle on-chain
subgraph/       The Graph subgraph — indexes RPCDataService events
docker/         Docker Compose full-stack deployment
demo/           Self-contained local demo: full payment loop on Anvil
```

---

## Verification tiers

Not all RPC methods can be verified the same way. Dispatch uses three tiers:

| Tier | Methods | Mechanism | Slashable |
|---|---|---|---|
| 1 — Merkle | `eth_getBalance`, `eth_getStorageAt`, `eth_getCode`, `eth_getProof`, `eth_getBlockByHash` | EIP-1186 proof against trusted state root | ✅ |
| 2 — Quorum | `eth_call`, `eth_getLogs`, `eth_blockNumber`, `eth_getTransactionReceipt`, … | Multi-provider majority vote | No |
| 3 — Reputation | `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas` | QoS scoring only | No |

`dispatch-oracle` feeds trusted state roots to `RPCDataService` on Arbitrum, enabling on-chain Tier 1 fraud proof slashing without a light client.

---

## Horizon integration

Dispatch is a data service in the Horizon framework. Three Horizon layers are in play:

**HorizonStaking** — indexers call `provision(serviceProvider, RPCDataService, tokens, maxVerifierCut, thawingPeriod)`. Minimum 25,000 GRT, 14-day thawing period. `RPCDataService` is the slashing authority for that provision.

**GraphPayments + PaymentsEscrow** — consumers deposit GRT into escrow keyed by `(sender, serviceProvider)`. Every request carries a TAP receipt; the TAP agent batches these into RAVs redeemed via `collect()`.

**DataService framework** — `RPCDataService` inherits `DataService` + `DataServiceFees` + `DataServicePausable`. The framework handles stake claim linked lists, fee locking at the configured ratio, and pause logic.
