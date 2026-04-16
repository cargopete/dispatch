import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { ChildProcess, spawn } from "child_process";
import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { IndexerAgent } from "./agent.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONTRACTS = path.join(ROOT, "contracts");
const HOME = os.homedir();
const FORGE = path.join(HOME, ".foundry", "bin", "forge");
const ANVIL = path.join(HOME, ".foundry", "bin", "anvil");

const anvilChain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

interface Fixture {
  rpcDataService: `0x${string}`;
  providerAddress: `0x${string}`;
  providerKey: `0x${string}`;
  gatewaySignerAddress: `0x${string}`;
  paymentWallet: `0x${string}`;
}

const SERVICE_ABI = parseAbi([
  "function isRegistered(address) view returns (bool)",
  "function getChainRegistrations(address) view returns ((uint64 chainId, uint8 tier, string endpoint, bool active)[])",
]);

let anvilProc: ChildProcess;
let fx: Fixture;
let publicClient: ReturnType<typeof createPublicClient>;

function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) reject(new Error(`port ${port} not ready after ${timeoutMs}ms`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function makeAgent(services: Array<{ chainId: number; tier: number }>) {
  return new IndexerAgent({
    arbitrumRpcUrl: "http://127.0.0.1:8545",
    rpcDataServiceAddress: fx.rpcDataService,
    operatorPrivateKey: fx.providerKey,
    providerAddress: fx.providerAddress,
    endpoint: "http://127.0.0.1:7700",
    geoHash: "u1hx",
    paymentsDestination: fx.paymentWallet,
    services: services.map((s) => ({ chainId: s.chainId, tier: s.tier })),
  });
}

beforeAll(async () => {
  anvilProc = spawn(ANVIL, ["--port", "8545", "--chain-id", "31337", "--accounts", "5"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForPort(8545);

  execFileSync(
    FORGE,
    [
      "script", "script/SetupE2E.s.sol:SetupE2E",
      "--rpc-url", "http://127.0.0.1:8545",
      "--broadcast", "--skip-simulation",
    ],
    { cwd: CONTRACTS, stdio: "inherit" }
  );

  fx = JSON.parse(
    readFileSync(path.join(CONTRACTS, "out/e2e-fixture.json"), "utf-8")
  ) as Fixture;

  publicClient = createPublicClient({ chain: anvilChain, transport: http() });
}, 60_000);

afterAll(async () => {
  if (anvilProc && anvilProc.exitCode === null) {
    await new Promise<void>((resolve) => {
      anvilProc.once("exit", () => resolve());
      anvilProc.kill("SIGTERM");
    });
  }
});

describe("IndexerAgent", () => {
  it("reconcile is idempotent when on-chain state already matches config", async () => {
    // SetupE2E pre-registers the provider and starts chain 31337 tier 0.
    // Reconciling with the same config should be a no-op.
    const agent = makeAgent([{ chainId: 31337, tier: 0 }]);
    await agent.reconcile();

    const registered = await publicClient.readContract({
      address: fx.rpcDataService,
      abi: SERVICE_ABI,
      functionName: "isRegistered",
      args: [fx.providerAddress],
    });
    expect(registered).toBe(true);

    const regs = await publicClient.readContract({
      address: fx.rpcDataService,
      abi: SERVICE_ABI,
      functionName: "getChainRegistrations",
      args: [fx.providerAddress],
    }) as Array<{ chainId: bigint; tier: number; active: boolean }>;

    const active = regs.filter((r) => r.active);
    expect(active).toHaveLength(1);
    expect(Number(active[0].chainId)).toBe(31337);
    expect(active[0].tier).toBe(0);
  }, 30_000);

  it("reconcile stops a service removed from config", async () => {
    // Empty services list — agent should stop chain 31337 tier 0.
    const agent = makeAgent([]);
    await agent.reconcile();

    const regs = await publicClient.readContract({
      address: fx.rpcDataService,
      abi: SERVICE_ABI,
      functionName: "getChainRegistrations",
      args: [fx.providerAddress],
    }) as Array<{ active: boolean }>;

    expect(regs.every((r) => !r.active)).toBe(true);
  }, 30_000);

  it("reconcile starts a service added to config", async () => {
    // Previous test left everything stopped. Add chain 31337 tier 0 back.
    const agent = makeAgent([{ chainId: 31337, tier: 0 }]);
    await agent.reconcile();

    const regs = await publicClient.readContract({
      address: fx.rpcDataService,
      abi: SERVICE_ABI,
      functionName: "getChainRegistrations",
      args: [fx.providerAddress],
    }) as Array<{ chainId: bigint; tier: number; active: boolean }>;

    const active = regs.filter((r) => r.active);
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(active.some((r) => Number(r.chainId) === 31337 && r.tier === 0)).toBe(true);
  }, 30_000);

  it("gracefulShutdown stops all active services", async () => {
    // Precondition: at least one service active (previous test).
    const agent = makeAgent([{ chainId: 31337, tier: 0 }]);
    await agent.gracefulShutdown();

    const regs = await publicClient.readContract({
      address: fx.rpcDataService,
      abi: SERVICE_ABI,
      functionName: "getChainRegistrations",
      args: [fx.providerAddress],
    }) as Array<{ active: boolean }>;

    expect(regs.every((r) => !r.active)).toBe(true);
  }, 30_000);
});
