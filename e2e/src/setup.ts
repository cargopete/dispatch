import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChildProcess } from "node:child_process";
import { spawnProcess, waitForPort, killProcess } from "./process.js";

const ROOT = path.resolve(import.meta.dirname, "../../");
const CONTRACTS = path.join(ROOT, "contracts");
const TMP = path.join(ROOT, "e2e/tmp");

// Resolve tool paths by well-known locations rather than relying on PATH,
// since vitest workers don't source shell rc files.
const HOME = os.homedir();
const FORGE = path.join(HOME, ".foundry", "bin", "forge");
const ANVIL = path.join(HOME, ".foundry", "bin", "anvil");
const CARGO = path.join(HOME, ".cargo", "bin", "cargo");
const ENV: NodeJS.ProcessEnv = { ...process.env };

let anvil: ChildProcess;
let service: ChildProcess;
let gateway: ChildProcess;

/** Run a command to completion, streaming output, resolving on exit 0. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${path.basename(cmd)}] ${d}`));
    proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${path.basename(cmd)}] ${d}`));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

export async function setup() {
  fs.mkdirSync(TMP, { recursive: true });


  // 1. Start Anvil
  anvil = spawnProcess(
    ANVIL,
    ["--port", "8545", "--chain-id", "31337", "--accounts", "5"],
    { cwd: ROOT, env: ENV }
  );
  await waitForPort(8545);

  // 2. Run Foundry setup script
  await run(
    FORGE,
    [
      "script",
      "script/SetupE2E.s.sol:SetupE2E",
      "--rpc-url",
      "http://127.0.0.1:8545",
      "--broadcast",
      "--skip-simulation",
    ],
    { cwd: CONTRACTS }
  );

  // 3. Read fixture
  const fixture = JSON.parse(
    fs.readFileSync(path.join(CONTRACTS, "out/e2e-fixture.json"), "utf8")
  );
  process.env.E2E_FIXTURE = JSON.stringify(fixture);

  // 4. Write service configs
  const serviceCfg = `
[server]
host = "127.0.0.1"
port = 7700

[indexer]
service_provider_address = "${fixture.providerAddress}"
operator_private_key = "${fixture.providerKey}"

[tap]
data_service_address = "${fixture.rpcDataService}"
authorized_senders = ["${fixture.gatewaySignerAddress}"]
eip712_domain_name = "TAP"
eip712_chain_id = 31337
eip712_verifying_contract = "${fixture.graphTallyCollector}"
max_receipt_age_ns = 300000000000

[chains]
supported = [31337]

[chains.backends]
"31337" = "http://127.0.0.1:8545"
`;

  const gatewayCfg = `
[gateway]
host = "127.0.0.1"
port = 8080

[tap]
signer_private_key = "${fixture.gatewaySignerKey}"
data_service_address = "${fixture.rpcDataService}"
base_price_per_cu = 4000000000000
eip712_domain_name = "TAP"
eip712_chain_id = 31337
eip712_verifying_contract = "${fixture.graphTallyCollector}"

[qos]
probe_interval_secs = 3600
concurrent_k = 1

[[providers]]
address = "${fixture.providerAddress}"
endpoint = "http://127.0.0.1:7700"
chains = [31337]
capabilities = ["standard"]
`;

  fs.writeFileSync(path.join(TMP, "service.toml"), serviceCfg.trim());
  fs.writeFileSync(path.join(TMP, "gateway.toml"), gatewayCfg.trim());

  // 5. Build Rust binaries
  await run(CARGO, ["build", "--bins"], { cwd: ROOT });

  // 6. Start dispatch-service
  service = spawnProcess(
    path.join(ROOT, "target/debug/dispatch-service"),
    [],
    {
      cwd: ROOT,
      env: {
        ...ENV,
        DISPATCH_CONFIG: path.join(TMP, "service.toml"),
        RUST_LOG: "info",
      },
    }
  );
  await waitForPort(7700);

  // 7. Start dispatch-gateway
  gateway = spawnProcess(
    path.join(ROOT, "target/debug/dispatch-gateway"),
    [],
    {
      cwd: ROOT,
      env: {
        ...ENV,
        DISPATCH_GATEWAY_CONFIG: path.join(TMP, "gateway.toml"),
        RUST_LOG: "info",
      },
    }
  );
  await waitForPort(8080);
}

export async function teardown() {
  if (gateway) await killProcess(gateway);
  if (service) await killProcess(service);
  if (anvil) await killProcess(anvil);
}
