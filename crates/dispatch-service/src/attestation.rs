//! Response attestation — the provider signs each JSON-RPC response.
//!
//! Format (X-Drpc-Attestation header):
//!   {"signer":"0x…","signature":"0x…"}
//!
//! Message: keccak256(chain_id_be8 ‖ method_utf8 ‖ keccak256(params_json) ‖ keccak256(result_json))
//!
//! The gateway can verify this with recover_signer() from dispatch-tap — no on-chain lookup needed.
//! When slash is added later the signer address can be checked against the registered operator key.

use alloy_primitives::{keccak256, Address, B256};
use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Attestation {
    pub signer: Address,
    /// 65-byte r ‖ s ‖ v, "0x"-prefixed hex. v = rec_id + 27 (Ethereum style).
    pub signature: String,
}

/// Sign a JSON-RPC response on behalf of the provider.
pub fn sign(
    signing_key: &SigningKey,
    signer: Address,
    chain_id: u64,
    method: &str,
    params_json: &str,
    result_json: &str,
) -> anyhow::Result<Attestation> {
    let hash = message_hash(chain_id, method, params_json, result_json);
    let (sig, rec_id) = signing_key.sign_prehash_recoverable(hash.as_slice())?;
    let mut full = [0u8; 65];
    full[..64].copy_from_slice(&sig.to_bytes());
    full[64] = rec_id.to_byte() + 27; // Ethereum-style v
    Ok(Attestation {
        signer,
        signature: format!("0x{}", hex::encode(full)),
    })
}

pub fn message_hash(chain_id: u64, method: &str, params_json: &str, result_json: &str) -> B256 {
    let params_hash = keccak256(params_json.as_bytes());
    let result_hash = keccak256(result_json.as_bytes());
    let mut msg = Vec::with_capacity(8 + method.len() + 64);
    msg.extend_from_slice(&chain_id.to_be_bytes());
    msg.extend_from_slice(method.as_bytes());
    msg.extend_from_slice(params_hash.as_slice());
    msg.extend_from_slice(result_hash.as_slice());
    keccak256(&msg)
}
