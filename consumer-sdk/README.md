# /consumer-sdk

TypeScript SDK for dApp developers to send JSON-RPC requests through the Dispatch decentralised network directly — bypassing the centralised gateway entirely.

The SDK handles provider discovery, TAP v2 receipt signing, QoS-based selection, and optional attestation verification. One import, one call.

---

## Installation

```bash
npm install /consumer-sdk viem
```

---

## Quick start

```typescript
import { DISPATCHClient, CapabilityTier } from "/consumer-sdk";

const client = new DISPATCHClient({
  chainId: 1,
  dataServiceAddress: "0x...",          // RPCDataService contract address
  graphTallyCollector: "0x8f69F5C07477Ac46FBc491B1E6D91E2be0111A9e",
  subgraphUrl: "https://api.thegraph.com/subgraphs/name/dispatch/rpc-network",
  signerPrivateKey: process.env.CONSUMER_KEY as `0x${string}`,
});

const response = await client.request("eth_blockNumber", []);
console.log(response.result); // "0x..."
```

---

## Configuration

```typescript
interface ClientConfig {
  /** EIP-155 chain ID for all requests. */
  chainId: number;

  /** RPCDataService contract address — the `dataService` field in TAP receipts. */
  dataServiceAddress: `0x${string}`;

  /** GraphTallyCollector address — EIP-712 verifying contract for TAP receipts.
   *  Arbitrum One (production): 0x8f69F5C07477Ac46FBc491B1E6D91E2be0111A9e
   *  Arbitrum Sepolia (testnet): 0xacC71844EF6beEF70106ABe6E51013189A1f3738 */
  graphTallyCollector: `0x${string}`;

  /** Dispatch subgraph URL for provider discovery. */
  subgraphUrl: string;

  /** Consumer private key used to sign TAP receipts per request. */
  signerPrivateKey: `0x${string}`;

  /** Minimum capability tier. Defaults to Standard (0).
   *  Use CapabilityTier.Archive for historical block queries.
   *  Use CapabilityTier.Debug for debug_* / trace_* methods. */
  requiredTier?: CapabilityTier;

  /** GRT wei per compute unit — per-method pricing (recommended for production).
   *  value = methodCU(method) × basePricePerCU.
   *  Example: 4_000_000_000_000n ≈ 4e-6 GRT/CU (~$40/M requests at $0.09/GRT).
   *  Takes precedence over baseValuePerRequest. */
  basePricePerCU?: bigint;
  /** Flat GRT wei per request, used when basePricePerCU is not set.
   *  Defaults to 1_000_000_000_000n (1e-6 GRT). */
  baseValuePerRequest?: bigint;
}
```

---

## Capability tiers

| Tier | Value | Suitable for |
|---|---|---|
| `Standard` | 0 | Most methods — last 128 blocks of state |
| `Archive` | 1 | Historical block queries (hex block numbers, `"earliest"`, integer block tags) |
| `Debug` | 2 | `debug_*` and `trace_*` methods |
| `WebSocket` | 3 | `eth_subscribe` / `eth_unsubscribe` |

---

## Attestation verification

The Dispatch protocol includes an optional attestation layer. For Tier 1 methods (`eth_getBalance`, `eth_getStorageAt`, `eth_getCode`, `eth_getProof`), providers sign a hash over the request and response. You can verify these after the fact:

```typescript
const response = await client.request("eth_getBalance", [
  "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "0x104BBBD", // block number as hex
]);

// Attestation verification requires the block context from the response.
// Providers include blockNumber and blockHash in the attestation header.
const attestationSig = httpResponse.headers.get("x-dispatch-attestation") as `0x${string}`;

const valid = await client.verifyAttestation(
  "eth_getBalance",
  ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0x104BBBD"],
  response.result,
  17_000_000n,  // blockNumber
  "0xd4e56740...", // blockHash
  attestationSig,
  "0x<provider-address>"
);
```

---

## Lower-level utilities

The SDK exports all building blocks individually if you need more control.

### Provider discovery

```typescript
import { discoverProviders, CapabilityTier } from "/consumer-sdk";

const providers = await discoverProviders(subgraphUrl, 1, CapabilityTier.Standard);
// [{ address, geoHash, paymentsDestination, services, qosScore }, ...]
```

### Provider selection

```typescript
import { selectProvider, updateQosScore } from "/consumer-sdk";

const provider = selectProvider(providers); // weighted random by qosScore

// After observing latency, update the score for next round:
provider.qosScore = updateQosScore(provider.qosScore, latencyMs);
```

### CU pricing

```typescript
import { methodCU, computeReceiptValue } from "/consumer-sdk";

methodCU("eth_blockNumber")       // 1
methodCU("eth_call")              // 10
methodCU("debug_traceTransaction") // 20
methodCU("unknown_method")        // 5 (default)

const BASE = 4_000_000_000_000n; // 4e-6 GRT per CU
computeReceiptValue("eth_call", BASE); // 40_000_000_000_000n (40e-6 GRT)
```

Use `basePricePerCU` in `ClientConfig` to enable per-method pricing automatically.

### TAP receipt signing

```typescript
import { buildReceipt, signReceipt } from "/consumer-sdk";

const receipt = buildReceipt(
  dataServiceAddress,
  providerAddress,
  1_000_000_000_000n // GRT wei
);

const { signature } = await signReceipt(
  receipt,
  { verifyingContract: graphTallyCollector },
  signerPrivateKey
);

// Attach to your HTTP request:
// "X-Dispatch-Tap-Receipt": JSON.stringify({ receipt, signature })
```

### Attestation hash computation

```typescript
import { computeAttestationHash, recoverAttestationSigner } from "/consumer-sdk";

const hash = computeAttestationHash({
  chainId: 1,
  method: "eth_getBalance",
  params: ["0x...", "latest"],
  response: "0x56bc75e2d63100000",
  blockNumber: 17_000_000n,
  blockHash: "0xd4e5...",
});

const signer = await recoverAttestationSigner(hash, signature);
```

---

## Architecture note

`DISPATCHClient` caches discovered providers for 60 seconds and updates their QoS scores after each request using an exponential moving average. On the first request the discovery TTL is cold, so expect a subgraph query latency on that call.

The `signerPrivateKey` is a consumer key — it identifies who is sending requests and is used to sign TAP receipts. Providers aggregate these receipts and submit them on-chain via `RPCDataService.collect()` to claim GRT fees.

---

## Development

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
```
