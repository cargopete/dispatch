//! On-chain RAV collection task.
//!
//! Runs on a configurable interval. For each unredeemed RAV in `tap_ravs` it:
//!   1. ABI-encodes the SignedRAV and calls RPCDataService.collect().
//!   2. Waits for the transaction to be confirmed.
//!   3. Marks the RAV as redeemed in the database.
//!
//! Enable by adding a [collector] section to config.toml.

use std::{sync::Arc, time::Duration};

use alloy::{
    network::EthereumWallet,
    providers::ProviderBuilder,
    signers::local::PrivateKeySigner,
    sol,
};
use alloy_primitives::{Address, Bytes, FixedBytes, U256};
use alloy_sol_types::SolValue;
use anyhow::Result;
use tokio::time::timeout;

use crate::{
    config::{CollectorConfig, Config},
    db::{
        receipts::{fetch_unredeemed_ravs, mark_rav_redeemed},
        Pool,
    },
};

// Minimal ABI — only collect() is needed.
sol! {
    #[sol(rpc)]
    interface IRPCDataService {
        function collect(
            address serviceProvider,
            uint8   paymentType,
            bytes   calldata data
        ) external returns (uint256 fees);
    }
}

// Mirror of IGraphTallyCollector.ReceiptAggregateVoucher / SignedRAV
// for ABI-encoding the `data` argument passed to collect().
sol! {
    struct RavData {
        bytes32 collectionId;
        address payer;
        address serviceProvider;
        address dataService;
        uint64  timestampNs;
        uint128 valueAggregate;
        bytes   metadata;
    }

    struct SignedRavData {
        RavData rav;
        bytes   signature;
    }
}

/// Spawn the collector loop. Returns immediately; runs until the process exits.
pub fn spawn(config: Arc<Config>, pool: Pool) {
    let Some(collector_cfg) = config.collector.clone() else {
        tracing::info!("no [collector] config — on-chain RAV collection disabled");
        return;
    };

    let interval = Duration::from_secs(collector_cfg.collect_interval_secs);
    tracing::info!(
        interval_secs = interval.as_secs(),
        "on-chain RAV collector started"
    );

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            if let Err(e) = run_once(&collector_cfg, &config, &pool).await {
                tracing::warn!("RAV collection cycle failed: {e:#}");
            }
        }
    });
}

async fn run_once(cfg: &CollectorConfig, config: &Config, pool: &Pool) -> Result<()> {
    let ravs = fetch_unredeemed_ravs(pool).await?;

    if ravs.is_empty() {
        tracing::debug!("no unredeemed RAVs");
        return Ok(());
    }

    let signer: PrivateKeySigner = config.indexer.operator_private_key.parse()?;
    let wallet = EthereumWallet::from(signer);
    let provider = ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_http(cfg.arbitrum_rpc_url.parse()?);

    let contract = IRPCDataService::new(config.tap.data_service_address, provider);
    let service_provider = config.indexer.service_provider_address;

    for rav in ravs {
        let value: u128 = rav.value_aggregate.parse().unwrap_or(0);

        if value < cfg.min_collect_value {
            tracing::debug!(
                collection_id = %rav.collection_id,
                value,
                min = cfg.min_collect_value,
                "RAV below minimum — skipping"
            );
            continue;
        }

        let data = match encode_collect_data(&rav.collection_id, &rav.payer_address,
                                              &rav.service_provider, &rav.data_service,
                                              rav.timestamp_ns as u64, value, &rav.signature) {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(collection_id = %rav.collection_id, "encode failed: {e:#}");
                continue;
            }
        };

        // PaymentTypes.QueryFee = 0
        let call = contract.collect(service_provider, 0u8, data);

        match timeout(Duration::from_secs(120), async {
            call.send()
                .await
                .map_err(|e| anyhow::anyhow!("send: {e}"))?
                .watch()
                .await
                .map_err(|e| anyhow::anyhow!("watch: {e}"))
        })
        .await
        {
            Ok(Ok(_)) => {
                mark_rav_redeemed(pool, &rav.collection_id).await?;
                tracing::info!(
                    collection_id = %rav.collection_id,
                    value,
                    "RAV redeemed on-chain ✓"
                );
            }
            Ok(Err(e)) => tracing::error!(collection_id = %rav.collection_id, "collect() failed: {e:#}"),
            Err(_) => tracing::error!(collection_id = %rav.collection_id, "collect() timed out"),
        }
    }

    Ok(())
}

fn encode_collect_data(
    collection_id_hex: &str,
    payer_hex: &str,
    service_provider_hex: &str,
    data_service_hex: &str,
    timestamp_ns: u64,
    value_aggregate: u128,
    signature_hex: &str,
) -> Result<Bytes> {
    let id_bytes = hex::decode(collection_id_hex.trim_start_matches("0x"))?;
    let id_arr: [u8; 32] = id_bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("collection_id must be 32 bytes"))?;

    let sig_bytes = hex::decode(signature_hex.trim_start_matches("0x"))?;

    let signed_rav = SignedRavData {
        rav: RavData {
            collectionId: FixedBytes::from(id_arr),
            payer: payer_hex.parse::<Address>()?,
            serviceProvider: service_provider_hex.parse::<Address>()?,
            dataService: data_service_hex.parse::<Address>()?,
            timestampNs: timestamp_ns,
            valueAggregate: value_aggregate,
            metadata: Bytes::default(),
        },
        signature: Bytes::from(sig_bytes),
    };

    // abi.encode(SignedRAV, uint256 tokensToCollect) — 0 = collect full amount
    let encoded = (signed_rav, U256::ZERO).abi_encode();
    Ok(Bytes::from(encoded))
}
