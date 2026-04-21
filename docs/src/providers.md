# Running a Provider

To join the Dispatch network as a provider you need:

- ≥ 25,000 GRT staked on Arbitrum One
- An Ethereum node (full or archive) for each chain you want to serve
- `dispatch-service` running alongside your node
- An on-chain registration via `dispatch-indexer-agent` or directly via the contract

---

## 1. Stake on Horizon

Provision your stake to `RPCDataService` on Arbitrum One:

```solidity
HorizonStaking.provision(
    serviceProvider,                              // your address
    0x73846272813065c3e4efdb3fb82e0d128c8c2364,  // RPCDataService
    tokens,                                       // ≥ 25,000 GRT (in wei)
    maxVerifierCut,                               // e.g. 100000 = 10%
    thawingPeriod                                 // ≥ 14 days in seconds
)
```

You can do this via Etherscan, cast, or a custom script.

---

## 2. Configure dispatch-service

```bash
cp config.example.toml config.toml
```

Edit `config.toml`:

```toml
[indexer]
service_provider_address = "0xYOUR_PROVIDER_ADDRESS"
operator_private_key      = "0x..."   # signs on-chain collect() transactions

[tap]
data_service_address      = "0x73846272813065c3e4efdb3fb82e0d128c8c2364"
authorized_senders        = ["0xGATEWAY_SIGNER_ADDRESS"]
eip712_chain_id           = 42161
eip712_verifying_contract = "0x8f69F5C07477Ac46FBc491B1E6D91E2bb0111A9e"

[database]
url = "postgres://dispatch:dispatch@localhost/dispatch"

[chains.backends]
"1"     = "http://localhost:8545"   # Ethereum mainnet
"42161" = "http://localhost:8546"   # Arbitrum One
```

TAP aggregation and on-chain `collect()` are built into `dispatch-service` — no separate TAP agent binary is needed. The service aggregates receipts into RAVs every 60s and calls `RPCDataService.collect()` every hour automatically.

Start the service:

```bash
RUST_LOG=info cargo run --bin dispatch-service
```

---

## 3. Register on-chain

Use the indexer agent to manage your on-chain lifecycle automatically:

```typescript
import { IndexerAgent } from "@dispatch/indexer-agent";

const agent = new IndexerAgent({
  arbitrumRpcUrl: "https://arb1.arbitrum.io/rpc",
  rpcDataServiceAddress: "0x73846272813065c3e4efdb3fb82e0d128c8c2364",
  operatorPrivateKey: process.env.OPERATOR_KEY as `0x${string}`,
  providerAddress: "0xYOUR_PROVIDER_ADDRESS",
  endpoint: "https://rpc.your-domain.com",
  geoHash: "u1hx",                    // geohash of your server location
  paymentsDestination: "0x...",       // address that receives collected GRT
  services: [
    { chainId: 1,     tier: 0 },      // Ethereum mainnet, Standard
    { chainId: 42161, tier: 0 },      // Arbitrum One, Standard
    { chainId: 42161, tier: 1 },      // Arbitrum One, Archive
  ],
});

// Call on a cron/interval — idempotent, safe to call repeatedly
await agent.reconcile();
```

The agent calls `register()`, `startService()`, and `stopService()` as needed. It handles graceful shutdown on SIGTERM/SIGINT, stopping all active registrations before exit.

---

---

## Supported chains

| Chain | ID |
|---|---|
| Ethereum | 1 |
| Arbitrum One | 42161 |
| Optimism | 10 |
| Base | 8453 |
| Polygon | 137 |
| BNB Chain | 56 |
| Avalanche C-Chain | 43114 |
| zkSync Era | 324 |
| Linea | 59144 |
| Scroll | 534352 |

---

## Capability tiers

| Tier | Value | Methods | Node requirement |
|---|---|---|---|
| Standard | 0 | All standard methods, last 128 blocks | Full node |
| Archive | 1 | Full historical state | Archive node |
| Debug/Trace | 2 | `debug_*`, `trace_*` | Full/archive + debug APIs |
| WebSocket | 3 | `eth_subscribe`, real-time | Full node + WS |

Your provisioned stake is shared across all chains you serve — no per-chain stake splitting.
