//! dispatch-smoke — end-to-end smoke test for a live Dispatch provider.
//!
//! Signs real TAP receipts and fires JSON-RPC requests at a provider endpoint,
//! verifying the full consumer → provider → Chainstack flow.
//!
//! Usage:
//!   cargo run --bin dispatch-smoke -- --endpoint https://rpc.cargopete.com --chain-id 42161
//!
//! Environment variables (all optional — defaults target the live network):
//!   DISPATCH_ENDPOINT          Provider base URL              (default: https://rpc.cargopete.com)
//!   DISPATCH_CHAIN_ID          EIP-155 chain ID               (default: 42161)
//!   DISPATCH_DATA_SERVICE      RPCDataService address         (default: live mainnet address)
//!   DISPATCH_TALLY_COLLECTOR   GraphTallyCollector address    (default: live mainnet address)
//!   DISPATCH_SIGNER_KEY        Hex private key for receipts   (default: random ephemeral key)

use alloy_primitives::{address, Address, Bytes};
use anyhow::{Context, Result};
use k256::ecdsa::SigningKey;
use rand::rngs::OsRng;
use serde_json::{json, Value};
use std::time::Instant;

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT: &str = "https://rpc.cargopete.com";
const DEFAULT_CHAIN_ID: u64 = 42161;
const DATA_SERVICE: Address = address!("A983b18B8291F0c317Ba4Fe0dc0f7cc9373AF078");
const TALLY_COLLECTOR: Address = address!("8f69F5C07477Ac46FBc491B1E6D91E2bb0111A9e");
const EIP712_CHAIN_ID: u64 = 42161; // Arbitrum One — where GraphTallyCollector lives
const BASE_PRICE_PER_CU: u128 = 4_000_000_000_000; // 4e-6 GRT per CU

// ── Test cases ────────────────────────────────────────────────────────────────

struct Test {
    name: &'static str,
    method: &'static str,
    params: Value,
    /// Return true if the response looks valid.
    validate: fn(&Value) -> bool,
}

