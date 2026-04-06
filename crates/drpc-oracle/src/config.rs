use alloy_primitives::Address;
use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub oracle: OracleConfig,
    pub l1: L1Config,
    pub arbitrum: ArbitrumConfig,
}

#[derive(Debug, Deserialize)]
pub struct OracleConfig {
    /// How often to poll L1 for a new block (seconds). Default: 12 (one Ethereum block).
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
    /// Seconds to wait for a submitted tx to be mined before giving up. Default: 120.
    #[serde(default = "default_tx_timeout_secs")]
    pub tx_timeout_secs: u64,
}

#[derive(Debug, Deserialize)]
pub struct L1Config {
    /// Ethereum mainnet HTTP RPC URL.
    pub rpc_url: String,
}

#[derive(Debug, Deserialize)]
pub struct ArbitrumConfig {
    /// Arbitrum One (or Sepolia) HTTP RPC URL.
    pub rpc_url: String,
    /// Hex-encoded 32-byte private key for the RPCDataService owner/governance account.
    pub signer_private_key: String,
    /// Deployed RPCDataService contract address on Arbitrum.
    pub data_service_address: Address,
}

impl Config {
    pub fn load() -> Result<Self> {
        let path = std::env::var("DRPC_ORACLE_CONFIG")
            .unwrap_or_else(|_| "oracle.toml".to_string());
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read config from {path}"))?;
        toml::from_str(&contents).context("failed to parse config")
    }
}

fn default_poll_interval_secs() -> u64 {
    12
}
fn default_tx_timeout_secs() -> u64 {
    120
}
