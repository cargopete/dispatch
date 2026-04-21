use alloy_primitives::B256;
use serde_json::Value;

/// Extract block context (block_number, block_hash) from a JSON-RPC response result.
///
/// Used to anchor attestation hashes to a specific block. Where the response
/// naturally contains block fields (block objects, transaction receipts) we
/// pull them out directly. For state-query methods whose results are primitives
/// (eth_getBalance etc.) the response doesn't carry block context, so we return
/// (0, B256::ZERO) — the attestation still binds to method + params + response,
/// just without a block anchor.
pub fn extract_block_context(method: &str, result: &Value) -> (u64, B256) {
    match method {
        // Block-returning methods: result is a block object with "number" and "hash"
        "eth_getBlockByHash" | "eth_getBlockByNumber" => (
            parse_hex_u64(result.get("number").and_then(Value::as_str)),
            parse_b256(result.get("hash").and_then(Value::as_str)),
        ),
        // Transaction-returning methods: result has "blockNumber" and "blockHash"
        "eth_getTransactionReceipt"
        | "eth_getTransactionByHash"
        | "eth_getTransactionByBlockHashAndIndex"
        | "eth_getTransactionByBlockNumberAndIndex" => (
            parse_hex_u64(result.get("blockNumber").and_then(Value::as_str)),
            parse_b256(result.get("blockHash").and_then(Value::as_str)),
        ),
        // State-query and all other methods: no block context in the response body
        _ => (0, B256::ZERO),
    }
}

fn parse_hex_u64(s: Option<&str>) -> u64 {
    s.and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .unwrap_or(0)
}

fn parse_b256(s: Option<&str>) -> B256 {
    s.and_then(|s| {
        let bytes = alloy_primitives::hex::decode(s).ok()?;
        (bytes.len() == 32).then(|| B256::from_slice(&bytes))
    })
    .unwrap_or(B256::ZERO)
}

/// Compute units (CU) for a given method.
/// Phase 1: all methods return the flat baseline weight.
/// Phase 2: expand this with per-method weights from the RFC.
pub fn cu_weight(method: &str) -> u32 {
    match method {
        "eth_chainId" | "net_version" | "eth_blockNumber" => 1,
        "eth_getBalance"
        | "eth_getTransactionCount"
        | "eth_getCode"
        | "eth_getStorageAt"
        | "eth_sendRawTransaction" => 5,
        "eth_getBlockByHash" | "eth_getBlockByNumber" => 5,
        "eth_call"
        | "eth_estimateGas"
        | "eth_getTransactionReceipt"
        | "eth_getTransactionByHash" => 10,
        "eth_getLogs" => 20,
        _ => 10, // conservative default
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_context_from_block_object() {
        let result = serde_json::json!({
            "number": "0x12d687",
            "hash": "0x0100000000000000000000000000000000000000000000000000000000000000"
        });
        let (num, hash) = extract_block_context("eth_getBlockByNumber", &result);
        assert_eq!(num, 0x12d687u64);
        assert_ne!(hash, B256::ZERO);
    }

    #[test]
    fn block_context_from_tx_receipt() {
        let result = serde_json::json!({
            "blockNumber": "0x10",
            "blockHash": "0x0200000000000000000000000000000000000000000000000000000000000000"
        });
        let (num, hash) = extract_block_context("eth_getTransactionReceipt", &result);
        assert_eq!(num, 16u64);
        assert_ne!(hash, B256::ZERO);
    }

    #[test]
    fn block_context_absent_for_state_query() {
        // eth_getBalance result is a hex string — no block context in the response
        let result = serde_json::json!("0x0de0b6b3a7640000");
        let (num, hash) = extract_block_context("eth_getBalance", &result);
        assert_eq!(num, 0);
        assert_eq!(hash, B256::ZERO);
    }

    #[test]
    fn block_context_handles_null_fields_gracefully() {
        let result = serde_json::json!({ "number": null, "hash": null });
        let (num, hash) = extract_block_context("eth_getBlockByHash", &result);
        assert_eq!(num, 0);
        assert_eq!(hash, B256::ZERO);
    }
}
