-- TAP receipts received from gateways.
-- The TAP agent reads from this table (via LISTEN/NOTIFY) to aggregate RAVs.
CREATE TABLE IF NOT EXISTS tap_receipts (
    id              BIGSERIAL PRIMARY KEY,
    signer_address  TEXT    NOT NULL,       -- recovered gateway signer
    chain_id        BIGINT  NOT NULL,       -- chain being served (EIP-155)
    timestamp_ns    BIGINT  NOT NULL,       -- receipt timestamp in nanoseconds
    nonce           BIGINT  NOT NULL,       -- random uint64 per receipt
    value           TEXT    NOT NULL,       -- payment in GRT wei (u128, stored as decimal string)
    signature       TEXT    NOT NULL,       -- hex-encoded 65-byte sig: r||s||v
    metadata        BYTEA   NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS tap_receipts_signer_chain
    ON tap_receipts (signer_address, chain_id);

CREATE INDEX IF NOT EXISTS tap_receipts_timestamp
    ON tap_receipts (timestamp_ns);

-- Notify TAP agent of new receipts so it can trigger aggregation.
CREATE OR REPLACE FUNCTION tap_receipt_notify()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        'tap_receipt_inserted',
        json_build_object(
            'signer_address', NEW.signer_address,
            'chain_id',       NEW.chain_id
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tap_receipt_inserted ON tap_receipts;
CREATE TRIGGER tap_receipt_inserted
AFTER INSERT ON tap_receipts
FOR EACH ROW EXECUTE FUNCTION tap_receipt_notify();

-- RAVs produced by the TAP agent after batch aggregation.
-- (signer_address, chain_id) is unique — each pair has one live RAV at a time.
CREATE TABLE IF NOT EXISTS tap_ravs (
    id              BIGSERIAL PRIMARY KEY,
    signer_address  TEXT    NOT NULL,
    chain_id        BIGINT  NOT NULL,
    timestamp_ns    BIGINT  NOT NULL,       -- max timestamp from aggregated receipts
    value_aggregate TEXT    NOT NULL,       -- cumulative value in GRT wei
    signature       TEXT    NOT NULL,       -- hex-encoded 65-byte sig
    redeemed        BOOLEAN NOT NULL DEFAULT FALSE,
    last_updated    BIGINT  NOT NULL,       -- unix seconds
    UNIQUE (signer_address, chain_id)
);
