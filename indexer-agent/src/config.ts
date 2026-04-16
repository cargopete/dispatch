import { readFileSync } from "fs";

export interface ServiceConfig {
  /** EIP-155 chain ID */
  chainId: number;
  /** 0=Standard, 1=Archive, 2=Debug, 3=WebSocket */
  tier: number;
  /** Per-chain/tier endpoint override; defaults to the global endpoint if absent. */
  endpoint?: string;
}

export interface AgentConfig {
  /** Arbitrum One (or Sepolia) RPC URL */
  arbitrumRpcUrl: string;
  /** Deployed RPCDataService contract address */
  rpcDataServiceAddress: `0x${string}`;
  /** Indexer operator private key — signs transactions. Override with OPERATOR_PRIVATE_KEY env var. */
  operatorPrivateKey: `0x${string}`;
  /** On-chain provider address (may differ from the signing key) */
  providerAddress: `0x${string}`;
  /** Public HTTPS endpoint of this indexer's dispatch-service instance */
  endpoint: string;
  /** Geohash string used for geographic routing, e.g. "u1hx" */
  geoHash: string;
  /** Address that receives GRT fee payments. Defaults to providerAddress if absent. */
  paymentsDestination?: `0x${string}`;
  /** List of (chainId, tier) pairs this indexer should serve */
  services: ServiceConfig[];
  /** How often to reconcile on-chain state with desired config (seconds, default: 60) */
  reconcileIntervalSecs?: number;
}

export function loadConfig(path: string): AgentConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

  // Allow private key to be supplied via environment variable.
  if (process.env.OPERATOR_PRIVATE_KEY) {
    raw.operatorPrivateKey = process.env.OPERATOR_PRIVATE_KEY;
  }

  const required = [
    "arbitrumRpcUrl",
    "rpcDataServiceAddress",
    "operatorPrivateKey",
    "providerAddress",
    "endpoint",
    "geoHash",
    "services",
  ];
  for (const field of required) {
    if (!raw[field]) throw new Error(`Config missing required field: ${field}`);
  }

  return {
    reconcileIntervalSecs: 60,
    ...raw,
  } as AgentConfig;
}
