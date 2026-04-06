use std::{net::SocketAddr, sync::Arc};

use alloy_primitives::{Address, B256};
use anyhow::Result;
use k256::ecdsa::SigningKey;
use tower_http::trace::TraceLayer;

use crate::{config::Config, probe, registry::Registry, routes};

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub http_client: reqwest::Client,
    pub registry: Arc<Registry>,
    pub signing_key: Arc<SigningKey>,
    /// Pre-computed EIP-712 domain separator for GraphTallyCollector.
    pub tap_domain_separator: B256,
    /// Ethereum address derived from `signing_key` — used as `payer` in RAVs.
    pub signer_address: Address,
}

pub async fn run(config: Config) -> Result<()> {
    let signing_key = {
        let bytes = hex::decode(config.tap.signer_private_key.trim_start_matches("0x"))?;
        SigningKey::from_slice(&bytes)?
    };

    let tap_domain_separator = drpc_tap::domain_separator(
        &config.tap.eip712_domain_name,
        config.tap.eip712_chain_id,
        config.tap.eip712_verifying_contract,
    );

    let signer_address = drpc_tap::address_from_key(&signing_key);
    let registry = Registry::from_config(&config.providers);

    let state = AppState {
        config: Arc::new(config.clone()),
        http_client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()?,
        registry: Arc::new(registry),
        signing_key: Arc::new(signing_key),
        tap_domain_separator,
        signer_address,
    };

    // Start background probe task
    tokio::spawn(probe::run(state.clone()));

    let app = routes::router(state.clone()).layer(TraceLayer::new_for_http());

    let addr: SocketAddr = format!("{}:{}", config.gateway.host, config.gateway.port).parse()?;
    tracing::info!(%addr, "drpc-gateway starting");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
