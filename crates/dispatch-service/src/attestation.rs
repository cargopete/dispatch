//! RPC response attestation.
//!
//! An attestation is a cryptographic commitment by the indexer that it served
//! a specific response to a specific request. It is attached to every response
//! as an `X-Dispatch-Attestation` HTTP header.
//!
//! The hash commits to:
//!   - The chain being served (prevents cross-chain replay)
//!   - The RPC method (prevents method substitution)
//!   - The request parameters (binds to the exact query)
//!   - The response body (binds to what was returned)
//!   - Block context (anchors to chain state where applicable)
//!
//! For non-block-anchored methods (eth_sendRawTransaction, eth_chainId, etc.)
//! pass block_number=0 and block_hash=B256::ZERO.

use alloy_primitives::{keccak256, B256};
use alloy_sol_types::SolValue;
use k256::ecdsa::SigningKey;

use crate::error::ServiceError;

pub struct Attester {
    signing_key: SigningKey,
}

impl Attester {
    pub fn from_hex(private_key_hex: &str) -> Result<Self, ServiceError> {
        let bytes = hex::decode(private_key_hex.trim_start_matches("0x"))
            .map_err(|e| ServiceError::Internal(anyhow::anyhow!("invalid private key hex: {e}")))?;
        let signing_key = SigningKey::from_slice(&bytes)
            .map_err(|e| ServiceError::Internal(anyhow::anyhow!("invalid signing key: {e}")))?;
        Ok(Self { signing_key })
    }

    /// Produce a hex-encoded 65-byte recoverable ECDSA signature over the
    /// attestation hash for this (chain, method, params, response, block).
    pub fn attest(
        &self,
        chain_id: u64,
        method: &str,
        params_json: &[u8],
        response_json: &[u8],
        block_number: u64,
        block_hash: B256,
    ) -> Result<String, ServiceError> {
        let hash = attestation_hash(
            chain_id,
            method,
            params_json,
            response_json,
            block_number,
            block_hash,
        );

        let (sig, rec_id) = self
            .signing_key
            .sign_prehash_recoverable(hash.as_slice())
            .map_err(|e| ServiceError::Internal(anyhow::anyhow!("signing failed: {e}")))?;

        let mut bytes = [0u8; 65];
        bytes[..64].copy_from_slice(&sig.to_bytes());
        bytes[64] = rec_id.to_byte();

        Ok(format!("0x{}", hex::encode(bytes)))
    }
}

/// Compute the attestation hash (without signing).
/// Exposed for testing and future on-chain verification.
pub fn attestation_hash(
    chain_id: u64,
    method: &str,
    params_json: &[u8],
    response_json: &[u8],
    block_number: u64,
    block_hash: B256,
) -> B256 {
    let encoded = (
        chain_id,
        keccak256(method.as_bytes()),
        keccak256(params_json),
        keccak256(response_json),
        block_number,
        block_hash,
    )
        .abi_encode();

    keccak256(&encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attestation_hash_is_deterministic() {
        let h1 = attestation_hash(1, "eth_getBalance", b"[]", b"0x0", 0, B256::ZERO);
        let h2 = attestation_hash(1, "eth_getBalance", b"[]", b"0x0", 0, B256::ZERO);
        assert_eq!(h1, h2);
    }

    #[test]
    fn attestation_hash_differs_by_chain() {
        let h1 = attestation_hash(1, "eth_getBalance", b"[]", b"0x0", 0, B256::ZERO);
        let h2 = attestation_hash(42161, "eth_getBalance", b"[]", b"0x0", 0, B256::ZERO);
        assert_ne!(h1, h2);
    }

    #[test]
    fn attestation_hash_differs_by_response() {
        let h1 = attestation_hash(1, "eth_getBalance", b"[]", b"0x0", 0, B256::ZERO);
        let h2 = attestation_hash(1, "eth_getBalance", b"[]", b"0x1", 0, B256::ZERO);
        assert_ne!(h1, h2);
    }
}
