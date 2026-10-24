// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {TapMarket} from "../src/TapMarket.sol";

/// @notice Bant genişliği + çarpan tablosu güncellemesi (redeploy gerektirmez).
/// DİKKAT: açık bahis yokken çalıştır — bandSize değişimi açık bahislerin bant anlamını değiştirir.
///   MARKET=0x… forge script script/Configure.s.sol --rpc-url monad_testnet --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract Configure is Script {
    bytes32 constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant MON = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;

    function run() external {
        TapMarket market = TapMarket(vm.envAddress("MARKET"));
        vm.startBroadcast();
        // BTC $2 (~0.25 bps), MON 400 birim = $0.000004 (~1.9 bps): 5 sn'lik tipik hareket ≈ 1 bant
        market.setFeed(0, TapMarket.Feed({pythId: BTC, bandSize: 2e8, expo: -8, maxDevBps: 100, enabled: true}));
        market.setFeed(1, TapMarket.Feed({pythId: MON, bandSize: 400, expo: -8, maxDevBps: 200, enabled: true}));
        market.setMultipliers(0, _load("deployments/mult.BTC.json"));
        market.setMultipliers(1, _load("deployments/mult.MON.json"));
        vm.stopBroadcast();
    }

    function _load(string memory path) internal view returns (uint32[12][16] memory t) {
        string memory json = vm.readFile(path);
        for (uint256 d; d < 16; ++d) {
            uint256[] memory row = vm.parseJsonUintArray(json, string.concat(".table[", vm.toString(d), "]"));
            for (uint256 c; c < 12; ++c) {
                t[d][c] = uint32(row[c]);
            }
        }
    }
}
