use sqlx::Row;

use crate::{db::Pool, tap::ValidatedReceipt};

/// Persist a validated TAP receipt to PostgreSQL.
///
/// The AFTER INSERT trigger on `tap_receipts` fires a NOTIFY so the TAP agent
/// can immediately pick up the receipt for aggregation.
///
/// Returns the auto-assigned row `id`.
pub async fn insert(pool: &Pool, chain_id: u64, validated: &ValidatedReceipt) -> anyhow::Result<i64> {
    let row = sqlx::query(
        r#"
        INSERT INTO tap_receipts
            (signer_address, chain_id, timestamp_ns, nonce, value, signature, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(format!("{:?}", validated.signer))   // lowercase hex with 0x prefix
    .bind(chain_id as i64)
    .bind(validated.receipt.timestamp_ns as i64)
    .bind(validated.receipt.nonce as i64)
    .bind(validated.receipt.value.to_string()) // u128 → decimal string
    .bind(&validated.signature)
    .bind(validated.receipt.metadata.as_ref()) // &[u8]
    .fetch_one(pool)
    .await?;

    Ok(row.get("id"))
}

// ---------------------------------------------------------------------------
// Aggregator helpers
// ---------------------------------------------------------------------------

/// A raw receipt row fetched for RAV aggregation.
pub struct RawReceipt {
    pub id: i64,
    pub signer_address: String,
    pub timestamp_ns: i64,
    pub nonce: i64,
    pub value: String,         // decimal u128
    pub signature: String,
    pub metadata: Vec<u8>,
}

/// Fetch all receipts signed by `payer_hex` (e.g. "0xabc…").
/// Returns them oldest-first for deterministic ordering.
pub async fn fetch_by_payer(pool: &Pool, payer_hex: &str) -> anyhow::Result<Vec<RawReceipt>> {
    let rows = sqlx::query(
        r#"
        SELECT id, signer_address, timestamp_ns, nonce, value, signature, metadata
        FROM   tap_receipts
        WHERE  signer_address = $1
        ORDER  BY timestamp_ns ASC
        "#,
    )
    .bind(payer_hex)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| RawReceipt {
            id: r.get("id"),
            signer_address: r.get("signer_address"),
            timestamp_ns: r.get("timestamp_ns"),
            nonce: r.get("nonce"),
            value: r.get("value"),
            signature: r.get("signature"),
            metadata: r.get("metadata"),
        })
        .collect())
}

/// Return the distinct payer addresses present in tap_receipts.
pub async fn distinct_payers(pool: &Pool) -> anyhow::Result<Vec<String>> {
    let rows = sqlx::query("SELECT DISTINCT signer_address FROM tap_receipts")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| r.get("signer_address")).collect())
}

// ---------------------------------------------------------------------------
// RAV upsert
// ---------------------------------------------------------------------------

pub struct RavRow<'a> {
    pub collection_id: &'a str,
    pub payer_address: &'a str,
    pub service_provider: &'a str,
    pub data_service: &'a str,
    pub timestamp_ns: i64,
    pub value_aggregate: &'a str,
    pub signature: &'a str,
    pub last_updated: i64,
}

/// Insert or update the RAV for a given collection_id.
/// `value_aggregate` and `timestamp_ns` are always replaced with the latest values.
pub async fn upsert_rav(pool: &Pool, rav: RavRow<'_>) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO tap_ravs
            (collection_id, payer_address, service_provider, data_service,
             timestamp_ns, value_aggregate, signature, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (collection_id) DO UPDATE SET
            timestamp_ns    = EXCLUDED.timestamp_ns,
            value_aggregate = EXCLUDED.value_aggregate,
            signature       = EXCLUDED.signature,
            last_updated    = EXCLUDED.last_updated
        "#,
    )
    .bind(rav.collection_id)
    .bind(rav.payer_address)
    .bind(rav.service_provider)
    .bind(rav.data_service)
    .bind(rav.timestamp_ns)
    .bind(rav.value_aggregate)
    .bind(rav.signature)
    .bind(rav.last_updated)
    .execute(pool)
    .await?;
    Ok(())
}
