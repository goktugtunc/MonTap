// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {BaseTest} from "./Base.t.sol";
import {TapMarket} from "../src/TapMarket.sol";

/// Monad gas LİMİTİ üzerinden ücret aldığı için relayer/keeper limitleri bu ölçümlerden türetilir.
/// `forge test --match-contract GasTest -vv`  (network = "monad" → MIP-8 sayfa fiyatlaması dahil)
contract GasTest is BaseTest {
    int64 internal constant CENTER = 10_000;

    function _batch(uint256 n, uint256 nonce0) internal view returns (TapMarket.Tap[] memory taps, bytes[] memory sigs) {
        taps = new TapMarket.Tap[](n);
        sigs = new bytes[](n);
        uint64 w = _curWindow() + 2;
        for (uint256 i; i < n; ++i) {
            taps[i] = _tap(CENTER + int64(int256(i % 5)) - 2, w + uint64((i / 5) % 3), 1e6, nonce0 + i);
            sigs[i] = _sign(taps[i], sessPk);
        }
    }

    function _measure(uint256 n, uint256 nonce0) internal returns (uint256 g) {
        (TapMarket.Tap[] memory taps, bytes[] memory sigs) = _batch(n, nonce0);
        TapMarket.PriceTick memory t = _rt();
        bytes memory s = _rs();
        g = gasleft();
        market.placeBets(t, s, taps, sigs);
        g -= gasleft();
    }

    function test_gas_place() public {
        uint256[6] memory ns = [uint256(1), 2, 6, 20, 50, 100];
        uint256 nonce = 1;
        for (uint256 k; k < ns.length; ++k) {
            vm.warp(block.timestamp + 61); // her ölçüm yeni pencerelere → soğuk hücreler
            _pushPyth(PRICE);
            uint256 g = _measure(ns[k], nonce);
            nonce += ns[k];
            emit log_named_uint(string.concat("placeBets n=", vm.toString(ns[k])), g);
        }
    }

    function test_gas_settle_and_expire() public {
        uint64 w = _curWindow() + 2;
        for (uint256 i; i < 6; ++i) {
            _place(_tap(CENTER, w + uint64(i), 1e6, i + 1));
        }
        vm.warp(uint256(w + 6) * 5 + 20);
        uint256 g = gasleft();
        _settle(PRICE, uint256(w) * 5000 + 100, _ids(0));
        emit log_named_uint("settleWins 1 bet", g - gasleft());

        uint256[] memory ids = new uint256[](5);
        for (uint256 i; i < 5; ++i) ids[i] = i + 1;
        g = gasleft();
        market.expire(ids);
        emit log_named_uint("expire 5 bets", g - gasleft());
    }
}
