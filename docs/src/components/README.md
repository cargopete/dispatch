# Components

The Dispatch workspace contains four Rust crates and two TypeScript packages.

| Crate | Role |
|---|---|
| `dispatch-tap` | Shared EIP-712 types and receipt signing primitives |
| `dispatch-service` | Indexer-side JSON-RPC proxy with TAP middleware |
| `dispatch-gateway` | Consumer-facing gateway: routing, QoS, receipt issuance |
| `dispatch-smoke` | End-to-end smoke test binary |

| Package | Role |
|---|---|
| `@lodestar-dispatch/consumer-sdk` | TypeScript SDK for dApp developers |
| `@lodestar-dispatch/indexer-agent` | TypeScript lifecycle agent for providers |
