import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  parseAbiParameters,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

interface Fixture {
  rpcDataService: `0x${string}`;
  graphTallyCollector: `0x${string}`;
  paymentsEscrow: `0x${string}`;
  grtToken: `0x${string}`;
  providerAddress: `0x${string}`;
  providerKey: `0x${string}`;
  gatewayAddress: `0x${string}`;
  gatewayKey: `0x${string}`;
  gatewaySignerAddress: `0x${string}`;
  gatewaySignerKey: `0x${string}`;
  paymentWallet: `0x${string}`;
}

const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

let fx: Fixture;

beforeAll(() => {
  fx = JSON.parse(process.env.E2E_FIXTURE!) as Fixture;
});

const SERVICE_URL = "http://127.0.0.1:7700";
const GATEWAY_URL = "http://127.0.0.1:8080";

// ── helpers ──────────────────────────────────────────────────────────────────

async function signReceipt(
  fx: Fixture,
  overrides: { key?: `0x${string}`; nonce?: bigint } = {}
) {
  const key = overrides.key ?? fx.gatewaySignerKey;
  const account = privateKeyToAccount(key);
  const nonce = overrides.nonce ?? BigInt(Math.floor(Math.random() * 1e15));
  const timestampNs = BigInt(Date.now()) * 1_000_000n;

  const sig = await account.signTypedData({
    domain: {
      name: "TAP",
      version: "1",
      chainId: 31337,
      verifyingContract: fx.graphTallyCollector,
    },
    types: {
      Receipt: [
        { name: "data_service",     type: "address" },
        { name: "service_provider", type: "address" },
        { name: "timestamp_ns",     type: "uint64" },
        { name: "nonce",            type: "uint64" },
        { name: "value",            type: "uint128" },
        { name: "metadata",         type: "bytes" },
      ],
    },
    primaryType: "Receipt",
    message: {
      data_service: fx.rpcDataService,
      service_provider: fx.providerAddress,
      timestamp_ns: timestampNs,
      nonce,
      value: 4_000_000_000_000n,
      metadata: "0x",
    },
  });

  // Construct JSON manually — BigInt fields must be bare number literals, not strings,
  // because serde_json deserialises u64/u128 from JSON numbers, not JSON strings.
  return `{"receipt":{"data_service":"${fx.rpcDataService}","service_provider":"${fx.providerAddress}","timestamp_ns":${timestampNs},"nonce":${nonce},"value":4000000000000,"metadata":"0x"},"signature":"${sig}"}`;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("health", () => {
  it("dispatch-service /health returns 200", async () => {
    const res = await fetch(`${SERVICE_URL}/health`);
    expect(res.status).toBe(200);
  });

  it("dispatch-gateway /health returns 200", async () => {
    const res = await fetch(`${GATEWAY_URL}/health`);
    expect(res.status).toBe(200);
  });
});

describe("direct request to dispatch-service", () => {
  it("accepts a valid TAP-Receipt and returns eth_blockNumber", async () => {
    const receipt = await signReceipt(fx);
    const res = await fetch(`${SERVICE_URL}/rpc/31337`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "TAP-Receipt": receipt,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(typeof body.result).toBe("string");
    expect(body.result).toMatch(/^0x/);
  });

  it("rejects a receipt signed by an unauthorized key", async () => {
    // Sign with gateway key (not gatewaySigner) — not in authorized_senders
    const receipt = await signReceipt(fx, { key: fx.gatewayKey });
    const res = await fetch(`${SERVICE_URL}/rpc/31337`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "TAP-Receipt": receipt,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 2,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with no TAP-Receipt header", async () => {
    const res = await fetch(`${SERVICE_URL}/rpc/31337`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 3,
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe("request through gateway", () => {
  it("routes eth_blockNumber to dispatch-service and returns a result", async () => {
    const res = await fetch(`${GATEWAY_URL}/rpc/31337`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 4,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result).toMatch(/^0x/);
  });
});

describe("payment round-trip", () => {
  it("collect() transfers GRT from escrow to paymentWallet", async () => {
    const publicClient = createPublicClient({
      chain: anvil,
      transport: http(),
    });
    const providerAccount = privateKeyToAccount(fx.providerKey);
    const walletClient = createWalletClient({
      account: providerAccount,
      chain: anvil,
      transport: http(),
    });

    const grtAbi = parseAbi([
      "function balanceOf(address) view returns (uint256)",
    ]);
    const serviceAbi = parseAbi([
      "function collect(address serviceProvider, uint8 paymentType, bytes calldata data) returns (uint256)",
    ]);

    // Record initial paymentWallet balance.
    const before = (await publicClient.readContract({
      address: fx.grtToken,
      abi: grtAbi,
      functionName: "balanceOf",
      args: [fx.paymentWallet],
    })) as bigint;

    // Build and sign a RAV using the gateway signer.
    const signerAccount = privateKeyToAccount(fx.gatewaySignerKey);
    const valueAggregate = 1_000_000_000_000_000_000n; // 1e18 GRT wei
    const timestampNs = BigInt(Date.now()) * 1_000_000n;

    const ravSig = await signerAccount.signTypedData({
      domain: {
        name: "GraphTallyCollector",
        version: "1",
        chainId: 31337,
        verifyingContract: fx.graphTallyCollector,
      },
      types: {
        ReceiptAggregateVoucher: [
          { name: "collectionId",    type: "bytes32" },
          { name: "payer",           type: "address" },
          { name: "serviceProvider", type: "address" },
          { name: "dataService",     type: "address" },
          { name: "timestampNs",     type: "uint64" },
          { name: "valueAggregate",  type: "uint128" },
          { name: "metadata",        type: "bytes" },
        ],
      },
      primaryType: "ReceiptAggregateVoucher",
      message: {
        collectionId:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        payer: fx.gatewayAddress,
        serviceProvider: fx.providerAddress,
        dataService: fx.rpcDataService,
        timestampNs,
        valueAggregate,
        metadata: "0x",
      },
    });

    // abi.encode(SignedRAV, tokensToCollect)
    const ravTuple = {
      collectionId:
        "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
      payer: fx.gatewayAddress,
      serviceProvider: fx.providerAddress,
      dataService: fx.rpcDataService,
      timestampNs,
      valueAggregate,
      metadata: "0x" as `0x${string}`,
    };

    const collectData = encodeAbiParameters(
      parseAbiParameters(
        "((bytes32 collectionId, address payer, address serviceProvider, address dataService, uint64 timestampNs, uint128 valueAggregate, bytes metadata) rav, bytes signature) signedRav, uint256 tokensToCollect"
      ),
      [{ rav: ravTuple, signature: ravSig }, valueAggregate]
    );

    // Call collect() as the provider.
    const txHash = await walletClient.writeContract({
      address: fx.rpcDataService,
      abi: serviceAbi,
      functionName: "collect",
      args: [fx.providerAddress, 0, collectData], // 0 = PaymentTypes.QueryFee
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Verify GRT landed at the payment wallet.
    const after = (await publicClient.readContract({
      address: fx.grtToken,
      abi: grtAbi,
      functionName: "balanceOf",
      args: [fx.paymentWallet],
    })) as bigint;

    expect(after).toBeGreaterThan(before);
  });
});
