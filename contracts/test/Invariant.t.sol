// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test, console2} from "forge-std/Test.sol";
import {BaseTest} from "./Base.t.sol";
import {TapMarket} from "../src/TapMarket.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

contract Handler is Test {
    bytes32 internal constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    TapMarket internal market;
    HouseVault internal vault;
    MockUSDC internal usdc;
    MockPyth internal pyth;
    address internal user;
    uint256 internal sessPk;
    address internal lp;
    uint256 internal oraclePk;

    uint256 public nonce;
    uint256 public ghostOpenLiability;
    uint256 public placedCount;
    uint256 public wonCount;
    uint256 public lostCount;

    constructor(
        TapMarket m,
        HouseVault v,
        MockUSDC u,
        MockPyth p,
        address user_,
        uint256 sessPk_,
        address lp_,
        uint256 oraclePk_
    ) {
        market = m;
        vault = v;
        usdc = u;
        pyth = p;
        user = user_;
        sessPk = sessPk_;
        lp = lp_;
        oraclePk = oraclePk_;
    }

    function _price() internal view returns (int64) {
        // zamanla salınan deterministik fiyat: 100_000$ ± 200$
        int256 phase = int256(block.timestamp % 40) - 20;
        return int64(100_000e8 + phase * 10e8);
    }

    function _tick(int64 price, uint256 tsMs)
        internal
        view
        returns (TapMarket.PriceTick memory t, bytes memory sig)
    {
        t = TapMarket.PriceTick({feedIdx: 0, price: price, timestampMs: uint64(tsMs)});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, market.tickDigest(t));
        sig = abi.encodePacked(r, s, v);
    }

    function _send(TapMarket.Tap[] memory taps, bytes[] memory sigs) internal {
        (TapMarket.PriceTick memory rt, bytes memory rs) = _tick(_price(), block.timestamp * 1000);
        market.placeBets(rt, rs, taps, sigs);
    }

    function place(uint256 bandSeed, uint256 colSeed, uint256 stakeSeed) external {
        int64 center = _price() / 10e8;
        TapMarket.Tap[] memory taps = new TapMarket.Tap[](1);
        bytes[] memory sigs = new bytes[](1);
        taps[0] = TapMarket.Tap({
            user: user,
            feedIdx: 0,
            bandIdx: center + int64(int256(bound(bandSeed, 0, 10))) - 5,
            windowIdx: uint64(block.timestamp) / 5 + uint64(bound(colSeed, 1, 11)),
            stake: uint96(bound(stakeSeed, 0.1e6, 100e6)),
            minMultBps: 0,
            nonce: ++nonce,
            deadline: uint64(block.timestamp + 10)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessPk, market.tapDigest(taps[0]));
        sigs[0] = abi.encodePacked(r, s, v);
        uint256 before = market.betsLength();
        _send(taps, sigs);
        if (market.betsLength() > before) {
            TapMarket.Bet memory b = market.getBet(before);
            ghostOpenLiability += uint256(b.stake) * b.multBps / 10_000;
            ++placedCount;
        }
    }

    function settle(uint256 idSeed, uint256 offsetSeed) external {
        uint256 n = market.betsLength();
        if (n == 0) return;
        uint256 id = bound(idSeed, 0, n - 1);
        TapMarket.Bet memory b = market.getBet(id);
        // pencere içinde, bandın içinde ya da dışında rastgele bir fiyat
        uint256 tMs = uint256(b.windowStart) * 1000 + bound(offsetSeed, 0, 4_999);
        if (tMs / 1000 > block.timestamp) vm.warp(tMs / 1000);
        int64 price = b.bandIdx * 10e8 + int64(int256(bound(offsetSeed, 0, 30e8))) - 10e8;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        (TapMarket.PriceTick memory tk, bytes memory sig) = _tick(price, tMs);
        if (market.settleWins(tk, sig, ids) == 1) {
            ghostOpenLiability -= uint256(b.stake) * b.multBps / 10_000;
            ++wonCount;
        }
    }

    function expire(uint256 idSeed) external {
        uint256 n = market.betsLength();
        if (n == 0) return;
        uint256 id = bound(idSeed, 0, n - 1);
        TapMarket.Bet memory b = market.getBet(id);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        if (market.expire(ids) == 1) {
            ghostOpenLiability -= uint256(b.stake) * b.multBps / 10_000;
            ++lostCount;
        }
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 30));
    }

    function userFlow(uint256 amt, bool dep) external {
        amt = bound(amt, 1, 500e6);
        vm.startPrank(user);
        if (dep) {
            usdc.mint(user, amt);
            usdc.approve(address(market), amt);
            market.deposit(amt);
        } else if (market.balances(user) >= amt) {
            market.withdraw(amt);
        }
        vm.stopPrank();
    }

    function lpWithdraw(uint256 amt) external {
        uint256 maxW = vault.maxWithdraw(lp);
        if (maxW == 0) return;
        vm.prank(lp);
        vault.withdraw(bound(amt, 1, maxW), lp, lp);
    }
}

contract InvariantTest is BaseTest {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(market, vault, usdc, pyth, user, sessPk, lp, oraclePk);
        vm.prank(owner);
        market.setPythMaxAge(type(uint40).max); // handler zamanı ileri sarar; sapma kontrolünü sabit push fiyatına bağla
        vm.prank(owner);
        market.setFeed(0, TapMarket.Feed({pythId: BTC, bandSize: BAND, expo: EXPO, maxDevBps: 1_000, enabled: true}));
        vm.prank(user);
        market.setSession(sessKey, type(uint96).max, uint64(block.timestamp + 365 days));
        targetContract(address(handler));
    }

    /// Kasa her zaman tüm açık bahislerin en kötü senaryo ödemesini karşılar.
    function invariant_vaultSolvent() public view {
        assertGe(usdc.balanceOf(address(vault)), vault.reserved());
    }

    /// Rezerv tam olarak açık bahislerin toplam olası ödemesine eşit.
    function invariant_reservedMatchesOpenBets() public view {
        assertEq(vault.reserved(), handler.ghostOpenLiability());
    }

    /// Market'teki USDC, kullanıcı defterinin toplamıyla birebir aynı (kullanıcı fonları kasaya sızmaz).
    function invariant_marketBacksUserBalances() public view {
        assertEq(usdc.balanceOf(address(market)), market.totalUserBalance());
    }

    function invariant_callSummary() public view {
        console2.log("placed", handler.placedCount());
        console2.log("won", handler.wonCount());
        console2.log("lost", handler.lostCount());
    }
}
