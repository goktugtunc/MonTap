// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

import {HouseVault} from "./HouseVault.sol";

/// @title TapMarket
/// @notice Fiyat bandı × zaman penceresi hücrelerine "touch" bahisleri.
///         Grid mutlak: band `[bandIdx·bandSize, (bandIdx+1)·bandSize)`, pencere `[windowIdx·W, (windowIdx+1)·W)`.
///         Pencere içinde imzalanmış herhangi bir oracle tick'i banda düşerse bahis kazanır.
/// @dev - Fiyat kaynağı: MonTap oracle'ı (CEX medyanı, ms zaman damgalı EIP-712 imzalı tick). Her tick zincir üstü
///        Pyth push fiyatından en fazla `maxDevBps` sapabilir → oracle anahtarı ele geçse bile fiyatı serbestçe uyduramaz.
///      - Çarpan zincir üstünde, aynı işlemdeki taze tick'ten hesaplanır (tablo: mesafe × kaç pencere ileride).
///      - `placeBets` izinsizdir: her tap kullanıcının session anahtarıyla imzalı, nonce'lu ve `minMultBps` korumalı.
///      - `settleWins` izinsizdir: kazanma kanıtı imzalı bir tick'tir; ödeme her zaman `bet.user`'a gider.
///      - Bahisler paketli `Bet[]` dizisinde (2 slot) → ardışık bahisler MIP-8'de aynı 128-slot sayfayı paylaşır.
contract TapMarket is EIP712, Ownable2Step, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ tipler

    uint256 public constant MAX_DIST = 15; // merkez banttan en fazla 15 band uzaklık
    uint256 public constant MAX_COLS = 12; // en fazla 12 pencere ileri (W=5 sn → 60 sn)
    /// @dev Limit sayaçları halka tamponda: dolu slotların üzerine yazmak, her hücre için yeni mapping slotu
    ///      açmaktan (MIP-8 state growth 17k) çok daha ucuz. Slot = [uint64 windowIdx | uint192 exposure];
    ///      windowIdx geçmişte kalan slot boş sayılır. Çakışan canlı hücreler limiti paylaşır (daha sıkı → güvenli).
    uint256 internal constant CELL_RING = 1024;
    uint256 internal constant WIN_RING = 16; // > MAX_COLS: aynı feed'in canlı pencereleri asla çakışmaz
    uint256 internal constant BPS = 10_000;

    enum Status {
        Open,
        Won,
        Lost
    }

    enum Reject {
        None,
        Feed,
        Deadline,
        Session,
        SpendLimit,
        BadSig,
        Nonce,
        Stake,
        Balance,
        Window,
        Mult,
        Payout,
        CellCap,
        WindowCap,
        Capacity
    }

    struct Bet {
        // slot 0
        address user;
        uint96 stake;
        // slot 1
        int64 bandIdx;
        uint40 windowStart;
        uint40 windowEnd;
        uint40 placedAt;
        uint32 multBps;
        uint8 feedIdx;
        Status status;
    }

    struct Feed {
        bytes32 pythId; // sapma kontrolü için zincir üstü Pyth feed'i
        int64 bandSize; // fiyat birimi (expo dahil), ör. expo -8 → $10 = 10e8
        int32 expo; // tick'ler bu expo ile; Pyth feed'inin expo'su da bu olmalı
        uint16 maxDevBps; // tick ile Pyth push fiyatı arasındaki izinli fark
        bool enabled;
    }

    struct PriceTick {
        uint8 feedIdx;
        int64 price;
        uint64 timestampMs;
    }

    /// @dev `resolve` için: bir tick ve onunla kanıtlanan bahisler.
    struct Proof {
        PriceTick tick;
        bytes sig;
        uint256[] betIds;
    }

    struct Session {
        address key;
        uint64 expiry;
        uint96 spendLimit;
        uint96 spent;
    }

    struct Tap {
        address user;
        uint8 feedIdx;
        int64 bandIdx;
        uint64 windowIdx;
        uint96 stake;
        uint32 minMultBps;
        uint256 nonce;
        uint64 deadline;
    }

    /// @dev Batch boyunca bellekte tutulan bağlam (stack-too-deep'ten kaçınmak ve vault okumalarını cache'lemek için).
    struct Ctx {
        uint8 feedIdx;
        bool direct;
        int64 currentBand;
        uint64 currentWindow;
        uint256 vaultBal;
        uint256 vaultReserved;
        uint256 maxUtilBps;
        uint256 batchStake;
        uint256 batchPayout;
    }

    bytes32 public constant TAP_TYPEHASH = keccak256(
        "Tap(address user,uint8 feedIdx,int64 bandIdx,uint64 windowIdx,uint96 stake,uint32 minMultBps,uint256 nonce,uint64 deadline)"
    );
    bytes32 public constant SESSION_TYPEHASH =
        keccak256("SessionGrant(address user,address sessionKey,uint96 spendLimit,uint64 expiry,uint256 nonce)");
    bytes32 public constant TICK_TYPEHASH = keccak256("PriceTick(uint8 feedIdx,int64 price,uint64 timestampMs)");
    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address user,address to,uint256 amount,uint256 nonce,uint64 deadline)");

    // ------------------------------------------------------------------ hatalar & event'ler

    error FeedDisabled();
    error BadPrice();
    error BadSignature();
    error Expired();
    error InsufficientBalance();
    error InvalidConfig();
    error BadTick();
    error PriceDeviation();

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, address to, uint256 amount);
    event SessionRegistered(address indexed user, address indexed key, uint96 spendLimit, uint64 expiry);
    event SessionRevoked(address indexed user);
    event BetPlaced(
        uint256 indexed betId,
        address indexed user,
        uint8 feedIdx,
        int64 bandIdx,
        uint40 windowStart,
        uint40 windowEnd,
        uint96 stake,
        uint32 multBps,
        uint256 nonce
    );
    event TapRejected(address indexed user, uint256 nonce, Reject reason);
    event BetWon(uint256 indexed betId, address indexed user, uint256 payout, int64 price, uint64 publishTime);
    event BetLost(uint256 indexed betId, address indexed user);
    event FeedSet(uint8 indexed feedIdx, Feed feed);
    event MultipliersSet(uint8 indexed feedIdx);
    event LimitsSet(uint96 minStake, uint96 maxStake, uint128 maxPayoutPerBet, uint128 cellCap, uint128 windowCap);
    event TimingSet(uint40 windowLen, uint40 minLead, uint40 grace, uint40 maxRefAge);
    event OracleSet(address indexed signer, bool allowed);
    event SanitySet(uint40 pythMaxAge);

    // ------------------------------------------------------------------ durum

    IERC20 public immutable usdc;
    HouseVault public immutable vault;
    IPyth public immutable pyth;

    // sıcak konfigürasyon: ardışık slotlar
    uint40 public windowLen = 5;
    uint40 public minLead = 3;
    uint40 public grace = 15;
    uint40 public maxRefAge = 3;
    uint40 public pythMaxAge = 120; // Pyth push fiyatı bundan eskiyse sapma kontrolü atlanır
    uint96 public minStake = 0.1e6;
    uint96 public maxStake = 100e6;
    uint128 public maxPayoutPerBet = 2_000e6;
    uint128 public cellCap = 5_000e6;
    uint128 public windowCap = 20_000e6;
    uint256 public totalUserBalance;

    Bet[] internal _bets;

    mapping(uint8 => Feed) public feeds;
    mapping(address => bool) public isOracle;
    mapping(uint8 => uint32[MAX_COLS][MAX_DIST + 1]) internal _mult; // [mesafe][kolon] → bps
    mapping(address => uint256) public balances;
    mapping(address => Session) public sessions;
    mapping(address => uint256) public sessionNonce;
    mapping(address => uint256) public withdrawNonce;
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;
    uint256[CELL_RING] internal _cellRing;
    uint256[WIN_RING * 4] internal _winRing; // feed 0..3

    constructor(IERC20 usdc_, HouseVault vault_, IPyth pyth_, address owner_)
        EIP712("MonTap", "1")
        Ownable(owner_)
    {
        usdc = usdc_;
        vault = vault_;
        pyth = pyth_;
        usdc_.forceApprove(address(vault_), type(uint256).max);
    }

    // ================================================================== kullanıcı bakiyesi

    function deposit(uint256 amount) external nonReentrant {
        _pullDeposit(msg.sender, msg.sender, amount);
    }

    /// @notice Gassız yatırım: relayer kullanıcının EIP-2612 permit imzasıyla çağırır.
    /// @dev permit front-run edilmiş olabilir; allowance yeterliyse devam edilir.
    function depositWithPermit(address user, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        try IERC20Permit(address(usdc)).permit(user, address(this), amount, deadline, v, r, s) {} catch {}
        _pullDeposit(user, user, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(msg.sender, msg.sender, amount);
    }

    /// @notice Gassız çekim: kullanıcının ana cüzdanı (session anahtarı değil) imzalar.
    function withdrawBySig(address user, address to, uint256 amount, uint64 deadline, bytes calldata sig)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert Expired();
        uint256 nonce = withdrawNonce[user]++;
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, user, to, amount, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(user, digest, sig)) revert BadSignature();
        _withdraw(user, to, amount);
    }

    function _pullDeposit(address from, address user, uint256 amount) internal {
        usdc.safeTransferFrom(from, address(this), amount);
        balances[user] += amount;
        totalUserBalance += amount;
        emit Deposited(user, amount);
    }

    function _withdraw(address user, address to, uint256 amount) internal {
        if (balances[user] < amount) revert InsufficientBalance();
        balances[user] -= amount;
        totalUserBalance -= amount;
        usdc.safeTransfer(to, amount);
        emit Withdrawn(user, to, amount);
    }

    // ================================================================== session

    function setSession(address key, uint96 spendLimit, uint64 expiry) external {
        _setSession(msg.sender, key, spendLimit, expiry);
    }

    /// @notice Kullanıcının tek seferlik EIP-712 izniyle session kaydı (relayer gönderir).
    function registerSession(address user, address key, uint96 spendLimit, uint64 expiry, bytes calldata sig)
        external
    {
        uint256 nonce = sessionNonce[user]++;
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(SESSION_TYPEHASH, user, key, spendLimit, expiry, nonce)));
        if (!SignatureChecker.isValidSignatureNow(user, digest, sig)) revert BadSignature();
        _setSession(user, key, spendLimit, expiry);
    }

    function revokeSession() external {
        delete sessions[msg.sender];
        emit SessionRevoked(msg.sender);
    }

    function _setSession(address user, address key, uint96 spendLimit, uint64 expiry) internal {
        if (expiry <= block.timestamp) revert Expired();
        sessions[user] = Session({key: key, expiry: expiry, spendLimit: spendLimit, spent: 0});
        emit SessionRegistered(user, key, spendLimit, expiry);
    }

    // ================================================================== bahis

    /// @notice Session imzalı tap'leri tek işlemde yerleştirir. Hatalı tap tüm batch'i düşürmez (`TapRejected`).
    /// @param ref Taze imzalı tick (≤ maxRefAge sn). Çarpanın referans fiyatı.
    function placeBets(PriceTick calldata ref, bytes calldata refSig, Tap[] calldata taps, bytes[] calldata sigs)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 placed)
    {
        require(taps.length == sigs.length, "len");
        Ctx memory c = _context(ref, refSig, false);
        for (uint256 i; i < taps.length; ++i) {
            if (_tryPlace(c, taps[i], sigs[i])) ++placed;
        }
        _commit(c);
    }

    /// @notice Relayer'sız doğrudan oyun: `tap.user == msg.sender`, imza/session gerekmez.
    function placeBetsDirect(PriceTick calldata ref, bytes calldata refSig, Tap[] calldata taps)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 placed)
    {
        Ctx memory c = _context(ref, refSig, true);
        for (uint256 i; i < taps.length; ++i) {
            if (taps[i].user != msg.sender) {
                emit TapRejected(taps[i].user, taps[i].nonce, Reject.Session);
                continue;
            }
            if (_tryPlace(c, taps[i], "")) ++placed;
        }
        _commit(c);
    }

    function _context(PriceTick calldata ref, bytes calldata refSig, bool direct) internal view returns (Ctx memory c) {
        Feed memory f = feeds[ref.feedIdx];
        if (!f.enabled) revert FeedDisabled();
        _verifyTick(f, ref, refSig);
        uint256 nowMs = block.timestamp * 1000;
        // block.timestamp saniye hassasiyetinde → +2 sn tolerans
        if (ref.timestampMs + uint256(maxRefAge) * 1000 < nowMs || ref.timestampMs > nowMs + 2000) revert BadTick();
        c.feedIdx = ref.feedIdx;
        c.direct = direct;
        c.currentBand = ref.price / f.bandSize;
        c.currentWindow = uint64(block.timestamp) / windowLen;
        (c.vaultBal, c.vaultReserved, c.maxUtilBps) = vault.capacityInfo();
    }

    function _tryPlace(Ctx memory c, Tap calldata t, bytes memory sig) internal returns (bool) {
        (Reject r, uint32 m, uint256 payout) = _check(c, t, sig);
        if (r != Reject.None) {
            emit TapRejected(t.user, t.nonce, r);
            return false;
        }
        _record(c, t, m, payout);
        return true;
    }

    function _check(Ctx memory c, Tap calldata t, bytes memory sig)
        internal
        view
        returns (Reject, uint32 m, uint256 payout)
    {
        if (t.feedIdx != c.feedIdx) return (Reject.Feed, 0, 0);
        if (t.deadline < block.timestamp) return (Reject.Deadline, 0, 0);

        if (!c.direct) {
            Session memory s = sessions[t.user];
            if (s.key == address(0) || s.expiry < block.timestamp) return (Reject.Session, 0, 0);
            if (uint256(s.spent) + t.stake > s.spendLimit) return (Reject.SpendLimit, 0, 0);
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_tapDigest(t), sig);
            if (err != ECDSA.RecoverError.NoError || signer != s.key) return (Reject.BadSig, 0, 0);
            if (_nonceUsed(t.user, t.nonce)) return (Reject.Nonce, 0, 0);
        }

        if (t.stake < minStake || t.stake > maxStake) return (Reject.Stake, 0, 0);
        if (balances[t.user] < t.stake) return (Reject.Balance, 0, 0);

        // pencere: en az minLead sn sonra başlamalı (geç bahis / gecikme arbitrajı koruması)
        uint256 start = uint256(t.windowIdx) * windowLen;
        if (start < block.timestamp + minLead) return (Reject.Window, 0, 0);
        uint256 col = t.windowIdx - c.currentWindow;
        if (col >= MAX_COLS) return (Reject.Window, 0, 0);

        int256 d = int256(t.bandIdx) - int256(c.currentBand);
        uint256 dist = uint256(d < 0 ? -d : d);
        if (dist > MAX_DIST) return (Reject.Mult, 0, 0);
        m = _mult[c.feedIdx][dist][col];
        if (m == 0 || m < t.minMultBps) return (Reject.Mult, 0, 0);

        payout = uint256(t.stake) * m / BPS;
        if (payout > maxPayoutPerBet) return (Reject.Payout, 0, 0);
        if (_ringGet(_cellRing, _cellIdx(c.feedIdx, t.bandIdx, t.windowIdx), c.currentWindow) + payout > cellCap) {
            return (Reject.CellCap, 0, 0);
        }
        if (_ringGet(_winRing, _winIdx(c.feedIdx, t.windowIdx), c.currentWindow) + payout > windowCap) {
            return (Reject.WindowCap, 0, 0);
        }
        uint256 reservedAfter = c.vaultReserved + c.batchPayout + payout;
        uint256 balAfter = c.vaultBal + c.batchStake + t.stake;
        if (reservedAfter * BPS > balAfter * c.maxUtilBps) return (Reject.Capacity, 0, 0);

        return (Reject.None, m, payout);
    }

    function _record(Ctx memory c, Tap calldata t, uint32 m, uint256 payout) internal {
        if (!c.direct) {
            sessions[t.user].spent += t.stake;
            nonceBitmap[t.user][t.nonce >> 8] |= 1 << (t.nonce & 0xff);
        }
        balances[t.user] -= t.stake;
        totalUserBalance -= t.stake;
        _ringAdd(_cellRing, _cellIdx(c.feedIdx, t.bandIdx, t.windowIdx), t.windowIdx, c.currentWindow, payout);
        _ringAdd(_winRing, _winIdx(c.feedIdx, t.windowIdx), t.windowIdx, c.currentWindow, payout);
        c.batchStake += t.stake;
        c.batchPayout += payout;

        uint40 start = uint40(uint256(t.windowIdx) * windowLen);
        uint40 end = start + windowLen;
        uint256 id = _bets.length;
        _bets.push(
            Bet({
                user: t.user,
                stake: t.stake,
                bandIdx: t.bandIdx,
                windowStart: start,
                windowEnd: end,
                placedAt: uint40(block.timestamp),
                multBps: m,
                feedIdx: c.feedIdx,
                status: Status.Open
            })
        );
        emit BetPlaced(id, t.user, c.feedIdx, t.bandIdx, start, end, t.stake, m, t.nonce);
    }

    /// @dev Batch'in stake'lerini tek transferle kasaya aktar, ödemeleri tek seferde rezerve et.
    function _commit(Ctx memory c) internal {
        if (c.batchStake == 0) return;
        usdc.safeTransfer(address(vault), c.batchStake);
        vault.reserve(c.batchPayout);
    }

    // ================================================================== settlement

    /// @notice İzinsiz kazanma kanıtı. Tek imzalı tick, pencere/band koşulunu sağlayan tüm bahisleri öder.
    /// @dev tick zamanı (ms) ∈ [windowStart, windowEnd) ve ≥ placedAt'ten sonraki saniye; uymayanlar sessizce atlanır.
    function settleWins(PriceTick calldata tick, bytes calldata sig, uint256[] calldata betIds)
        external
        nonReentrant
        returns (uint256 won)
    {
        uint256 paid;
        (won, paid) = _settleProof(tick, sig, betIds);
        _pay(paid);
    }

    /// @notice Süresi + grace geçmiş açık bahisleri kayıp olarak kapatır (izinsiz). Stake kasada kalır.
    function expire(uint256[] calldata betIds) external nonReentrant returns (uint256 lost) {
        uint256 released;
        (lost, released) = _expireIds(betIds);
        if (released > 0) vault.release(released);
    }

    /// @notice Keeper yolu: farklı tick'lerle kanıtlanan kazançlar + kayıplar tek işlemde, kasa transferi tek sefer.
    function resolve(Proof[] calldata wins, uint256[] calldata expired)
        external
        nonReentrant
        returns (uint256 won, uint256 lost)
    {
        uint256 paid;
        for (uint256 i; i < wins.length; ++i) {
            (uint256 w, uint256 p) = _settleProof(wins[i].tick, wins[i].sig, wins[i].betIds);
            won += w;
            paid += p;
        }
        _pay(paid);
        uint256 released;
        (lost, released) = _expireIds(expired);
        if (released > 0) vault.release(released);
    }

    function _settleProof(PriceTick calldata tick, bytes calldata sig, uint256[] calldata betIds)
        internal
        returns (uint256 won, uint256 paid)
    {
        int64 band = _verifiedBand(tick, sig);
        for (uint256 i; i < betIds.length; ++i) {
            uint256 amt = _trySettle(betIds[i], tick, band);
            if (amt > 0) {
                paid += amt;
                ++won;
            }
        }
    }

    function _pay(uint256 paid) internal {
        if (paid == 0) return;
        totalUserBalance += paid;
        vault.payout(address(this), paid);
    }

    function _expireIds(uint256[] calldata betIds) internal returns (uint256 lost, uint256 released) {
        for (uint256 i; i < betIds.length; ++i) {
            Bet storage b = _bets[betIds[i]];
            if (b.status != Status.Open || block.timestamp < uint256(b.windowEnd) + grace) continue;
            b.status = Status.Lost;
            released += uint256(b.stake) * b.multBps / BPS;
            ++lost;
            emit BetLost(betIds[i], b.user);
        }
    }

    function _verifiedBand(PriceTick calldata tick, bytes calldata sig) internal view returns (int64) {
        Feed memory f = feeds[tick.feedIdx];
        if (f.pythId == bytes32(0)) revert FeedDisabled();
        _verifyTick(f, tick, sig);
        return tick.price / f.bandSize;
    }

    /// @return amt Ödeme (kazanmadıysa 0).
    function _trySettle(uint256 id, PriceTick calldata tick, int64 band) internal returns (uint256 amt) {
        Bet storage b = _bets[id];
        if (b.status != Status.Open || b.feedIdx != tick.feedIdx || b.bandIdx != band) return 0;
        uint256 t = tick.timestampMs;
        if (t < uint256(b.windowStart) * 1000 || t < (uint256(b.placedAt) + 1) * 1000) return 0;
        if (t >= uint256(b.windowEnd) * 1000) return 0;

        b.status = Status.Won;
        amt = uint256(b.stake) * b.multBps / BPS;
        balances[b.user] += amt;
        emit BetWon(id, b.user, amt, tick.price, uint64(t));
    }

    // ================================================================== admin

    function setOracle(address signer, bool allowed) external onlyOwner {
        isOracle[signer] = allowed;
        emit OracleSet(signer, allowed);
    }

    function setPythMaxAge(uint40 seconds_) external onlyOwner {
        pythMaxAge = seconds_;
        emit SanitySet(seconds_);
    }

    function setFeed(uint8 feedIdx, Feed calldata f) external onlyOwner {
        if (f.bandSize <= 0 || f.pythId == bytes32(0)) revert InvalidConfig();
        feeds[feedIdx] = f;
        emit FeedSet(feedIdx, f);
    }

    /// @param table [mesafe 0..15][kolon 0..11] → çarpan (bps, 10000 = 1x). 0 = hücre kapalı.
    function setMultipliers(uint8 feedIdx, uint32[MAX_COLS][MAX_DIST + 1] calldata table) external onlyOwner {
        _mult[feedIdx] = table;
        emit MultipliersSet(feedIdx);
    }

    function setLimits(uint96 minStake_, uint96 maxStake_, uint128 maxPayout_, uint128 cellCap_, uint128 windowCap_)
        external
        onlyOwner
    {
        if (minStake_ == 0 || minStake_ > maxStake_) revert InvalidConfig();
        (minStake, maxStake, maxPayoutPerBet, cellCap, windowCap) =
            (minStake_, maxStake_, maxPayout_, cellCap_, windowCap_);
        emit LimitsSet(minStake_, maxStake_, maxPayout_, cellCap_, windowCap_);
    }

    function setTiming(uint40 windowLen_, uint40 minLead_, uint40 grace_, uint40 maxRefAge_) external onlyOwner {
        if (windowLen_ == 0 || minLead_ < 2 || maxRefAge_ == 0) revert InvalidConfig();
        (windowLen, minLead, grace, maxRefAge) = (windowLen_, minLead_, grace_, maxRefAge_);
        emit TimingSet(windowLen_, minLead_, grace_, maxRefAge_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ================================================================== view

    function betsLength() external view returns (uint256) {
        return _bets.length;
    }

    function getBet(uint256 id) external view returns (Bet memory) {
        return _bets[id];
    }

    function getBets(uint256 from, uint256 to) external view returns (Bet[] memory out) {
        if (to > _bets.length) to = _bets.length;
        if (from >= to) return out;
        out = new Bet[](to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = _bets[i];
        }
    }

    function cellExposure(uint8 feedIdx, int64 bandIdx, uint64 windowIdx) external view returns (uint256) {
        return _ringGet(_cellRing, _cellIdx(feedIdx, bandIdx, windowIdx), uint64(block.timestamp) / windowLen);
    }

    function windowExposure(uint8 feedIdx, uint64 windowIdx) external view returns (uint256) {
        return _ringGet(_winRing, _winIdx(feedIdx, windowIdx), uint64(block.timestamp) / windowLen);
    }

    function getMultipliers(uint8 feedIdx) external view returns (uint32[MAX_COLS][MAX_DIST + 1] memory) {
        return _mult[feedIdx];
    }

    function nonceUsed(address user, uint256 nonce) external view returns (bool) {
        return _nonceUsed(user, nonce);
    }

    function tapDigest(Tap calldata t) external view returns (bytes32) {
        return _tapDigest(t);
    }

    function tickDigest(PriceTick calldata t) external view returns (bytes32) {
        return _tickDigest(t);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ================================================================== internal

    /// @dev İmza + Pyth sapma kontrolü. Pyth push fiyatı `pythMaxAge`'den eskiyse sapma kontrolü atlanır.
    function _verifyTick(Feed memory f, PriceTick calldata t, bytes calldata sig) internal view {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_tickDigest(t), sig);
        if (err != ECDSA.RecoverError.NoError || !isOracle[signer] || t.price <= 0) revert BadTick();
        PythStructs.Price memory p = pyth.getPriceUnsafe(f.pythId);
        if (p.price <= 0 || p.expo != f.expo || p.publishTime + pythMaxAge < block.timestamp) return;
        uint256 diff = t.price > p.price ? uint256(int256(t.price - p.price)) : uint256(int256(p.price - t.price));
        if (diff * BPS > uint256(uint64(p.price)) * f.maxDevBps) revert PriceDeviation();
    }

    function _tickDigest(PriceTick calldata t) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TICK_TYPEHASH, t.feedIdx, t.price, t.timestampMs)));
    }

    function _tapDigest(Tap calldata t) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TAP_TYPEHASH, t.user, t.feedIdx, t.bandIdx, t.windowIdx, t.stake, t.minMultBps, t.nonce, t.deadline
                )
            )
        );
    }

    function _nonceUsed(address user, uint256 nonce) internal view returns (bool) {
        return nonceBitmap[user][nonce >> 8] & (1 << (nonce & 0xff)) != 0;
    }

    function _cellIdx(uint8 feedIdx, int64 bandIdx, uint64 windowIdx) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(feedIdx, bandIdx, windowIdx))) % CELL_RING;
    }

    function _winIdx(uint8 feedIdx, uint64 windowIdx) internal pure returns (uint256) {
        return (uint256(feedIdx) % 4) * WIN_RING + (windowIdx % WIN_RING);
    }

    function _ringGet(uint256[CELL_RING] storage ring, uint256 idx, uint64 curWindow) internal view returns (uint256) {
        uint256 v = ring[idx];
        return uint64(v >> 192) < curWindow ? 0 : uint192(v);
    }

    function _ringGet(uint256[WIN_RING * 4] storage ring, uint256 idx, uint64 curWindow) internal view returns (uint256) {
        uint256 v = ring[idx];
        return uint64(v >> 192) < curWindow ? 0 : uint192(v);
    }

    function _ringAdd(uint256[CELL_RING] storage ring, uint256 idx, uint64 windowIdx, uint64 curWindow, uint256 amt)
        internal
    {
        ring[idx] = _ringNext(ring[idx], windowIdx, curWindow, amt);
    }

    function _ringAdd(uint256[WIN_RING * 4] storage ring, uint256 idx, uint64 windowIdx, uint64 curWindow, uint256 amt)
        internal
    {
        ring[idx] = _ringNext(ring[idx], windowIdx, curWindow, amt);
    }

    function _ringNext(uint256 v, uint64 windowIdx, uint64 curWindow, uint256 amt) internal pure returns (uint256) {
        uint64 w = uint64(v >> 192);
        uint256 exp = w < curWindow ? 0 : uint192(v);
        if (windowIdx > w || w < curWindow) w = windowIdx;
        return (uint256(w) << 192) | (exp + amt);
    }
}
