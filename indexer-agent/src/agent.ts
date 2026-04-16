import {
  type Account,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import type { AgentConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Minimal inline ABI — only the RPCDataService functions the agent needs.
// ---------------------------------------------------------------------------

const ABI = [
  {
    name: "isRegistered",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "serviceProvider", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "getChainRegistrations",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "chainId", type: "uint64" },
          { name: "tier", type: "uint8" },
          { name: "endpoint", type: "string" },
          { name: "active", type: "bool" },
        ],
      },
    ],
  },
  {
    name: "startService",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "serviceProvider", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "stopService",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "serviceProvider", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

type Registration = { chainId: bigint; tier: number; endpoint: string; active: boolean };

// ---------------------------------------------------------------------------
// IndexerAgent
// ---------------------------------------------------------------------------

export class IndexerAgent {
  private readonly config: AgentConfig;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private readonly contract: { address: `0x${string}`; abi: typeof ABI; chain: Chain; account: Account };

  constructor(config: AgentConfig) {
    this.config = config;

    const account = privateKeyToAccount(config.operatorPrivateKey);
    const url = config.arbitrumRpcUrl.toLowerCase();
    const chain = url.includes("sepolia")
      ? arbitrumSepolia
      : url.includes("127.0.0.1") || url.includes("localhost")
      ? defineChain({
          id: 31337,
          name: "Anvil",
          nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
          rpcUrls: { default: { http: [config.arbitrumRpcUrl] } },
        })
      : arbitrum;

    this.publicClient = createPublicClient({
      chain,
      transport: http(config.arbitrumRpcUrl),
    });

    this.walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.arbitrumRpcUrl),
    });

    this.contract = { address: config.rpcDataServiceAddress, abi: ABI, chain, account };
  }

  async start(): Promise<void> {
    console.log(`[agent] provider=${this.config.providerAddress}`);

    // Initial reconcile, then schedule periodic runs.
    await this.reconcile();

    const intervalMs = (this.config.reconcileIntervalSecs ?? 60) * 1000;
    const timer = setInterval(() => {
      this.reconcile().catch((err) =>
        console.error("[agent] reconcile error:", err)
      );
    }, intervalMs);

    const shutdown = () => {
      clearInterval(timer);
      this.gracefulShutdown()
        .then(() => process.exit(0))
        .catch((err) => {
          console.error("[agent] shutdown error:", err);
          process.exit(1);
        });
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  // ---------------------------------------------------------------------------
  // Reconcile: ensure on-chain state matches config
  // ---------------------------------------------------------------------------

  async reconcile(): Promise<void> {
    const provider = this.config.providerAddress;

    // 1. Register if needed.
    const registered = await this.publicClient.readContract({
      ...this.contract,
      functionName: "isRegistered",
      args: [provider],
    });

    if (!registered) {
      console.log("[agent] not registered — calling register()");
      const dest =
        this.config.paymentsDestination ??
        ("0x0000000000000000000000000000000000000000" as `0x${string}`);
      const data = encodeAbiParameters(
        parseAbiParameters("string, string, address"),
        [this.config.endpoint, this.config.geoHash, dest]
      );
      const hash = await this.walletClient.writeContract({
        ...this.contract,
        functionName: "register",
        args: [provider, data],
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      console.log(`[agent] registered (tx: ${hash})`);
    }

    // 2. Fetch current registrations.
    const onChain = await this.publicClient.readContract({
      ...this.contract,
      functionName: "getChainRegistrations",
      args: [provider],
    });
    const active = (onChain as Registration[]).filter((r) => r.active);

    // 3. Stop active registrations no longer in config.
    for (const reg of active) {
      const keep = this.config.services.some(
        (s) => s.chainId === Number(reg.chainId) && s.tier === reg.tier
      );
      if (!keep) {
        await this.stopService(reg.chainId, reg.tier);
      }
    }

    // 4. Start configured services not yet active.
    for (const svc of this.config.services) {
      const alreadyActive = active.some(
        (r) => Number(r.chainId) === svc.chainId && r.tier === svc.tier
      );
      if (!alreadyActive) {
        await this.startService(svc.chainId, svc.tier, svc.endpoint ?? this.config.endpoint);
      }
    }

    console.log("[agent] reconcile complete");
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown: stop all active registrations before exiting
  // ---------------------------------------------------------------------------

  async gracefulShutdown(): Promise<void> {
    console.log("[agent] shutting down — stopping active registrations");

    const onChain = await this.publicClient.readContract({
      ...this.contract,
      functionName: "getChainRegistrations",
      args: [this.config.providerAddress],
    });

    for (const reg of (onChain as Registration[]).filter((r) => r.active)) {
      try {
        await this.stopService(reg.chainId, reg.tier);
      } catch (err) {
        console.error(
          `[agent] failed to stop chain=${reg.chainId} tier=${reg.tier}:`,
          err
        );
      }
    }

    console.log("[agent] shutdown complete");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async startService(
    chainId: number,
    tier: number,
    endpoint: string
  ): Promise<void> {
    console.log(`[agent] starting chain=${chainId} tier=${tier}`);
    const data = encodeAbiParameters(
      parseAbiParameters("uint64, uint8, string"),
      [BigInt(chainId), tier, endpoint]
    );
    const hash = await this.walletClient.writeContract({
      ...this.contract,
      functionName: "startService",
      args: [this.config.providerAddress, data],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[agent] started chain=${chainId} tier=${tier} (tx: ${hash})`);
  }

  private async stopService(chainId: bigint | number, tier: number): Promise<void> {
    console.log(`[agent] stopping chain=${chainId} tier=${tier}`);
    const data = encodeAbiParameters(
      parseAbiParameters("uint64, uint8"),
      [BigInt(chainId), tier]
    );
    const hash = await this.walletClient.writeContract({
      ...this.contract,
      functionName: "stopService",
      args: [this.config.providerAddress, data],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[agent] stopped chain=${chainId} tier=${tier} (tx: ${hash})`);
  }
}
