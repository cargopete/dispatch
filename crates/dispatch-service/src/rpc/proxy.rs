use reqwest::Client;

use crate::{
    error::ServiceError,
    rpc::types::{JsonRpcRequest, JsonRpcResponse},
};

/// Forward a JSON-RPC request to a backend Ethereum client and return its response.
pub async fn forward(
    client: &Client,
    backend_url: &str,
    request: &JsonRpcRequest,
) -> Result<JsonRpcResponse, ServiceError> {
    tracing::debug!(method = %request.method, %backend_url, "forwarding to backend");

    let resp = client
        .post(backend_url)
        .json(request)
        .send()
        .await
        .map_err(|e| ServiceError::BackendError(format!("connection failed: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(ServiceError::BackendError(format!(
            "backend returned HTTP {status}"
        )));
    }

    resp.json::<JsonRpcResponse>()
        .await
        .map_err(|e| ServiceError::BackendError(format!("failed to parse backend response: {e}")))
}