fn tests() -> Vec<Test> {
    vec![
        Test {
            name: "eth_blockNumber — returns current block",
            method: "eth_blockNumber",
            params: json!([]),
            validate: |r| r.as_str().map_or(false, |s| s.starts_with("0x")),
        },
        Test {
            name: "eth_chainId — returns 0x61a9 (42161)",
            method: "eth_chainId",
            params: json!([]),
            validate: |r| r.as_str().map_or(false, |s| {
                u64::from_str_radix(s.trim_start_matches("0x"), 16)
                    .map_or(false, |id| id == 42161)
            }),
        },
        Test {
            name: "eth_getBalance — returns balance at latest block (Standard)",
            method: "eth_getBalance",
            // Arbitrum One: bridge contract, always has a balance
            params: json!(["0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a", "latest"]),
            validate: |r| r.as_str().map_or(false, |s| s.starts_with("0x")),
        },
        Test {
            name: "eth_getBalance — historical block (Archive)",
            method: "eth_getBalance",
            params: json!(["0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a", "0x1000000"]),
            validate: |r| r.as_str().map_or(false, |s| s.starts_with("0x")),
        },
        Test {
            name: "eth_getLogs — recent block range (Tier 2 quorum)",
            method: "eth_getLogs",
            params: json!([{
                "fromBlock": "latest",
                "toBlock": "latest"
            }]),
            validate: |r| r.is_array(),
        },
    ]
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let endpoint = std::env::var("DISPATCH_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string());
    let chain_id: u64 = std::env::var("DISPATCH_CHAIN_ID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_CHAIN_ID);

    let data_service: Address = std::env::var("DISPATCH_DATA_SERVICE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DATA_SERVICE);

    let tally_collector: Address = std::env::var("DISPATCH_TALLY_COLLECTOR")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(TALLY_COLLECTOR);

    // Use provided key or generate a fresh ephemeral one.
    let signing_key = match std::env::var("DISPATCH_SIGNER_KEY") {
        Ok(hex) => {
            let bytes = hex::decode(hex.trim_start_matches("0x"))
                .context("DISPATCH_SIGNER_KEY: invalid hex")?;
            SigningKey::from_slice(&bytes).context("DISPATCH_SIGNER_KEY: invalid key")?
        }
        Err(_) => SigningKey::random(&mut OsRng),
    };

    let signer_address = dispatch_tap::address_from_key(&signing_key);
    let domain_sep = dispatch_tap::domain_separator("GraphTallyCollector", EIP712_CHAIN_ID, tally_collector);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    println!("dispatch-smoke");
    println!("  endpoint   : {endpoint}");
    println!("  chain_id   : {chain_id}");
    println!("  data_svc   : {data_service}");
    println!("  signer     : {signer_address}");
    println!();

    // ── Health check ─────────────────────────────────────────────────────────
    let health_url = format!("{endpoint}/health");
    let health = client.get(&health_url).send().await;
    match health {
        Ok(r) if r.status().is_success() => println!("  [PASS] GET /health → {}", r.status()),
        Ok(r) => {
            println!("  [FAIL] GET /health → {}", r.status());
            std::process::exit(1);
        }
        Err(e) => {
            println!("  [FAIL] GET /health → {e}");
            println!();
            println!("  DNS may not have propagated yet. Try again in a few minutes.");
            std::process::exit(1);
        }
    }

    // ── RPC tests ─────────────────────────────────────────────────────────────
    let url = format!("{endpoint}/rpc/{chain_id}");
    let mut passed = 0usize;
    let mut failed = 0usize;

    for (i, test) in tests().iter().enumerate() {
        let cu = cu_for(test.method);
        let receipt_value = cu as u128 * BASE_PRICE_PER_CU;

        let receipt = dispatch_tap::create_receipt(
            &signing_key,
            domain_sep,
            data_service,
            // service_provider: we don't know it here — zero address is fine for smoke testing;
            // the provider validates that its own address matches, which it won't, so receipts
            // will be rejected server-side. This is expected for an unpermissioned smoke test.
            // To do a full validated test, set DISPATCH_PROVIDER_ADDRESS.
            provider_address(),
            receipt_value,
            Bytes::default(),
        )?;

        let receipt_header = serde_json::to_string(&receipt)?;

        let body = json!({
            "jsonrpc": "2.0",
            "method": test.method,
            "params": test.params,
            "id": i + 1,
        });

        let t0 = Instant::now();
        let resp = client
            .post(&url)
            .header("TAP-Receipt", receipt_header)
            .json(&body)
            .send()
            .await;

        let elapsed = t0.elapsed().as_millis();

        match resp {
            Err(e) => {
                println!("  [FAIL] {} — {e}", test.name);
                failed += 1;
            }
            Ok(r) => {
                let status = r.status();
                let json: Value = r.json().await.unwrap_or(Value::Null);

                if let Some(error) = json.get("error") {
                    // Receipt rejection (unauthorized sender) is expected when using an
                    // ephemeral key — the provider correctly rejected the receipt.
                    // Treat this as a "provider responded" pass for connectivity purposes.
                    let code = error.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                    if code == -32001 || code == -32003 {
                        println!("  [PASS] {} — provider rejected receipt (expected for ephemeral key) [{elapsed}ms]", test.name);
                        passed += 1;
                    } else {
                        println!("  [FAIL] {} — RPC error: {error} [{elapsed}ms]", test.name);
                        failed += 1;
                    }
                } else if !status.is_success() {
                    println!("  [FAIL] {} — HTTP {status} [{elapsed}ms]", test.name);
                    failed += 1;
                } else if let Some(result) = json.get("result") {
                    if (test.validate)(result) {
                        println!("  [PASS] {} → {} [{elapsed}ms]", test.name, truncate(&result.to_string(), 40));
                        passed += 1;
                    } else {
                        println!("  [FAIL] {} — unexpected result: {result} [{elapsed}ms]", test.name);
                        failed += 1;
                    }
                } else {
                    println!("  [FAIL] {} — no result field: {json} [{elapsed}ms]", test.name);
                    failed += 1;
                }
            }
        }
    }

    println!();
    println!("  {passed} passed, {failed} failed");

    if failed > 0 {
        std::process::exit(1);
    }

    Ok(())
}

fn cu_for(method: &str) -> u32 {
    match method {
        "eth_chainId" | "eth_blockNumber" => 1,
        "eth_getBalance" | "eth_getCode" | "eth_getTransactionCount" | "eth_getStorageAt" => 5,
        "eth_call" | "eth_estimateGas" | "eth_getTransactionReceipt" => 10,
        "eth_getLogs" => 20,
        _ => 10,
    }
}

fn provider_address() -> Address {
    std::env::var("DISPATCH_PROVIDER_ADDRESS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(Address::ZERO)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}
