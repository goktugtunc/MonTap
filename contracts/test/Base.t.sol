// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";

import {TapMarket} from "../src/TapMarket.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

abstract contract BaseTest is Test {
    bytes32 internal constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    int32 internal constant EXPO = -8;
    int64 internal constant BAND = 10e8; // $10
    int64 internal constant PRICE = 100_000e8; // band 10_000
    uint64 internal constant T0 = 1_800_000_000; // 5'in katı → pencere sınırında başla

    MockPyth internal pyth;
    MockUSDC internal usdc;
    HouseVault internal vault;
    TapMarket internal market;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal relayer = makeAddr("relayer");
    address internal user;
    uint256 internal userPk;
    address internal sessKey;
    uint256 internal sessPk;
    address internal oracle;
    uint256 internal oraclePk;
    bytes32 internal DS;

    function setUp() public virtual {
        vm.warp(T0);
        pyth = new MockPyth(60, 0);
        usdc = new MockUSDC(address(this));
        vault = new HouseVault(usdc, owner);
        market = new TapMarket(usdc, vault, IPyth(address(pyth)), owner);

        (oracle, oraclePk) = makeAddrAndKey("oracle");
        DS = market.domainSeparator();
        _pushPyth(PRICE);

        vm.startPrank(owner);
        vault.setMarket(address(market));
        market.setFeed(0, TapMarket.Feed({pythId: BTC, bandSize: BAND, expo: EXPO, maxDevBps: 100, enabled: true}));
        market.setOracle(oracle, true);
        market.setMultipliers(0, _table());
        vm.stopPrank();

        // LP: 50k
        _fund(lp, 50_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(50_000e6, lp);
        vm.stopPrank();

        (user, userPk) = makeAddrAndKey("user");
        (sessKey, sessPk) = makeAddrAndKey("session");
        _fund(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(address(market), type(uint256).max);
        market.deposit(1_000e6);
        market.setSession(sessKey, 500e6, T0 + 1 days);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ yardımcılar

    /// @dev Basit deterministik tablo: uzaklık arttıkça yükselir, zaman arttıkça düşer. min 1.05x.
    function _table() internal pure returns (uint32[12][16] memory t) {
        for (uint256 d; d < 16; ++d) {
            for (uint256 c; c < 12; ++c) {
                uint256 m = 11_000 + d * 5_000;
                uint256 off = c * 300 * (d + 1);
                t[d][c] = uint32(m > off + 10_500 ? m - off : 10_500);
            }
        }
    }

    function _fund(address to, uint256 amount) internal {
        while (amount > 0) {
            uint256 a = amount > 1_000e6 ? 1_000e6 : amount;
            usdc.mint(to, a);
            amount -= a;
        }
    }

    /// @dev Zincir üstü Pyth push fiyatını (sapma kontrolünün referansı) günceller.
    function _pushPyth(int64 price) internal {
        bytes[] memory u = new bytes[](1);
        u[0] = pyth.createPriceFeedUpdateData(
            BTC, price, 5e8, EXPO, price, 5e8, uint64(block.timestamp), uint64(block.timestamp - 1)
        );
        pyth.updatePriceFeeds(u);
    }

    function _tick(int64 price, uint256 tsMs) internal pure returns (TapMarket.PriceTick memory) {
        return TapMarket.PriceTick({feedIdx: 0, price: price, timestampMs: uint64(tsMs)});
    }

    /// @dev Harici çağrı yapmaz (cache'li domain separator) → vm.prank / expectRevert'i tüketmez.
    function _signTick(TapMarket.PriceTick memory t, uint256 pk) internal view returns (bytes memory) {
        bytes32 h = keccak256(abi.encode(keccak256("PriceTick(uint8 feedIdx,int64 price,uint64 timestampMs)"), t.feedIdx, t.price, t.timestampMs));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", DS, h)));
        return abi.encodePacked(r, s, v);
    }

    function _rt() internal view returns (TapMarket.PriceTick memory) {
        return _tick(PRICE, block.timestamp * 1000);
    }

    function _rs() internal view returns (bytes memory) {
        return _signTick(_rt(), oraclePk);
    }

    function _settle(int64 price, uint256 tsMs, uint256[] memory ids) internal returns (uint256) {
        TapMarket.PriceTick memory t = _tick(price, tsMs);
        return market.settleWins(t, _signTick(t, oraclePk), ids);
    }

    function _curWindow() internal view returns (uint64) {
        return uint64(block.timestamp) / 5;
    }

    function _tap(int64 bandIdx, uint64 windowIdx, uint96 stake, uint256 nonce)
        internal
        view
        returns (TapMarket.Tap memory)
    {
        return TapMarket.Tap({
            user: user,
            feedIdx: 0,
            bandIdx: bandIdx,
            windowIdx: windowIdx,
            stake: stake,
            minMultBps: 0,
            nonce: nonce,
            deadline: uint64(block.timestamp + 10)
        });
    }

    function _sign(TapMarket.Tap memory t, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, market.tapDigest(t));
        return abi.encodePacked(r, s, v);
    }

    function _place(TapMarket.Tap memory t) internal returns (uint256 placed) {
        TapMarket.Tap[] memory taps = new TapMarket.Tap[](1);
        bytes[] memory sigs = new bytes[](1);
        taps[0] = t;
        sigs[0] = _sign(t, sessPk);
        vm.prank(relayer);
        placed = market.placeBets(_rt(), _rs(), taps, sigs);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }
}
