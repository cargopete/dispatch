# dispatch-gateway

Sits between consumers and providers. Handles provider discovery, QoS scoring, geographic routing, TAP receipt issuance, quorum consensus, and rate limiting.

---

## Routes

| Method | Path | Description |
|---|---|---|
| POST | `/rpc/{chain_id}` | JSON-RPC request |
| POST | `/rpc` | JSON-RPC with chain from `X-Chain-Id` header |
| GET | `/ws/{chain_id}` | WebSocket proxy |
| GET | `/health` | Liveness check |
| GET | `/version` | Version info |
| GET | `/providers/{chain_id}` | List active providers for chain |
| GET | `/metrics` | Prometheus metrics |
| POST | `/rav/aggregate` | TAP agent submits receipts, receives signed RAV |

---

## Provider selection

1. Query registry for providers serving the requested `(chain_id, tier)` pair
2. Score each provider by QoS (latency EMA, availability, block freshness)
3. Apply geographic bonus (15% score boost for same-region providers)
4. Weighted random selection from top-k candidates
5. For deterministic methods: quorum dispatch (majority wins). For all others: concurrent dispatch (first valid wins)

**Quorum methods** — `eth_call`, `eth_getLogs`, `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount`, `eth_getStorageAt`, `eth_getBlockByHash`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`. All other methods use concurrent dispatch.

---

## QoS scoring

| Metric | Weight |
|---|---|
| Latency (p50 EMA) | 35% |
| Availability | 35% |
| Block freshness (blocks behind chain head) | 30% |

A synthetic `eth_blockNumber` probe fires to every provider every 10 seconds. Results feed freshness and availability scores.

New providers start with a neutral score and receive a geographic bonus until latency data accumulates.

---

## TAP receipt issuance

The gateway signs a fresh EIP-712 TAP receipt for every request:

- `data_service`: `RPCDataService` address
- `service_provider`: selected provider's address
- `nonce`: random `uint64`
- `value`: `CU_weight × base_price_per_cu` in GRT wei
- `timestamp_ns`: current Unix nanoseconds

The receipt is sent to `dispatch-service` in the `TAP-Receipt` HTTP header.

---

## Dynamic discovery

The gateway polls the RPC network subgraph every 60 seconds (configurable) and rebuilds its provider registry. Providers appearing in the subgraph are probed for liveness before being added to the active pool.

Static provider config (via `[[providers]]` in `gateway.toml`) takes precedence over subgraph discovery and is used when the subgraph is unavailable.

---

## Batch JSON-RPC

Batch requests are dispatched concurrently — each item in the batch is routed independently. Per-item errors are isolated and don't fail the whole batch.

---

## Rate limiting

Per-IP token bucket via `governor`. Configurable requests-per-second and burst size. Returns `429 Too Many Requests` when the bucket is exhausted.

---

## Metrics

Prometheus endpoint at `GET /metrics`:

- `dispatch_requests_total{chain_id, method, status}` — request counter
- `dispatch_request_duration_seconds{chain_id, method}` — latency histogram
