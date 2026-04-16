use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .route("/chains", get(chains))
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn version() -> Json<Value> {
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "service": env!("CARGO_PKG_NAME"),
    }))
}

async fn chains(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<Value> {
    Json(json!({ "supported": state.config.chains.supported }))
}
