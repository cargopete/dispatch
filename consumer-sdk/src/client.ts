import type { CapabilityTier, JsonRpcResponse, Provider } from "./types.js";
import { discoverProviders } from "./discovery.js";
import { selectProvider, updateQosScore } from "./selector.js";
import { buildReceipt, signReceipt, serializeSignedReceipt } from "./tap.js";
import { computeReceiptValue } from "./cu.js";

export interface ClientConfig {
  /** EIP-155 chain ID for all requests. */
  chainId: number;
  /** RPCDataService contract address (passed as `dataService` in TAP receipts). */
  dataServiceAddress: `0x${string}`;
  /** GraphTallyCollector address — EIP-712 verifying contract for TAP receipts. */
  graphTallyCollector: `0x${string}`;
  /** Dispatch subgraph URL for provider discovery. */
  subgraphUrl: string;
  /** Consumer's private key used to sign TAP receipts. */
  signerPrivateKey: `0x${string}`;
  /** Minimum capability tier required. Defaults to Standard (0). */
  requiredTier?: CapabilityTier;
  /**
   * GRT wei per compute unit — enables per-method pricing.
   * Receipt value = methodCU(method) × basePricePerCU.
   * Recommended for production. Typical value: 4_000_000_000_000n (4e-6 GRT/CU).
   * Takes precedence over `baseValuePerRequest` when set.
   */
  basePricePerCU?: bigint;
  /**
   * Flat GRT wei value attached to every receipt regardless of method.
   * Used when `basePricePerCU` is not set. Defaults to 1_000_000_000_000n (1e-6 GRT).
   */
  baseValuePerRequest?: bigint;
}

export class DISPATCHClient {
  private readonly chainId: number;
  private readonly dataServiceAddress: `0x${string}`;
  private readonly graphTallyCollector: `0x${string}`;
  private readonly subgraphUrl: string;
  private readonly signerPrivateKey: `0x${string}`;
  private readonly requiredTier: CapabilityTier;
  private readonly basePricePerCU: bigint | undefined;
  private readonly baseValuePerRequest: bigint;

  /** Live provider list with QoS scores, refreshed on each request batch. */
  private providers: Provider[] = [];
  private lastDiscovery = 0;
  private readonly discoveryTtlMs = 60_000;

  private requestId = 1;

  constructor(config: ClientConfig) {
    this.chainId = config.chainId;
    this.dataServiceAddress = config.dataServiceAddress;
    this.graphTallyCollector = config.graphTallyCollector;
    this.subgraphUrl = config.subgraphUrl;
    this.signerPrivateKey = config.signerPrivateKey;
    this.requiredTier = config.requiredTier ?? 0;
    this.basePricePerCU = config.basePricePerCU;
    this.baseValuePerRequest = config.baseValuePerRequest ?? 1_000_000_000_000n;
  }

  /**
   * Send a JSON-RPC request to a Dispatch provider.
   *
   * Handles provider discovery, TAP receipt signing, and QoS score updates.
   * Returns the raw JSON-RPC response object.
   */
  async request<T = unknown>(
    method: string,
    params: unknown[] = []
  ): Promise<JsonRpcResponse<T>> {
    await this.refreshProviders();

    const provider = selectProvider(this.providers);
    const service = provider.services.find(
      (s) => s.chainId === this.chainId && s.tier >= this.requiredTier
    );
    if (!service) {
      throw new Error(
        `Provider ${provider.address} has no service for chain ${this.chainId} tier ${this.requiredTier}`
      );
    }

    const value = this.basePricePerCU !== undefined
      ? computeReceiptValue(method, this.basePricePerCU)
      : this.baseValuePerRequest;

    const receipt = buildReceipt(
      this.dataServiceAddress,
      provider.address,
      value
    );

    const signedReceipt = await signReceipt(
      receipt,
      { verifyingContract: this.graphTallyCollector },
      this.signerPrivateKey
    );

    const id = this.requestId++;
    const start = Date.now();

    const httpResponse = await fetch(service.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "TAP-Receipt": serializeSignedReceipt(signedReceipt),
        "X-Chain-Id": String(this.chainId),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    });

    const latencyMs = Date.now() - start;

    // Update QoS score in-place.
    const idx = this.providers.indexOf(provider);
    if (idx !== -1) {
      this.providers[idx] = {
        ...provider,
        qosScore: updateQosScore(provider.qosScore, latencyMs),
      };
    }

    if (!httpResponse.ok) {
      throw new Error(`HTTP ${httpResponse.status}: ${httpResponse.statusText}`);
    }

    return (await httpResponse.json()) as JsonRpcResponse<T>;
  }

  private async refreshProviders(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDiscovery < this.discoveryTtlMs && this.providers.length > 0) {
      return;
    }

    const fresh = await discoverProviders(
      this.subgraphUrl,
      this.chainId,
      this.requiredTier
    );

    // Preserve QoS scores for known providers.
    const scoreMap = new Map(this.providers.map((p) => [p.address, p.qosScore]));
    this.providers = fresh.map((p) => ({
      ...p,
      qosScore: scoreMap.get(p.address) ?? p.qosScore,
    }));

    this.lastDiscovery = now;
  }
}
