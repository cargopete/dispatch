# Contract Reference

`RPCDataService` is deployed on Arbitrum One at `0xA983b18B8291F0c317Ba4Fe0dc0f7cc9373AF078`.

It inherits Horizon's `DataService` + `DataServiceFees` + `DataServicePausable` and implements `IDataService`.

---

## Functions

### `register(serviceProvider, data)`

Registers a new provider.

- `data`: `abi.encode(string endpoint, string geoHash, address paymentsDestination)`
- Validates: provision ≥ `minimumProvisionTokens`, thawing period ≥ `minimumThawingPeriod`
- Sets `paymentsDestination[serviceProvider]` (defaults to `serviceProvider` if zero address)
- Emits `ProviderRegistered`

### `setPaymentsDestination(destination)`

Changes the GRT recipient for collected fees. The new address takes effect on the next `collect()` call. Callable by a registered provider or their authorised operator at any time.

### `startService(serviceProvider, data)`

Activates a provider for a specific chain and tier.

- `data`: `abi.encode(uint64 chainId, uint8 tier, string endpoint)`
- Validates: `chainId` in `supportedChains`, provider registered, provision meets per-chain minimum
- Emits `ServiceStarted`

### `stopService(serviceProvider, data)`

Deactivates a provider for a `(chainId, tier)` pair.

### `deregister(serviceProvider, data)`

Removes the provider from the registry. Must stop all active services first.

### `collect(serviceProvider, paymentType, data)`

Redeems a signed RAV for GRT.

- `data`: `abi.encode(SignedRAV, tokensToCollect)`
- Reverts with `InvalidPaymentType` if `paymentType != QueryFee`
- Calls `GraphTallyCollector.collect()` — verifies EIP-712 signature, tracks cumulative value
- Routes GRT to `paymentsDestination[serviceProvider]`
- Locks `fees × STAKE_TO_FEES_RATIO` via `_lockStake()` (releases after `minThawingPeriod`)

### `addChain(chainId, minProvisionTokens)` / `removeChain(chainId)`

Owner-only chain allowlist management. `minProvisionTokens = 0` uses the protocol default (10,000 GRT).

### `setMinThawingPeriod(period)`

Governance setter. Lower-bounded by `MIN_THAWING_PERIOD` (14 days).

### `slash(serviceProvider, data)`

No-op — reverts with "slashing not supported". Present to satisfy the `IDataService` interface.

---

## Parameters

| Parameter | Value | Notes |
|---|---|---|
| Minimum provision | 10,000 GRT | Governance-adjustable per chain |
| Minimum thawing period | 14 days | Governance-adjustable, lower-bounded |
| stakeToFeesRatio | 5 | Same as SubgraphService |
