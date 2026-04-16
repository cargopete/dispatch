import {
  encodeAbiParameters,
  keccak256,
  recoverAddress,
  toHex,
} from "viem";
import type { AttestationPayload } from "./types.js";

/**
 * Compute the attestation hash for a JSON-RPC response.
 *
 * Mirrors the Rust implementation in `crates/dispatch-service/src/attestation.rs`:
 *
 *   keccak256(abi.encode(
 *     uint64  chainId,
 *     bytes32 keccak256(utf8(method)),
 *     bytes32 keccak256(utf8(JSON.stringify(params))),
 *     bytes32 keccak256(utf8(JSON.stringify(response))),
 *     uint64  blockNumber,
 *     bytes32 blockHash,
 *   ))
 */
export function computeAttestationHash(
  payload: AttestationPayload
): `0x${string}` {
  const methodHash = keccak256(toHex(payload.method));
  const paramsHash = keccak256(toHex(JSON.stringify(payload.params)));
  const responseHash = keccak256(toHex(JSON.stringify(payload.response)));

  const encoded = encodeAbiParameters(
    [
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
    ],
    [
      BigInt(payload.chainId),
      methodHash,
      paramsHash,
      responseHash,
      payload.blockNumber,
      payload.blockHash,
    ]
  );

  return keccak256(encoded);
}

/**
 * Recover the Ethereum address that produced an attestation signature.
 *
 * The provider signs the raw `computeAttestationHash` digest — not EIP-191 prefixed.
 * Use this to verify that the response came from the expected provider address.
 */
export async function recoverAttestationSigner(
  hash: `0x${string}`,
  signature: `0x${string}`
): Promise<`0x${string}`> {
  return recoverAddress({ hash, signature });
}
