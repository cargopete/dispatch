pub mod aggregate;
pub mod health;
pub mod rpc;

use axum::Router;
use crate::server::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(aggregate::router())
        .merge(health::router())
        .merge(rpc::router())
        .with_state(state)
}
