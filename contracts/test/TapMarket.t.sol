// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Vm} from "forge-std/Vm.sol";
import {BaseTest} from "./Base.t.sol";
import {TapMarket} from "../src/TapMarket.sol";
import {HouseVault} from "../src/HouseVault.sol";

contract TapMarketTest is BaseTest {
    int64 internal constant CENTER = 10_000; // PRICE / BAND

    // ================================================================== yerleştirme

    function test_place_happyPath() public {
        uint64 w = _curWindow() + 2; // start = T0+10
        uint256 reservedBefore = vault.reserved();
        assertEq(_place(_tap(CENTER + 2, w, 10e6, 1)), 1);

        TapMarket.Bet memory b = market.getBet(0);
        uint32 m = market.getMultipliers(0)[2][2];
        assertEq(b.user, user);
        assertEq(b.stake, 10e6);
        assertEq(b.multBps, m);
        assertEq(b.windowStart, w * 5);
        assertEq(b.windowEnd, w * 5 + 5);
        assertEq(b.placedAt, block.timestamp);
        assertEq(market.balances(user), 990e6);
        assertEq(usdc.balanceOf(address(vault)), 50_010e6);
        assertEq(vault.reserved() - reservedBefore, uint256(10e6) * m / 10_000);
        assertTrue(market.nonceUsed(user, 1));
        (,,, uint96 spent) = market.sessions(user);
        assertEq(spent, 10e6);
    }

    function test_place_batch_partialReject() public {
        uint64 w = _curWindow() + 2;
        TapMarket.Tap[] memory taps = new TapMarket.Tap[](3);
        bytes[] memory sigs = new bytes[](3);
        taps[0] = _tap(CENTER, w, 5e6, 1);
        taps[1] = _tap(CENTER + 1, w, 5e6, 1); // aynı nonce → red
        taps[2] = _tap(CENTER - 1, w, 5e6, 2);
        for (uint256 i; i < 3; ++i) {
            sigs[i] = _sign(taps[i], sessPk);
        }
        vm.expectEmit(true, false, false, true, address(market));
        emit TapMarket.TapRejected(user, 1, TapMarket.Reject.Nonce);
        vm.prank(relayer);
        assertEq(market.placeBets(_rt(), _rs(), taps, sigs), 2);
        assertEq(market.betsLength(), 2);
    }

    function test_reject_lateWindow() public {
        vm.warp(T0 + 3); // pencere idx+1 başlangıcı = T0+5 < T0+3+3
        _expectReject(_tap(CENTER, _curWindow() + 1, 5e6, 1), TapMarket.Reject.Window);
    }

    function test_reject_tooFarAhead() public {
        _expectReject(_tap(CENTER, _curWindow() + 12, 5e6, 1), TapMarket.Reject.Window);
    }

    function test_reject_tooFarBand() public {
        _expectReject(_tap(CENTER + 16, _curWindow() + 2, 5e6, 1), TapMarket.Reject.Mult);
    }

    function test_reject_minMult() public {
        TapMarket.Tap memory t = _tap(CENTER, _curWindow() + 2, 5e6, 1);
        t.minMultBps = 100_000;
        _expectReject(t, TapMarket.Reject.Mult);
    }

    function test_reject_badSig() public {
        TapMarket.Tap memory t = _tap(CENTER, _curWindow() + 2, 5e6, 1);
        TapMarket.Tap[] memory taps = new TapMarket.Tap[](1);
        bytes[] memory sigs = new bytes[](1);
        taps[0] = t;
        sigs[0] = _sign(t, userPk); // ana anahtar ≠ session anahtarı
        vm.expectEmit(true, false, false, true, address(market));
        emit TapMarket.TapRejected(user, 1, TapMarket.Reject.BadSig);
        market.placeBets(_rt(), _rs(), taps, sigs);
    }

    function test_reject_tamperedTap() public {
        TapMarket.Tap memory t = _tap(CENTER, _curWindow() + 2, 5e6, 1);
        bytes memory sig = _sign(t, sessPk);
        t.stake = 50e6; // relayer tutarı değiştirmeye çalışır
        TapMarket.Tap[] memory taps = new TapMarket.Tap[](1);
        bytes[] memory sigs = new bytes[](1);
        taps[0] = t;
        sigs[0] = sig;
        assertEq(market.placeBets(_rt(), _rs(), taps, sigs), 0);
    }

    function test_reject_spendLimit() public {
        _expectReject(_tap(CENTER, _curWindow() + 2, 501e6, 1), TapMarket.Reject.SpendLimit);
    }

    function test_reject_sessionExpired() public {
        vm.warp(T0 + 1 days + 1);
        _expectReject(_tap(CENTER, _curWindow() + 2, 5e6, 1), TapMarket.Reject.Session);
    }

    function test_reject_deadline() public {
        TapMarket.Tap memory t = _tap(CENTER, _curWindow() + 4, 5e6, 1);
        vm.warp(block.timestamp + 11);
        _expectReject(t, TapMarket.Reject.Deadline);
    }

    function test_reject_balance() public {
        vm.prank(user);
        market.withdraw(998e6);
        _expectReject(_tap(CENTER, _curWindow() + 2, 5e6, 1), TapMarket.Reject.Balance);
    }

    function test_reject_cellCap() public {
        vm.prank(owner);
        market.setLimits(0.1e6, 100e6, 2_000e6, 100e6, 20_000e6);
        uint64 w = _curWindow() + 2;
        assertEq(_place(_tap(CENTER, w, 80e6, 1)), 1); // 80 × 1.05 = 84 ≤ 100
        _expectReject(_tap(CENTER, w, 80e6, 2), TapMarket.Reject.CellCap);
    }

    function test_reject_capacity() public {
        vm.prank(owner);
        vault.setMaxUtilization(1); // %0.01
        _expectReject(_tap(CENTER + 5, _curWindow() + 2, 100e6, 1), TapMarket.Reject.Capacity);
    }

    function test_revert_staleTick() public {
        TapMarket.PriceTick memory t = _tick(PRICE, (block.timestamp - 4) * 1000);
        bytes memory sig = _signTick(t, oraclePk);
        vm.expectRevert(TapMarket.BadTick.selector);
        market.placeBets(t, sig, new TapMarket.Tap[](0), new bytes[](0));
    }

    function test_revert_futureTick() public {
        TapMarket.PriceTick memory t = _tick(PRICE, (block.timestamp + 3) * 1000);
        bytes memory sig = _signTick(t, oraclePk);
        vm.expectRevert(TapMarket.BadTick.selector);
        market.placeBets(t, sig, new TapMarket.Tap[](0), new bytes[](0));
    }

    function test_revert_unknownSigner() public {
        (, uint256 evilPk) = makeAddrAndKey("evil");
        TapMarket.PriceTick memory t = _rt();
        bytes memory sig = _signTick(t, evilPk);
        vm.expectRevert(TapMarket.BadTick.selector);
        market.placeBets(t, sig, new TapMarket.Tap[](0), new bytes[](0));
    }

    /// Oracle anahtarı ele geçse bile Pyth'ten %1'den fazla sapan fiyatla ne bahis açılır ne de settle edilir.
    function test_revert_deviationFromPyth() public {
        TapMarket.PriceTick memory t = _tick(PRICE * 102 / 100, block.timestamp * 1000);
        bytes memory sig = _signTick(t, oraclePk);
        vm.expectRevert(TapMarket.PriceDeviation.selector);
        market.placeBets(t, sig, new TapMarket.Tap[](0), new bytes[](0));

        _place(_tap(CENTER + 200, _curWindow() + 2, 5e6, 1)); // 200 band = %2 → zaten tablo dışı
        uint256[] memory ids = _ids(0);
        vm.expectRevert(TapMarket.PriceDeviation.selector);
        market.settleWins(t, sig, ids);
    }

    function test_deviationSkippedWhenPythStale() public {
        vm.warp(block.timestamp + 121); // push fiyatı 120 sn'den eski
        TapMarket.PriceTick memory t = _tick(PRICE * 102 / 100, block.timestamp * 1000);
        bytes memory sig = _signTick(t, oraclePk);
        market.placeBets(t, sig, new TapMarket.Tap[](0), new bytes[](0));
    }

    function test_settle_msPrecision() public {
        uint64 w = _curWindow() + 2;
        _place(_tap(CENTER, w, 10e6, 1));
        TapMarket.Bet memory b = market.getBet(0);
        vm.warp(b.windowEnd + 1);
        uint256 endMs = uint256(b.windowEnd) * 1000;
        assertEq(_settle(PRICE, endMs, _ids(0)), 0); // bitiş dahil değil
        assertEq(_settle(PRICE, uint256(b.windowStart) * 1000 - 1, _ids(0)), 0); // başlangıçtan 1 ms önce
        assertEq(_settle(PRICE, endMs - 1, _ids(0)), 1); // bitişten 1 ms önce
    }

    function test_paused() public {
        vm.prank(owner);
        market.pause();
        TapMarket.PriceTick memory t = _rt();
        bytes memory sig = _rs();
        vm.expectRevert();
        market.placeBets(t, sig, new TapMarket.Tap[](0), new bytes[](0));
    }

    function test_direct_place() public {
        TapMarket.Tap[] memory taps = new TapMarket.Tap[](1);
        taps[0] = _tap(CENTER, _curWindow() + 2, 5e6, 0);
        vm.prank(user);
        assertEq(market.placeBetsDirect(_rt(), _rs(), taps), 1);
        // başkası adına doğrudan oynanamaz
        vm.prank(relayer);
        assertEq(market.placeBetsDirect(_rt(), _rs(), taps), 0);
    }

    // ================================================================== settlement

    function test_settle_win() public {
        uint64 w = _curWindow() + 2;
        _place(_tap(CENTER + 3, w, 10e6, 1));
        TapMarket.Bet memory b = market.getBet(0);
        uint256 payout = uint256(b.stake) * b.multBps / 10_000;
        uint256 reservedBefore = vault.reserved();

        vm.warp(b.windowStart + 2);
        vm.prank(makeAddr("anyone"));
        assertEq(_settle(PRICE + 3 * BAND + 1e8, uint256(b.windowStart) * 1000 + 1500, _ids(0)), 1); // band 10_003

        assertEq(uint8(market.getBet(0).status), uint8(TapMarket.Status.Won));
        assertEq(market.balances(user), 990e6 + payout);
        assertEq(vault.reserved(), reservedBefore - payout);
        assertEq(usdc.balanceOf(address(market)), market.totalUserBalance());

        // ikinci kez ödenmez
        assertEq(_settle(PRICE + 3 * BAND + 1e8, uint256(b.windowStart) * 1000 + 1500, _ids(0)), 0);
        assertEq(market.balances(user), 990e6 + payout);
    }

    function test_settle_rules() public {
        uint64 w = _curWindow() + 2;
        _place(_tap(CENTER + 3, w, 10e6, 1));
        TapMarket.Bet memory b = market.getBet(0);
        int64 inBand = PRICE + 3 * BAND;
        vm.warp(b.windowEnd + 1);

        // pencereden önce
        assertEq(_settle(inBand, uint256(b.windowStart - 1) * 1000, _ids(0)), 0);
        // pencere bitişinde (dahil değil)
        assertEq(_settle(inBand, uint256(b.windowEnd) * 1000, _ids(0)), 0);
        // yanlış band
        assertEq(_settle(inBand + BAND, uint256(b.windowStart) * 1000, _ids(0)), 0);
        // band alt sınırı dahil, pencere başı dahil
        assertEq(_settle(inBand, uint256(b.windowStart) * 1000, _ids(0)), 1);
    }

    function test_expire() public {
        uint64 w = _curWindow() + 2;
        _place(_tap(CENTER + 5, w, 10e6, 1));
        TapMarket.Bet memory b = market.getBet(0);
        uint256 lpBefore = vault.totalAssets();

        vm.warp(uint256(b.windowEnd) + 14);
        assertEq(market.expire(_ids(0)), 0); // grace dolmadı
        vm.warp(uint256(b.windowEnd) + 15);
        assertEq(market.expire(_ids(0)), 1);
        assertEq(uint8(market.getBet(0).status), uint8(TapMarket.Status.Lost));
        assertEq(vault.totalAssets(), lpBefore + uint256(b.stake) * b.multBps / 10_000);
        assertEq(market.expire(_ids(0)), 0);

        // kaybedilmiş bahis sonradan kazandırılamaz
        assertEq(_settle(PRICE + 5 * BAND, uint256(b.windowStart) * 1000, _ids(0)), 0);
    }

    function test_resolve_batch() public {
        uint64 w = _curWindow() + 2;
        _place(_tap(CENTER, w, 10e6, 1)); // 0: w'de kazanır
        _place(_tap(CENTER + 1, w + 1, 10e6, 2)); // 1: w+1'de kazanır (başka tick)
        _place(_tap(CENTER + 9, w, 10e6, 3)); // 2: kaybeder
        vm.warp(uint256(w + 2) * 5 + 15);

        TapMarket.Proof[] memory proofs = new TapMarket.Proof[](2);
        TapMarket.PriceTick memory t0 = _tick(PRICE, uint256(w) * 5000 + 10);
        TapMarket.PriceTick memory t1 = _tick(PRICE + BAND, uint256(w + 1) * 5000 + 10);
        proofs[0] = TapMarket.Proof({tick: t0, sig: _signTick(t0, oraclePk), betIds: _ids(0)});
        proofs[1] = TapMarket.Proof({tick: t1, sig: _signTick(t1, oraclePk), betIds: _ids(1)});

        uint256 bal = market.balances(user);
        uint256 g = gasleft();
        (uint256 won, uint256 lost) = market.resolve(proofs, _ids(2));
        emit log_named_uint("resolve 2 wins + 1 loss", g - gasleft());
        assertEq(won, 2);
        assertEq(lost, 1);
        TapMarket.Bet memory b0 = market.getBet(0);
        TapMarket.Bet memory b1 = market.getBet(1);
        assertEq(market.balances(user), bal + uint256(b0.stake) * b0.multBps / 1e4 + uint256(b1.stake) * b1.multBps / 1e4);
        assertEq(vault.reserved(), 0);
        assertEq(usdc.balanceOf(address(market)), market.totalUserBalance());
    }

    /// Geçmiş pencerenin sayacı yeni pencereyi kısıtlamaz (halka tampon slotu sıfırlanır).
    function test_ring_staleReset() public {
        vm.prank(owner);
        market.setLimits(0.1e6, 100e6, 2_000e6, 100e6, 20_000e6);
        uint64 w = _curWindow() + 2;
        _place(_tap(CENTER, w, 80e6, 1));
        assertGt(market.cellExposure(0, CENTER, w), 0);
        // 14 pencere sonra aynı halka indeksine düşebilecek her hücre boş sayılmalı
        vm.warp(block.timestamp + 70);
        assertEq(market.cellExposure(0, CENTER, w), 0);
        assertEq(market.windowExposure(0, w), 0);
        assertEq(_place(_tap(CENTER, _curWindow() + 2, 80e6, 2)), 1);
    }

    // ================================================================== session / bakiye imzaları

    function test_registerSession_bySig_andReplay() public {
        (address k2,) = makeAddrAndKey("session2");
        uint64 exp = uint64(block.timestamp + 1 hours);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                market.domainSeparator(),
                keccak256(abi.encode(market.SESSION_TYPEHASH(), user, k2, uint96(50e6), exp, market.sessionNonce(user)))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        market.registerSession(user, k2, 50e6, exp, sig);
        (address key,, uint96 lim,) = market.sessions(user);
        assertEq(key, k2);
        assertEq(lim, 50e6);

        vm.expectRevert(TapMarket.BadSignature.selector);
        market.registerSession(user, k2, 50e6, exp, sig);
    }

    function test_withdrawBySig() public {
        address to = makeAddr("to");
        uint64 dl = uint64(block.timestamp + 60);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                market.domainSeparator(),
                keccak256(abi.encode(market.WITHDRAW_TYPEHASH(), user, to, uint256(100e6), uint256(0), dl))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(relayer);
        market.withdrawBySig(user, to, 100e6, dl, sig);
        assertEq(usdc.balanceOf(to), 100e6);
        assertEq(market.balances(user), 900e6);
        vm.expectRevert(TapMarket.BadSignature.selector);
        market.withdrawBySig(user, to, 100e6, dl, sig);
    }

    function test_depositWithPermit() public {
        (address u2, uint256 pk2) = makeAddrAndKey("u2");
        usdc.mint(u2, 50e6);
        uint256 dl = block.timestamp + 60;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                u2,
                address(market),
                uint256(50e6),
                usdc.nonces(u2),
                dl
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk2, digest);
        vm.prank(relayer);
        market.depositWithPermit(u2, 50e6, dl, v, r, s);
        assertEq(market.balances(u2), 50e6);
        assertEq(usdc.balanceOf(u2), 0);
    }

    // ================================================================== vault

    function test_vault_worstCasePricing() public {
        uint256 before = vault.totalAssets();
        _place(_tap(CENTER + 4, _curWindow() + 2, 10e6, 1));
        TapMarket.Bet memory b = market.getBet(0);
        uint256 payout = uint256(b.stake) * b.multBps / 10_000;
        assertEq(vault.totalAssets(), before + b.stake - payout);
    }

    function test_vault_cooldown_and_nonTransferable() public {
        assertEq(vault.maxWithdraw(lp), 0);
        vm.prank(lp);
        vm.expectRevert();
        vault.withdraw(1e6, lp, lp);

        vm.prank(lp);
        vm.expectRevert(HouseVault.NonTransferable.selector);
        vault.transfer(user, 1);

        vm.warp(block.timestamp + 121);
        vm.prank(lp);
        vault.withdraw(1_000e6, lp, lp);
        assertEq(usdc.balanceOf(lp), 1_000e6);
    }

    function test_vault_noDepositForOther() public {
        usdc.mint(relayer, 10e6);
        vm.startPrank(relayer);
        usdc.approve(address(vault), 10e6);
        vm.expectRevert(HouseVault.DepositForOther.selector);
        vault.deposit(10e6, lp);
        vm.stopPrank();
    }

    function test_vault_onlyMarket() public {
        vm.expectRevert(HouseVault.OnlyMarket.selector);
        vault.payout(user, 1);
        vm.prank(owner);
        vm.expectRevert(HouseVault.MarketAlreadySet.selector);
        vault.setMarket(user);
    }

    // ================================================================== gas (Monad: limit üzerinden ödenir)

    function test_gas_batch20() public {
        uint64 w = _curWindow() + 2;
        TapMarket.Tap[] memory taps = new TapMarket.Tap[](20);
        bytes[] memory sigs = new bytes[](20);
        for (uint256 i; i < 20; ++i) {
            taps[i] = _tap(CENTER + int64(int256(i % 7)) - 3, w + uint64(i % 4), 1e6, i + 1);
            sigs[i] = _sign(taps[i], sessPk);
        }
        vm.prank(relayer);
        uint256 g = gasleft();
        uint256 placed = market.placeBets(_rt(), _rs(), taps, sigs);
        g -= gasleft();
        assertEq(placed, 20);
        emit log_named_uint("gas for 20 taps", g);
        emit log_named_uint("gas per tap", g / 20);
    }

    // ================================================================== yardımcı

    function _expectReject(TapMarket.Tap memory t, TapMarket.Reject reason) internal {
        TapMarket.Tap[] memory taps = new TapMarket.Tap[](1);
        bytes[] memory sigs = new bytes[](1);
        taps[0] = t;
        sigs[0] = _sign(t, sessPk);
        vm.recordLogs();
        vm.prank(relayer);
        uint256 placed = market.placeBets(_rt(), _rs(), taps, sigs);
        assertEq(placed, 0, "should reject");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sel = TapMarket.TapRejected.selector;
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sel) {
                (, TapMarket.Reject got) = abi.decode(logs[i].data, (uint256, TapMarket.Reject));
                assertEq(uint8(got), uint8(reason), "reason");
                found = true;
            }
        }
        assertTrue(found, "no TapRejected");
    }
}
