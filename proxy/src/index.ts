#!/usr/bin/env tsx
import { createServer, type IncomingMessage } from "node:http";
import { DISPATCHClient, methodCU } from "../../consumer-sdk/src/index.js";

// ─── Config ────────────────────────────────────────────────────────────────────

const SIGNER_KEY = process.env.DISPATCH_SIGNER_KEY as `0x${string}` | undefined;
const CHAIN_ID   = parseInt(process.env.DISPATCH_CHAIN_ID   ?? "1");
const PORT       = parseInt(process.env.DISPATCH_PORT       ?? "8545");
const SUBGRAPH   = process.env.DISPATCH_SUBGRAPH_URL
  ?? "https://api.studio.thegraph.com/query/1747796/rpc-network/v0.2.0";
const PRICE_PER_CU    = BigInt(process.env.DISPATCH_BASE_PRICE_PER_CU ?? "4000000000000");
const DATA_SERVICE    = (process.env.DISPATCH_DATA_SERVICE_ADDRESS
  ?? "0xA983b18B8291F0c317Ba4Fe0dc0f7cc9373AF078") as `0x${string}`;
const TALLY_COLLECTOR = (process.env.DISPATCH_TALLY_COLLECTOR
  ?? "0x8f69F5C07477Ac46FBc491B1E6D91E2bb0111A9e") as `0x${string}`;

if (!SIGNER_KEY) {
  console.error("Error: DISPATCH_SIGNER_KEY environment variable is required.");
  console.error("  export DISPATCH_SIGNER_KEY=0x<your-private-key>");
  process.exit(1);
}

// ─── Chain names ───────────────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1:      "Ethereum Mainnet",
  42161:  "Arbitrum One",
  10:     "Optimism",
  8453:   "Base",
  137:    "Polygon",
  56:     "BNB Chain",
  43114:  "Avalanche",
  324:    "zkSync Era",
  59144:  "Linea",
  534352: "Scroll",
  31337:  "Anvil (local)",
};

const chainName = CHAIN_NAMES[CHAIN_ID] ?? `Chain ${CHAIN_ID}`;

// ─── Client ────────────────────────────────────────────────────────────────────

const client = new DISPATCHClient({
  chainId:             CHAIN_ID,
  dataServiceAddress:  DATA_SERVICE,
  graphTallyCollector: TALLY_COLLECTOR,
  subgraphUrl:         SUBGRAPH,
  signerPrivateKey:    SIGNER_KEY,
  basePricePerCU:      PRICE_PER_CU,
});

// ─── Stats ─────────────────────────────────────────────────────────────────────

let totalRequests = 0;
let totalGrtWei   = 0n;

function costWei(method: string): bigint {
  return BigInt(methodCU(method)) * PRICE_PER_CU;
}

function fmtGrt(wei: bigint): string {
  const grt = Number(wei) / 1e18;
  if (grt === 0) return "0 GRT";
  return grt.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") + " GRT";
}

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

// ─── JSON-RPC helpers ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  method:  string;
  params?: unknown[];
  id:      number | string | null;
}

function rpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleOne(req: JsonRpcRequest): Promise<unknown> {
  const cost  = costWei(req.method);
  const start = Date.now();

  try {
    const response = await client.request(req.method, req.params ?? []);
    const ms       = Date.now() - start;

    totalRequests++;
    totalGrtWei += cost;

    const status = "error" in response ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
    console.log(
      `[${ts()}] ${status} ${req.method.padEnd(38)} ${String(ms).padStart(4)}ms  ${fmtGrt(cost).padEnd(20)}  total: ${fmtGrt(totalGrtWei)}`
    );

    return { ...response, id: req.id };
  } catch (err) {
    const ms  = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[${ts()}] \x1b[31m✗\x1b[0m ${req.method.padEnd(38)} ${String(ms).padStart(4)}ms  ${msg}`);
    return rpcError(req.id, -32603, msg);
  }
}

// ─── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rpcError(null, -32600, "Method not allowed")));
    return;
  }

  const raw = await readBody(req);
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rpcError(null, -32700, "Parse error")));
    return;
  }

  const result = Array.isArray(parsed)
    ? await Promise.all(parsed.map((r) => handleOne(r as JsonRpcRequest)))
    : await handleOne(parsed as JsonRpcRequest);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
});

// ─── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown() {
  console.log("\n\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log(`Session summary`);
  console.log(`  Requests:  ${totalRequests}`);
  console.log(`  GRT spent: ${fmtGrt(totalGrtWei)}`);
  console.log("\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

// ─── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log("\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log(`\x1b[1mdispatch-proxy\x1b[0m v0.1.0`);
  console.log(`\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
  console.log(`Chain:     ${chainName} (${CHAIN_ID})`);
  console.log(`Listening: \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
  console.log(`Add to MetaMask  →  Settings → Networks → Add a network`);
  console.log(`  RPC URL:  \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`  Chain ID: \x1b[36m${CHAIN_ID}\x1b[0m`);
  console.log(`\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n`);
});
