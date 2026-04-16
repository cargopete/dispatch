// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Script, console2} from "forge-std/Script.sol";
import {RPCDataService} from "../src/RPCDataService.sol";

/// @notice Register a provider (indexer) with the deployed RPCDataService and
///         start serving one or more chains.
///
/// Run once per indexer node. Can be re-run to add more chains.
///
/// Usage (Arbitrum Sepolia):
///   forge script script/Register.s.sol \
///     --rpc-url arbitrum_sepolia \
///     --broadcast \
///     -vvvv
///
/// Required env vars (see .env.example):
///   PRIVATE_KEY              — operator private key (must be authorised for the provision)
///   RPC_DATA_SERVICE_ADDRESS — deployed RPCDataService address
///   PROVIDER_ADDRESS         — on-chain service provider address
///   ENDPOINT                 — public HTTPS endpoint, e.g. https://rpc.example.com
///   GEO_HASH                 — ~4-char geohash, e.g. "u1hx" (London)
///   PAYMENTS_DESTINATION     — address that receives GRT fees (0x0 = use provider address)
///   CHAIN_IDS                — comma-separated chain IDs to serve, e.g. "1,42161"
///   CAPABILITY_TIER          — 1, 2, or 3 (default: 2)
contract Register is Script {
    function run() external {
        address service_ = vm.envAddress("RPC_DATA_SERVICE_ADDRESS");
        address provider = vm.envAddress("PROVIDER_ADDRESS");
        string memory endpoint = vm.envString("ENDPOINT");
        string memory geoHash = vm.envString("GEO_HASH");
        address paymentsDest = vm.envOr("PAYMENTS_DESTINATION", address(0));
        uint8 tier = uint8(vm.envOr("CAPABILITY_TIER", uint256(2)));

        // Parse chain IDs from comma-separated env var
        uint64[] memory chainIds = _parseChainIds(vm.envString("CHAIN_IDS"));

        RPCDataService service = RPCDataService(service_);

        vm.startBroadcast();

        // 1. Register provider (idempotent check: revert if already registered)
        if (!service.isRegistered(provider)) {
            service.register(provider, abi.encode(endpoint, geoHash, paymentsDest));
            console2.log("Registered provider:", provider);
            console2.log("  endpoint:", endpoint);
            console2.log("  geoHash:", geoHash);
            console2.log("  paymentsDestination:", paymentsDest == address(0) ? provider : paymentsDest);
        } else {
            console2.log("Provider already registered:", provider);
        }

        // 2. Start service for each chain
        for (uint256 i = 0; i < chainIds.length; i++) {
            service.startService(provider, abi.encode(chainIds[i], tier, endpoint));
            console2.log("  Started service: chain", chainIds[i], "tier", tier);
        }

        vm.stopBroadcast();

        console2.log("\nDone. Update your dispatch-service config:");
        console2.log("  [tap] data_service_address =", vm.toString(service_));
    }

    /// @dev Parse "1,42161,10" into [1, 42161, 10].
    ///      Foundry's vm.envUint does not support arrays via comma separation,
    ///      so we parse manually.
    function _parseChainIds(string memory csv) internal pure returns (uint64[] memory) {
        // Count commas to size the array
        bytes memory b = bytes(csv);
        uint256 count = 1;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == bytes1(",")) count++;
        }

        uint64[] memory ids = new uint64[](count);
        uint256 idx = 0;
        uint256 start = 0;

        for (uint256 i = 0; i <= b.length; i++) {
            if (i == b.length || b[i] == bytes1(",")) {
                ids[idx++] = uint64(_parseUint(b, start, i));
                start = i + 1;
            }
        }
        return ids;
    }

    function _parseUint(bytes memory b, uint256 from, uint256 to) internal pure returns (uint256 result) {
        for (uint256 i = from; i < to; i++) {
            uint8 c = uint8(b[i]);
            if (c == 0x20) continue; // skip spaces
            require(c >= 0x30 && c <= 0x39, "Register: non-digit in CHAIN_IDS");
            result = result * 10 + (c - 0x30);
        }
    }
}
