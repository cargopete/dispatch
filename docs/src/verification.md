# Attestation

Every `dispatch-service` response carries a cryptographic attestation header:

```
X-Dispatch-Attestation: <hex-encoded ECDSA signature>
```

The signed message is:

```
keccak256(abi.encode(
    chainId,
    keccak256(bytes(method)),
    keccak256(params),
    keccak256(response),
    blockNumber,
    blockHash
))
```

Signed with the provider's operator key. Consumers can verify the signature to confirm which registered provider served the response, and that the response has not been tampered with in transit.

You can verify attestations with the consumer SDK:

```typescript
import { computeAttestationHash, recoverAttestationSigner } from "@lodestar-dispatch/consumer-sdk";

const hash = computeAttestationHash({
  chainId: 42161,
  method: "eth_getBalance",
  params: ["0x...", "latest"],
  response: "0x6f3a59e597c5342",
  blockNumber: 453000000n,
  blockHash: "0x...",
});

const providerAddress = recoverAttestationSigner(hash, attestationSignature);
// verify providerAddress is the registered provider you expect
```
