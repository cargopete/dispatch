// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";

// ---------------------------------------------------------------------------
// Cross-language EIP-712 compatibility test.
//
// Verifies that dispatch-tap (Rust) and Solidity compute identical EIP-712 digests
// for the TAP Receipt struct with fixed parameters.
//
// Fixed parameters (must match crates/dispatch-tap/src/eip712.rs::eip712_hash_matches_solidity_golden):
//   domain  : name="TAP", version="1", chainId=31337,
//             verifyingContract=0x1212121212121212121212121212121212121212
//   receipt : data_service    = 0x0101010101010101010101010101010101010101
//             service_provider= 0x0202020202020202020202020202020202020202
//             timestamp_ns    = 1_000_000_000
//             nonce           = 42
//             value           = 1_000_000_000_000_000_000 (1 GRT)
//             metadata        = "" (empty)
//
// Golden hash  : 0x6a496be73e1ebc77612afedde0307b2099cc116600e590ce743771770f85d5ba
// Rust sig (privKey=1, rec_id=0):
//   r = 0x3a0757571431670524cb9d59ae653a3923f354d5bcff13a75732eab539efb8c1
//   s = 0x497e498612883c7cfd1255a3eb84f04f393f3677fee0ceb5c149a15e166fda4d
//   v = 27  (rec_id=0 → Ethereum v = 0 + 27)
// ---------------------------------------------------------------------------
contract EIP712CrossLanguageTest is Test {
    bytes32 private constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(address data_service,address service_provider,uint64 timestamp_ns,uint64 nonce,uint128 value,bytes metadata)"
    );

    // Hash independently computed by Rust dispatch-tap crate (see eip712_hash_matches_solidity_golden).
    bytes32 private constant EXPECTED_HASH = 0x6a496be73e1ebc77612afedde0307b2099cc116600e590ce743771770f85d5ba;

    // Ethereum address corresponding to private key = 1.
    address private constant EXPECTED_SIGNER = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;

    function _digest() internal pure returns (bytes32) {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("TAP"),
                keccak256("1"),
                uint256(31337),
                address(0x1212121212121212121212121212121212121212)
            )
        );

        bytes32 structHash = keccak256(
            abi.encode(
                RECEIPT_TYPEHASH,
                address(0x0101010101010101010101010101010101010101), // data_service
                address(0x0202020202020202020202020202020202020202), // service_provider
                uint64(1_000_000_000), // timestamp_ns
                uint64(42), // nonce
                uint128(1_000_000_000_000_000_000), // value
                keccak256("") // metadata (empty bytes)
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    /// Solidity computes the expected hash from fixed parameters.
    /// This anchors the golden value so both languages can assert against it.
    function test_solidity_hash_equals_golden() public {
        assertEq(_digest(), EXPECTED_HASH);
    }

    /// Rust-produced signature (dispatch-tap, privKey=1) must recover the correct signer
    /// via Solidity ecrecover. Proves Rust and Solidity agree on the hash bytes.
    function test_rust_signature_recovers_correct_signer() public {
        bytes32 r = 0x3a0757571431670524cb9d59ae653a3923f354d5bcff13a75732eab539efb8c1;
        bytes32 s = 0x497e498612883c7cfd1255a3eb84f04f393f3677fee0ceb5c149a15e166fda4d;
        uint8 v = 27; // rec_id=0 → Ethereum v = 27

        address recovered = ecrecover(_digest(), v, r, s);
        assertEq(recovered, EXPECTED_SIGNER);
    }

    /// Solidity-side self-check: vm.sign(privKey=1, digest) also recovers correctly.
    /// Ensures our digest computation is sound independently of the Rust fixture.
    function test_solidity_self_sign_recovers_correct_signer() public {
        bytes32 digest = _digest();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, digest);
        assertEq(ecrecover(digest, v, r, s), EXPECTED_SIGNER);
    }
}
