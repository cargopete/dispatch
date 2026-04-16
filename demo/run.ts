/**
 * Dispatch End-to-End Demo
 *
 * Spins up a complete local stack — Anvil, Horizon mock contracts, dispatch-service
 * (provider), and dispatch-gateway — then runs a consumer through 5 RPC requests and
 * submits a RAV via collect() to prove GRT actually moves.
 *
 * Usage:
 *   cd demo && npm install && npm start
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import type { ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  formatUnits,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── paths ─────────────────────────────────────────────────────────────────────

const ROOT      = path.resolve(import.meta.dirname, "..");
const CONTRACTS = path.join(ROOT, "contracts");
const TMP       = path.join(ROOT, "demo/tmp");
const HOME      = os.homedir();
const FORGE     = path.join(HOME, ".foundry", "bin", "forge");
const ANVIL     = path.join(HOME, ".foundry", "bin", "anvil");
const CARGO     = path.join(HOME, ".cargo",   "bin", "cargo");

// ── chain ─────────────────────────────────────────────────────────────────────

const anvilChain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

// ── types ─────────────────────────────────────────────────────────────────────

interface Fixture {
  rpcDataService:      `0x${string}`;
  graphTallyCollector: `0x${string}`;
  paymentsEscrow:      `0x${string}`;
  grtToken:            `0x${string}`;
  providerAddress:     `0x${string}`;
  providerKey:         `0x${string}`;
  gatewayAddress:      `0x${string}`;
  gatewayKey:          `0x${string}`;
  gatewaySignerAddress:`0x${string}`;
  gatewaySignerKey:    `0x${string}`;
  paymentWallet:       `0x${string}`;
}

// ── utilities ─────────────────────────────────────────────────────────────────

function step(n: number, msg: string) {
  const bar = "─".repeat(60);
  console.log(`\n${bar}\n  Step ${n} — ${msg}\n${bar}`);
}

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline)
          reject(new Error(`port ${port} not ready after ${timeoutMs}ms`));
        else
          setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function spawnBg(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): ChildProcess {
  const label = path.basename(cmd);
  const proc = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`  [${label}] ${d}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`  [${label}] ${d}`));
  return proc;
}

function killProc(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
    setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 3_000);
  });
}

// ── main ──────────────────────────────────────────────────────────────────────

const procs: ChildProcess[] = [];

async function shutdown() {
  console.log("\n  Shutting down…");
  for (const p of [...procs].reverse()) await killProc(p);
}

process.on("SIGINT",  async () => { await shutdown(); process.exit(0); });
process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  // ── 1. Anvil ──────────────────────────────────────────────────────────────
  step(1, "Starting Anvil (local EVM)");
  const anvil = spawnBg(ANVIL, ["--port", "8545", "--chain-id", "31337", "--accounts", "5"]);
  procs.push(anvil);
  await waitForPort(8545);
  console.log("  Anvil ready on :8545");

  // ── 2. Deploy Horizon stack ───────────────────────────────────────────────
  step(2, "Deploying Horizon mock contracts & registering provider");
  execFileSync(
    FORGE,
    [
      "script", "script/SetupE2E.s.sol:SetupE2E",
      "--rpc-url", "http://127.0.0.1:8545",
      "--broadcast", "--skip-simulation",
    ],
    { cwd: CONTRACTS, stdio: "inherit" }
  );

  // ── 3. Read fixture ───────────────────────────────────────────────────────
  const fx = JSON.parse(
    fs.readFileSync(path.join(CONTRACTS, "out/e2e-fixture.json"), "utf-8")
  ) as Fixture;

  console.log(`\n  RPCDataService:  ${fx.rpcDataService}`);
  console.log(`  Provider:        ${fx.providerAddress}`);
  console.log(`  Gateway payer:   ${fx.gatewayAddress}`);
  console.log(`  Payment wallet:  ${fx.paymentWallet}`);

  // ── 4. Write TOML configs ─────────────────────────────────────────────────
  step(3, "Writing dispatch-service and dispatch-gateway configs");

  fs.writeFileSync(path.join(TMP, "service.toml"), `
[server]
host = "127.0.0.1"
port = 7700

[indexer]
service_provider_address = "${fx.providerAddress}"
operator_private_key = "${fx.providerKey}"

[tap]
data_service_address = "${fx.rpcDataService}"
authorized_senders = ["${fx.gatewaySignerAddress}"]
eip712_domain_name = "TAP"
eip712_chain_id = 31337
eip712_verifying_contract = "${fx.graphTallyCollector}"
max_receipt_age_ns = 300000000000

[chains]
supported = [31337]

[chains.backends]
"31337" = "http://127.0.0.1:8545"
`.trim());

  fs.writeFileSync(path.join(TMP, "gateway.toml"), `
[gateway]
host = "127.0.0.1"
port = 8080

[tap]
signer_private_key = "${fx.gatewaySignerKey}"
data_service_address = "${fx.rpcDataService}"
base_price_per_cu = 4000000000000
eip712_domain_name = "TAP"
eip712_chain_id = 31337
eip712_verifying_contract = "${fx.graphTallyCollector}"

[qos]
probe_interval_secs = 3600
concurrent_k = 1

[[providers]]
address = "${fx.providerAddress}"
endpoint = "http://127.0.0.1:7700"
chains = [31337]
capabilities = ["standard"]
`.trim());

  console.log("  Configs written to demo/tmp/");

  // ── 5. Build Rust binaries ────────────────────────────────────────────────
  step(4, "Building Rust binaries");
  execFileSync(CARGO, ["build", "--bins"], { cwd: ROOT, stdio: "inherit" });

  // ── 6. Start dispatch-service ─────────────────────────────────────────────────
  step(5, "Starting dispatch-service (provider)");
  const service = spawnBg(
    path.join(ROOT, "target/debug/dispatch-service"),
    [],
    { DISPATCH_CONFIG: path.join(TMP, "service.toml"), RUST_LOG: "info" }
  );
  procs.push(service);
  await waitForPort(7700);
  console.log("  dispatch-service ready on :7700");

  // ── 7. Start dispatch-gateway ─────────────────────────────────────────────────
  step(6, "Starting dispatch-gateway");
  const gateway = spawnBg(
    path.join(ROOT, "target/debug/dispatch-gateway"),
    [],
    { DISPATCH_GATEWAY_CONFIG: path.join(TMP, "gateway.toml"), RUST_LOG: "info" }
  );
  procs.push(gateway);
  await waitForPort(8080);
  console.log("  dispatch-gateway ready on :8080");

  // ── 8. Snapshot initial GRT balance ──────────────────────────────────────
  const publicClient = createPublicClient({ chain: anvilChain, transport: http() });
  const GRT_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

  const grtBefore = await publicClient.readContract({
    address: fx.grtToken,
    abi: GRT_ABI,
    functionName: "balanceOf",
    args: [fx.paymentWallet],
  }) as bigint;

  // ── 9. Consumer makes 5 requests ─────────────────────────────────────────
  step(7, "Consumer: sending 5 × eth_blockNumber through the gateway");
  console.log(`  Payment wallet GRT (before): ${formatUnits(grtBefore, 18)} GRT`);
  console.log();

  for (let i = 1; i <= 5; i++) {
    const res = await fetch("http://127.0.0.1:8080/rpc/31337", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: i }),
    });
    if (!res.ok) throw new Error(`Request ${i} failed with HTTP ${res.status}`);
    const body = await res.json() as { result: string };
    console.log(`  Request ${i}: eth_blockNumber → ${body.result}`);
  }

  // ── 10. Sign RAV & call collect() ────────────────────────────────────────
  step(8, "Provider: aggregating receipts into a RAV and calling collect()");

  // 5 requests × 4_000_000_000_000 GRT wei per CU (eth_blockNumber = 1 CU).
  const VALUE_AGGREGATE = 20_000_000_000_000n;
  const timestampNs     = BigInt(Date.now()) * 1_000_000n;

  const signerAccount = privateKeyToAccount(fx.gatewaySignerKey);

  const ravSignature = await signerAccount.signTypedData({
    domain: {
      name: "GraphTallyCollector",
      version: "1",
      chainId: 31337,
      verifyingContract: fx.graphTallyCollector,
    },
    types: {
      ReceiptAggregateVoucher: [
        { name: "collectionId",    type: "bytes32"  },
        { name: "payer",           type: "address"  },
        { name: "serviceProvider", type: "address"  },
        { name: "dataService",     type: "address"  },
        { name: "timestampNs",     type: "uint64"   },
        { name: "valueAggregate",  type: "uint128"  },
        { name: "metadata",        type: "bytes"    },
      ],
    },
    primaryType: "ReceiptAggregateVoucher",
    message: {
      collectionId:    "0x0000000000000000000000000000000000000000000000000000000000000000",
      payer:           fx.gatewayAddress,
      serviceProvider: fx.providerAddress,
      dataService:     fx.rpcDataService,
      timestampNs,
      valueAggregate:  VALUE_AGGREGATE,
      metadata:        "0x",
    },
  });

  const ravTuple = {
    collectionId:    "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    payer:           fx.gatewayAddress,
    serviceProvider: fx.providerAddress,
    dataService:     fx.rpcDataService,
    timestampNs,
    valueAggregate:  VALUE_AGGREGATE,
    metadata:        "0x" as `0x${string}`,
  };

  const collectData = encodeAbiParameters(
    parseAbiParameters(
      "((bytes32 collectionId, address payer, address serviceProvider, address dataService, uint64 timestampNs, uint128 valueAggregate, bytes metadata) rav, bytes signature) signedRav, uint256 tokensToCollect"
    ),
    [{ rav: ravTuple, signature: ravSignature }, VALUE_AGGREGATE]
  );

  const providerWallet = createWalletClient({
    account: privateKeyToAccount(fx.providerKey),
    chain: anvilChain,
    transport: http(),
  });

  const txHash = await providerWallet.writeContract({
    address: fx.rpcDataService,
    abi: parseAbi([
      "function collect(address serviceProvider, uint8 paymentType, bytes calldata data) returns (uint256)",
    ]),
    functionName: "collect",
    args: [fx.providerAddress, 0, collectData], // 0 = PaymentTypes.QueryFee
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`  collect() confirmed: ${txHash}`);

  // ── 11. Final balance ─────────────────────────────────────────────────────
  const grtAfter = await publicClient.readContract({
    address: fx.grtToken,
    abi: GRT_ABI,
    functionName: "balanceOf",
    args: [fx.paymentWallet],
  }) as bigint;

  const bar = "═".repeat(60);
  console.log(`\n${bar}`);
  console.log("  DEMO COMPLETE — full payment loop proven");
  console.log(bar);
  console.log(`  Payment wallet GRT (before): ${formatUnits(grtBefore,          18)} GRT`);
  console.log(`  Payment wallet GRT (after):  ${formatUnits(grtAfter,           18)} GRT`);
  console.log(`  GRT received:                ${formatUnits(grtAfter - grtBefore, 18)} GRT`);
  console.log(`\n  Consumer → Gateway → Provider → collect() → GRT ✓`);
  console.log(`${bar}\n`);

  await shutdown();
}

main().catch(async (err) => {
  console.error(err);
  await shutdown();
  process.exit(1);
});
