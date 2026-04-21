use std::{net::SocketAddr, sync::Arc, time::Instant};

use alloy_primitives::Bytes;
use axum::{
    extract::{ConnectInfo, Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::task::JoinSet;

use crate::{config::CapabilityTier, error::GatewayError, metrics, registry::Provider, selector, server::AppState};
use dispatch_tap::create_receipt;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rpc/:chain_id", post(rpc_handler))
        .route("/rpc", post(rpc_handler_unified))
}

/// Unified multi-chain endpoint — chain selected via the `X-Chain-Id` header.
/// Defaults to Ethereum mainnet (chain ID 1) when the header is absent or unparseable.
async fn rpc_handler_unified(
    state: State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Json<Value>,
) -> Result<Response, GatewayError> {
    let chain_id: u64 = headers
        .get("x-chain-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    rpc_handler(state, Path(chain_id), ConnectInfo(peer), body).await
}

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
    pub id: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    pub id: Option<Value>,
}

impl JsonRpcRequest {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.jsonrpc != "2.0" {
            return Err(GatewayError::InvalidRequest(format!(
                "unsupported jsonrpc version: {}",
                self.jsonrpc
            )));
        }
        if self.method.is_empty() {
            return Err(GatewayError::InvalidRequest("method is empty".to_string()));
        }
        Ok(())
    }
}

/// Returns true if the request targets a specific historical block, requiring
/// an Archive-tier provider. Standard nodes only retain ~128 recent blocks.
fn requires_archive(method: &str, params: &Option<Value>) -> bool {
    fn is_historical(tag: &Value) -> bool {
        match tag {
            Value::String(s) => !matches!(s.as_str(), "latest" | "pending" | "safe" | "finalized"),
            Value::Number(_) => true,
            _ => false,
        }
    }

    let Some(Value::Array(arr)) = params.as_ref() else {
        return false;
    };

    match method {
        // blockTag is the second parameter (index 1).
        "eth_getBalance" | "eth_getCode" | "eth_getTransactionCount" | "eth_call" => {
            arr.get(1).is_some_and(is_historical)
        }
        // blockTag is the third parameter (index 2).
        "eth_getStorageAt" => arr.get(2).is_some_and(is_historical),
        // blockTag is the first parameter (index 0).
        "eth_getBlockByNumber" => arr.get(0).is_some_and(is_historical),
        // Filter object may contain fromBlock / toBlock.
        "eth_getLogs" => {
            if let Some(Value::Object(filter)) = arr.get(0) {
                filter.get("fromBlock").is_some_and(is_historical)
                    || filter.get("toBlock").is_some_and(is_historical)
            } else {
                false
            }
        }
        _ => false,
    }
}

/// Map a JSON-RPC method + params to the minimum capability tier required to serve it.
fn required_tier(method: &str, params: &Option<Value>) -> CapabilityTier {
    if method.starts_with("debug_") || method.starts_with("trace_") {
        CapabilityTier::Debug
    } else if requires_archive(method, params) {
        CapabilityTier::Archive
    } else {
        CapabilityTier::Standard
    }
}

// ---------------------------------------------------------------------------
// Handler — single and batch
// ---------------------------------------------------------------------------

