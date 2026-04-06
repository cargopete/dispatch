//! Dynamic provider discovery via The Graph subgraph.
//!
//! Polls the RPC network subgraph at a configurable interval and rebuilds the
//! provider registry from the response. Providers that disappear from the
//! subgraph (deregistered/inactive) are automatically removed.

use std::sync::Arc;

use serde::Deserialize;
use tokio::time::{interval, Duration, MissedTickBehavior};

use crate::{config::ProviderConfig, registry::Registry, server::AppState};

// ---------------------------------------------------------------------------
// Subgraph response types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SubgraphResponse {
    data: SubgraphData,
}

#[derive(Deserialize)]
struct SubgraphData {
    indexers: Vec<IndexerEntry>,
}

#[derive(Deserialize)]
struct IndexerEntry {
    address: String,
    endpoint: String,
    /// On-chain `geoHash` field from ProviderRegistered — used as the routing region.
    #[serde(rename = "geoHash", default)]
    geo_hash: Option<String>,
    chains: Vec<ChainEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChainEntry {
    chain_id: String,
    /// Capability tier: 0=Standard 1=Archive 2=Debug 3=WebSocket
    tier: i32,
}

// ---------------------------------------------------------------------------
// Discovery loop
// ---------------------------------------------------------------------------

pub async fn run(state: AppState) {
    let cfg = match &state.config.discovery {
        Some(c) => c.clone(),
        None => return, // No subgraph configured — use static providers only.
    };

    let mut tick = interval(Duration::from_secs(cfg.interval_secs));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    tracing::info!(
        subgraph_url = %cfg.subgraph_url,
        interval_secs = cfg.interval_secs,
        "discovery task started"
    );

    loop {
        tick.tick().await;

        match fetch_providers(&state.http_client, &cfg.subgraph_url).await {
            Ok(providers) if !providers.is_empty() => {
                let new_registry = Registry::from_config(&providers);
                state.registry.store(Arc::new(new_registry));
                tracing::info!(count = providers.len(), "provider registry refreshed from subgraph");
            }
            Ok(_) => tracing::warn!("subgraph returned no active providers"),
            Err(e) => tracing::warn!(error = %e, "subgraph discovery failed"),
        }
    }
}

async fn fetch_providers(
    client: &reqwest::Client,
    subgraph_url: &str,
) -> anyhow::Result<Vec<ProviderConfig>> {
    let query = r#"{
        "query": "{ indexers(where: { registered: true }, first: 1000) { address endpoint geoHash chains(where: { active: true }) { chainId tier } } }"
    }"#;

    let resp: SubgraphResponse = client
        .post(subgraph_url)
        .header("Content-Type", "application/json")
        .body(query)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let mut providers = Vec::new();

    for indexer in resp.data.indexers {
        let address = match indexer.address.parse() {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(address = %indexer.address, error = %e, "skipping indexer with invalid address");
                continue;
            }
        };

        // Deduplicate chain IDs — a provider may have multiple registrations
        // per chain (one per tier), so we collect unique IDs.
        let mut seen = std::collections::HashSet::new();
        let chains: Vec<u64> = indexer
            .chains
            .iter()
            .filter_map(|c| c.chain_id.parse::<u64>().ok())
            .filter(|id| seen.insert(*id))
            .collect();

        if chains.is_empty() {
            continue;
        }

        // Collect the union of capability tiers across all chain registrations.
        let mut capabilities: Vec<crate::config::CapabilityTier> = Vec::new();
        for c in &indexer.chains {
            let tier = match c.tier {
                0 => Some(crate::config::CapabilityTier::Standard),
                1 => Some(crate::config::CapabilityTier::Archive),
                2 => Some(crate::config::CapabilityTier::Debug),
                _ => None, // tier 3 = WebSocket — transport, not a routing tier
            };
            if let Some(t) = tier {
                if !capabilities.contains(&t) {
                    capabilities.push(t);
                }
            }
        }
        if capabilities.is_empty() {
            capabilities.push(crate::config::CapabilityTier::Standard);
        }

        providers.push(ProviderConfig {
            address,
            endpoint: indexer.endpoint.trim_end_matches('/').to_string(),
            chains,
            region: indexer.geo_hash.filter(|s| !s.is_empty()),
            capabilities,
        });
    }

    Ok(providers)
}
