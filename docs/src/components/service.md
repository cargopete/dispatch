# dispatch-service

Runs on the indexer alongside an Ethereum node. Validates TAP receipts, proxies JSON-RPC requests, signs responses, and persists receipts to PostgreSQL.

---

## Routes

| Method | Path | Description |
|---|---|---|
| POST | `/rpc/{chain_id}` | JSON-RPC request (single or batch) |
| GET | `/ws/{chain_id}` | WebSocket proxy for `eth_subscribe` |
| GET | `/health` | Liveness check |
| GET | `/version` | Version info |
| GET | `/chains` | List of supported chains |

---

## Request flow

```
Gateway POST /rpc/42161
  + TAP-Receipt: { signed EIP-712 receipt }
        │
        ▼
TAP middleware
  - recover signer from EIP-712 signature
  - check sender is in authorized_senders
  - check timestamp not stale (configurable window)
  - persist receipt to tap_receipts table (async)
        │
        ▼
Parse JSON-RPC method + params
        │
        ▼
Forward to backend Ethereum client (chain_id → backend URL mapping)
        │
        ▼
Sign response attestation:
  keccak256(chainId_be8 || method_utf8 || keccak256(params_json) || keccak256(result_json))
        │
        ▼
Return JSON-RPC response
  + x-drpc-attestation: {"signer":"0x…","signature":"0x…"}
```

---

## TAP receipt validation

The service validates every incoming receipt before forwarding the request:

- **Signature**: EIP-712 ECDSA recovery against `GraphTallyCollector` as verifying contract
- **Sender authorisation**: recovered signer must be in `authorized_senders` config list
- **Staleness**: `timestamp_ns` must be within the configured window
- **Data service**: `data_service` field must match `RPCDataService` address

Invalid receipts are rejected with `400 Bad Request`.

---

## Archive tier detection

The service inspects block parameters to determine if a request requires archive state:

- Hex block numbers below current head - 128 → routed to archive backend
- String tags `"earliest"`, `"pending"` → archive
- JSON integers → parsed and compared against head

This allows a single endpoint to serve both standard and archive requests when both backends are configured.
