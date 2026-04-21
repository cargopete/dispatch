export enum CapabilityTier {
  Standard = 0,
  Archive = 1,
  Debug = 2,
  WebSocket = 3,
}

export interface ChainService {
  chainId: number;
  tier: CapabilityTier;
  endpoint: string;
}

export interface Provider {
  address: `0x${string}`;
  geoHash: string;
  paymentsDestination: `0x${string}`;
  services: ChainService[];
  /** 0..1 — used for weighted random selection; updated after latency observations. */
  qosScore: number;
}

export interface TapReceipt {
  dataService: `0x${string}`;
  serviceProvider: `0x${string}`;
  /** Unix time in nanoseconds. */
  timestampNs: bigint;
  /** Per-(dataService, serviceProvider) unique nonce preventing replay. */
  nonce: bigint;
  /** GRT wei value of this receipt. */
  value: bigint;
  /** Opaque application metadata (usually 0x for standard requests). */
  metadata: `0x${string}`;
}

export interface SignedTapReceipt {
  receipt: TapReceipt;
  /** 65-byte EIP-712 signature (hex). */
  signature: `0x${string}`;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: unknown[];
  id: number | string;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}