async fn rpc_handler(
    State(state): State<AppState>,
    Path(chain_id): Path<u64>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    // Per-IP rate limiting.
    if let Some(limiter) = &state.rate_limiter {
        if limiter.check_key(&peer.ip()).is_err() {
            return Err(GatewayError::RateLimited);
        }
    }

    match body {
        Value::Array(items) => {
            if items.is_empty() {
                return Err(GatewayError::InvalidRequest("empty batch".to_string()));
            }
            let requests: Vec<JsonRpcRequest> = items
                .into_iter()
                .map(serde_json::from_value)
                .collect::<Result<_, _>>()
                .map_err(|e| GatewayError::InvalidRequest(e.to_string()))?;

            let responses: Vec<Value> = join_all(
                requests.iter().map(|req| process_request(&state, chain_id, req)),
            )
            .await
            .into_iter()
            .map(|r| match r {
                Ok((resp, _attestation)) => serde_json::to_value(resp).unwrap_or(Value::Null),
                Err(e) => json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32000, "message": e.to_string() }
                }),
            })
            .collect();

            Ok(Json(Value::Array(responses)).into_response())
        }
        Value::Object(_) => {
            let request: JsonRpcRequest = serde_json::from_value(body)
                .map_err(|e| GatewayError::InvalidRequest(e.to_string()))?;
            let (response, attestation) = process_request(&state, chain_id, &request).await?;
            let mut resp = Json(response).into_response();
            if let Some(att) = attestation {
                if let Ok(val) = att.parse() {
                    resp.headers_mut().insert("x-drpc-attestation", val);
                }
            }
            Ok(resp)
        }
        _ => Err(GatewayError::InvalidRequest(
            "expected JSON object or array".to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

async fn process_request(
    state: &AppState,
    chain_id: u64,
    request: &JsonRpcRequest,
) -> Result<(JsonRpcResponse, Option<String>), GatewayError> {
    request.validate()?;

    // Load registry snapshot and select candidates — guard dropped before any await.
    let candidates = {
        let registry = state.registry.load();
        let (providers, chain_head) = registry
            .providers_for_chain(chain_id)
            .ok_or(GatewayError::UnsupportedChain(chain_id))?;

        // Filter to providers that support the required capability tier for this chain.
        let tier = required_tier(&request.method, &request.params);
        let capable: Vec<_> = providers
            .iter()
            .filter(|p| p.chain_capabilities
                .get(&chain_id)
                .map_or(false, |caps| caps.contains(&tier)))
            .cloned()
            .collect();

        if capable.is_empty() {
            return Err(GatewayError::NoProviders(chain_id));
        }

        selector::select(
            &capable,
            chain_head,
            state.config.qos.concurrent_k,
            state.config.gateway.region.as_deref(),
            state.config.qos.region_bonus,
        )
    };

    let cu = cu_weight_for(&request.method);
    let receipt_value = cu as u128 * state.config.tap.base_price_per_cu;

    let start = Instant::now();

    let (response, attestation, winner) =
        dispatch_concurrent(state, chain_id, request, &candidates, receipt_value).await?;

    let duration = start.elapsed().as_secs_f64();
    let outcome = if response.error.is_some() { "error" } else { "ok" };
    metrics::record(chain_id, &request.method, outcome, duration);

    tracing::debug!(
        method = %request.method,
        chain_id,
        provider = %winner.endpoint,
        cu,
        "served"
    );

    Ok((response, attestation))
}

// ---------------------------------------------------------------------------
// Concurrent dispatch — first valid response wins (non-quorum methods)
// ---------------------------------------------------------------------------

async fn dispatch_concurrent(
    state: &AppState,
    chain_id: u64,
    request: &JsonRpcRequest,
    candidates: &[Arc<Provider>],
    receipt_value: u128,
) -> Result<(JsonRpcResponse, Option<String>, Arc<Provider>), GatewayError> {
    let mut set: JoinSet<Result<(JsonRpcResponse, Option<String>, Arc<Provider>), String>> = JoinSet::new();

    for provider in candidates {
        let client = state.http_client.clone();
        let signing_key = state.signing_key.clone();
        let domain_sep = state.tap_domain_separator;
        let data_service = state.config.tap.data_service_address;
        let req = request.clone();
        let p = provider.clone();

        set.spawn(async move {
            let signed = create_receipt(
                &signing_key,
                domain_sep,
                data_service,
                p.address,
                receipt_value,
                Bytes::default(),
            )
            .map_err(|e| e.to_string())?;

            let receipt_header =
                serde_json::to_string(&signed).map_err(|e| e.to_string())?;

            let url = format!("{}/rpc/{}", p.endpoint, chain_id);
            let start = Instant::now();

            let resp = client
                .post(&url)
                .header("TAP-Receipt", receipt_header)
                .json(&req)
                .send()
                .await
                .map_err(|e| format!("connection failed: {e}"))?;

            let ms = start.elapsed().as_millis() as u64;

            if !resp.status().is_success() {
                p.qos.record_failure();
                return Err(format!("HTTP {}", resp.status()));
            }

            let attestation = resp
                .headers()
                .get("x-drpc-attestation")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let body = resp
                .json::<JsonRpcResponse>()
                .await
                .map_err(|e| format!("invalid response: {e}"))?;

            p.qos.record_success(ms);
            Ok((body, attestation, p))
        });
    }

    while let Some(join_result) = set.join_next().await {
        match join_result {
            Ok(Ok((response, attestation, provider))) => {
                set.abort_all();
                return Ok((response, attestation, provider));
            }
            Ok(Err(e)) => tracing::debug!(error = %e, "provider attempt failed"),
            Err(e) => tracing::debug!(error = %e, "task panicked"),
        }
    }

    Err(GatewayError::AllProvidersFailed(chain_id))
}

// ---------------------------------------------------------------------------
// CU weights
// ---------------------------------------------------------------------------

fn cu_weight_for(method: &str) -> u32 {
    match method {
        "eth_chainId" | "net_version" | "eth_blockNumber" => 1,
        "eth_getBalance" | "eth_getTransactionCount" | "eth_getCode" | "eth_getStorageAt"
        | "eth_sendRawTransaction" | "eth_getBlockByHash" | "eth_getBlockByNumber" => 5,
        "eth_call" | "eth_estimateGas" | "eth_getTransactionReceipt"
        | "eth_getTransactionByHash" => 10,
        "eth_getLogs" => 20,
        _ => 10,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_tier_debug_methods() {
        assert_eq!(required_tier("debug_traceCall", &None), CapabilityTier::Debug);
        assert_eq!(required_tier("debug_traceTransaction", &None), CapabilityTier::Debug);
        assert_eq!(required_tier("trace_call", &None), CapabilityTier::Debug);
        assert_eq!(required_tier("trace_replayTransaction", &None), CapabilityTier::Debug);
    }

    #[test]
    fn required_tier_standard_methods() {
        let latest = Some(json!(["0xdeadbeef", "latest"]));
        assert_eq!(required_tier("eth_call", &latest), CapabilityTier::Standard);
        assert_eq!(required_tier("eth_getBalance", &latest), CapabilityTier::Standard);
        assert_eq!(required_tier("eth_getLogs", &None), CapabilityTier::Standard);
        assert_eq!(required_tier("net_version", &None), CapabilityTier::Standard);
    }

    #[test]
    fn required_tier_archive_methods() {
        // Hex block numbers → archive.
        let params_idx1_hex = Some(json!(["0xdeadbeef", "0x100"]));
        assert_eq!(required_tier("eth_getBalance", &params_idx1_hex), CapabilityTier::Archive);
        assert_eq!(required_tier("eth_getCode", &params_idx1_hex), CapabilityTier::Archive);
        assert_eq!(required_tier("eth_getTransactionCount", &params_idx1_hex), CapabilityTier::Archive);

        // "earliest" → archive.
        let params_earliest = Some(json!(["0xdeadbeef", "earliest"]));
        assert_eq!(required_tier("eth_getBalance", &params_earliest), CapabilityTier::Archive);

        // JSON number → archive.
        let params_num = Some(json!(["0xdeadbeef", 1_000_000u64]));
        assert_eq!(required_tier("eth_getBalance", &params_num), CapabilityTier::Archive);

        // eth_getStorageAt — blockTag at index 2.
        let storage = Some(json!(["0xdeadbeef", "0x0", "0x100"]));
        assert_eq!(required_tier("eth_getStorageAt", &storage), CapabilityTier::Archive);

        // eth_call with historical blockTag.
        let call = Some(json!([{"to": "0xabc", "data": "0x"}, "0x100"]));
        assert_eq!(required_tier("eth_call", &call), CapabilityTier::Archive);

        // eth_getBlockByNumber — blockTag at index 0.
        let by_num = Some(json!(["0x100", false]));
        assert_eq!(required_tier("eth_getBlockByNumber", &by_num), CapabilityTier::Archive);
        let by_latest = Some(json!(["latest", false]));
        assert_eq!(required_tier("eth_getBlockByNumber", &by_latest), CapabilityTier::Standard);

        // eth_getLogs with historical fromBlock.
        let logs = Some(json!([{"fromBlock": "0x100", "toBlock": "0x200"}]));
        assert_eq!(required_tier("eth_getLogs", &logs), CapabilityTier::Archive);
        let logs_latest = Some(json!([{"fromBlock": "latest", "toBlock": "latest"}]));
        assert_eq!(required_tier("eth_getLogs", &logs_latest), CapabilityTier::Standard);
    }
}
