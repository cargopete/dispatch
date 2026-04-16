-- Fix tap_ravs: replace chain_id with the correct RAV-centric columns.
-- (signer_address → payer_address, chain_id → service_provider + data_service + collection_id)
--
-- We are still in pre-production so no live data to preserve.
DROP TABLE IF EXISTS tap_ravs;

CREATE TABLE tap_ravs (
    id               BIGSERIAL PRIMARY KEY,
    -- keccak256(payer || service_provider || data_service) — matches on-chain collectionId
    collection_id    TEXT    NOT NULL,
    payer_address    TEXT    NOT NULL,  -- gateway signer address
    service_provider TEXT    NOT NULL,  -- indexer on-chain address
    data_service     TEXT    NOT NULL,  -- RPCDataService contract address
    timestamp_ns     BIGINT  NOT NULL,  -- max timestamp_ns from aggregated receipts
    -- cumulative total owed since the start of the payer↔provider relationship (u128 decimal)
    value_aggregate  TEXT    NOT NULL,
    signature        TEXT    NOT NULL,  -- hex-encoded 65-byte RAV signature
    redeemed         BOOLEAN NOT NULL DEFAULT FALSE,
    last_updated     BIGINT  NOT NULL,  -- unix seconds
    UNIQUE (collection_id)
);

CREATE INDEX IF NOT EXISTS tap_ravs_payer_provider
    ON tap_ravs (payer_address, service_provider);
