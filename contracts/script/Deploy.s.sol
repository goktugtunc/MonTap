// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";

import {TapMarket} from "../src/TapMarket.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Kullanım:
///   source ../keys.env && forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY --gas-estimate-multiplier 110
/// Env: PYTH_ADDRESS (sapma kontrolü, zorunlu), ORACLE_ADDRESS (tick imzacısı, zorunlu),
///      USDC_ADDRESS (boşsa MockUSDC deploy edilir), SEED_LIQUIDITY (6 ondalık, varsayılan 100k)
contract Deploy is Script {
    bytes32 constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant MON = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;

    function run() external {
        address pyth = vm.envAddress("PYTH_ADDRESS");
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        address usdcAddr = vm.envOr("USDC_ADDRESS", address(0));
        uint256 seed = vm.envOr("SEED_LIQUIDITY", uint256(100_000e6));

        vm.startBroadcast();
        address deployer = msg.sender;
        bool mock = usdcAddr == address(0);
        if (mock) usdcAddr = address(new MockUSDC(deployer));

        HouseVault vault = new HouseVault(IERC20(usdcAddr), deployer);
        TapMarket market = new TapMarket(IERC20(usdcAddr), vault, IPyth(pyth), deployer);
        vault.setMarket(address(market));

        // Bant ≈ tipik 5 sn hareketi: BTC $2, MON $0.000004. Sapma sınırı: BTC %1, MON %2 (testnet push ~7 sn gecikmeli)
        market.setFeed(0, TapMarket.Feed({pythId: BTC, bandSize: 2e8, expo: -8, maxDevBps: 100, enabled: true}));
        market.setFeed(1, TapMarket.Feed({pythId: MON, bandSize: 400, expo: -8, maxDevBps: 200, enabled: true}));
        market.setOracle(oracle, true);
        market.setMultipliers(0, _load("deployments/mult.BTC.json"));
        market.setMultipliers(1, _load("deployments/mult.MON.json"));

        if (seed > 0) {
            IERC20(usdcAddr).approve(address(vault), seed);
            vault.deposit(seed, deployer);
        }
        vm.stopBroadcast();

        string memory o = "deploy";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "deployedAt", block.timestamp);
        vm.serializeBool(o, "mockUsdc", mock);
        vm.serializeAddress(o, "pyth", pyth);
        vm.serializeAddress(o, "oracle", oracle);
        vm.serializeAddress(o, "usdc", usdcAddr);
        vm.serializeAddress(o, "vault", address(vault));
        string memory json = vm.serializeAddress(o, "market", address(market));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));

        console2.log("USDC  ", usdcAddr);
        console2.log("Vault ", address(vault));
        console2.log("Market", address(market));
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
