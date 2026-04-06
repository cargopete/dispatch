// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {RLP} from "@openzeppelin/contracts/utils/RLP.sol";
import {Memory} from "@openzeppelin/contracts/utils/Memory.sol";
import {TrieProof} from "@openzeppelin/contracts/utils/cryptography/TrieProof.sol";

/// @title StateProofVerifier
/// @notice Verifies EIP-1186 Merkle-Patricia trie proofs (account and storage).
///
/// Usage:
///   1. Call `verifyAccount` with a trusted `stateRoot`, an `account` address,
///      and its `accountProof` from `eth_getProof`.  Returns the decoded account state.
///   2. For storage disputes, call `verifyStorage` with the account's `storageRoot`
///      (obtained from step 1), a `slot`, and the slot's `storageProof`.
library StateProofVerifier {
    using RLP for bytes;
    using RLP for Memory.Slice;

    /// @notice Decoded Ethereum account state [nonce, balance, storageRoot, codeHash].
    struct Account {
        uint256 nonce;
        uint256 balance;
        bytes32 storageRoot;
        bytes32 codeHash;
    }

    /// @notice Verify an account proof against a trusted state root.
    /// @param stateRoot  EIP-1186 state root (from a trusted block header).
    /// @param account    Ethereum address whose state is being proven.
    /// @param accountProof  Array of RLP-encoded trie nodes from `eth_getProof`.
    /// @return acc  Decoded account fields.
    function verifyAccount(bytes32 stateRoot, address account, bytes[] memory accountProof)
        internal
        pure
        returns (Account memory acc)
    {
        // Account trie key = keccak256 of the 20-byte address.
        bytes memory key = abi.encodePacked(keccak256(abi.encodePacked(account)));
        bytes memory rlpAccount = TrieProof.traverse(stateRoot, key, accountProof);
        return decodeAccount(rlpAccount);
    }

    /// @notice Verify a storage slot proof against a trusted storage root.
    /// @param storageRoot  Storage root from a verified account (via `verifyAccount`).
    /// @param slot         The 32-byte storage slot key.
    /// @param storageProof Array of RLP-encoded trie nodes from `eth_getProof`.
    /// @return value  The 32-byte storage value (zero-padded).
    function verifyStorage(bytes32 storageRoot, bytes32 slot, bytes[] memory storageProof)
        internal
        pure
        returns (bytes32 value)
    {
        // Storage trie key = keccak256 of the 32-byte slot (big-endian).
        bytes memory key = abi.encodePacked(keccak256(abi.encode(slot)));
        bytes memory rlpValue = TrieProof.traverse(storageRoot, key, storageProof);
        // Storage values are RLP-encoded scalars (uint256 → bytes32).
        return bytes32(RLP.decodeUint256(rlpValue));
    }

    /// @notice Decode a 4-field RLP-encoded Ethereum account: [nonce, balance, storageRoot, codeHash].
    /// @dev Exposed for unit-testing. Not called directly in normal usage.
    function decodeAccount(bytes memory rlpAccount) internal pure returns (Account memory acc) {
        Memory.Slice[] memory fields = rlpAccount.decodeList();
        require(fields.length == 4, "StateProofVerifier: invalid account RLP");
        acc.nonce = fields[0].readUint256();
        acc.balance = fields[1].readUint256();
        acc.storageRoot = fields[2].readBytes32();
        acc.codeHash = fields[3].readBytes32();
    }
}
