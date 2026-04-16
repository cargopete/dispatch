use alloy::{
    network::EthereumWallet,
    providers::ProviderBuilder,
    signers::local::PrivateKeySigner,
    sol,
};
use alloy_primitives::B256;
use anyhow::Result;
use serde::Deserialize;
use std::time::Duration;
use tokio::time::timeout;

use crate::config::Config;

// Minimal ABI — only the function we need to call.
sol! {
    #[sol(rpc)]
    interface IRPCDataService {
        function setTrustedStateRoot(bytes32 blockHash, bytes32 stateRoot) external;
    }
}

// Only the two fields we care about from eth_getBlockByNumber.
#[derive(Deserialize)]
struct BlockFields {
    hash: B256,
    #[serde(rename = "stateRoot")]
    state_root: B256,
}

#[derive(Deserialize)]
struct JsonRpcBlock {
    result: BlockFields,
}

async fn fetch_l1_block(client: &reqwest::Client, rpc_url: &str) -> Result<(B256, B256)> {
    let resp: JsonRpcBlock = client
        .post(rpc_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_getBlockByNumber",
            "params": ["latest", false],
            "id": 1,
        }))
        .send()
        .await?
        .json()
        .await?;
    Ok((resp.result.hash, resp.result.state_root))
}

pub async fn run(config: Config) -> Result<()> {
    let l1_client = reqwest::Client::new();

    let signer: PrivateKeySigner = config.arbitrum.signer_private_key.parse()?;
    let wallet = EthereumWallet::from(signer);
    let arb = ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_http(config.arbitrum.rpc_url.parse()?);

    let contract = IRPCDataService::new(config.arbitrum.data_service_address, arb);

    let poll_interval = Duration::from_secs(config.oracle.poll_interval_secs);
    let tx_timeout_secs = config.oracle.tx_timeout_secs;
    let mut last_hash = B256::ZERO;

    tracing::info!(
        contract = %config.arbitrum.data_service_address,
        poll_interval_secs = config.oracle.poll_interval_secs,
        "block header oracle started"
    );

    loop {
        match fetch_l1_block(&l1_client, &config.l1.rpc_url).await {
            Err(e) => {
                tracing::error!("failed to fetch L1 block: {e:#}");
            }
            Ok((hash, _)) if hash == last_hash => {
                tracing::debug!("no new block");
            }
            Ok((hash, state_root)) => {
                tracing::debug!(%hash, %state_root, "new L1 block — submitting state root");

                let submit = timeout(Duration::from_secs(tx_timeout_secs), async {
                    contract
                        .setTrustedStateRoot(hash, state_root)
                        .send()
                        .await
                        .map_err(|e| anyhow::anyhow!("send: {e}"))?
                        .watch()
                        .await
                        .map_err(|e| anyhow::anyhow!("watch: {e}"))?;
                    Ok::<(), anyhow::Error>(())
                })
                .await;

                match submit {
                    Ok(Ok(())) => {
                        last_hash = hash;
                        tracing::info!(%hash, "trusted state root updated");
                    }
                    Ok(Err(e)) => tracing::error!("setTrustedStateRoot failed: {e:#}"),
                    Err(_) => tracing::error!(
                        "setTrustedStateRoot timed out after {tx_timeout_secs}s"
                    ),
                }
            }
        }

        tokio::time::sleep(poll_interval).await;
    }
}
