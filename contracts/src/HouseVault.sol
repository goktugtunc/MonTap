// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title HouseVault
/// @notice LP kasası. TapMarket'teki her bahsin olası en yüksek ödemesi bahis anında burada rezerve edilir.
/// @dev `totalAssets = bakiye − rezerv` (en kötü senaryo fiyatlaması): açık bahislerin riski LP pay fiyatına
///      bahis anında yansır, böylece "bilinen bir kayıptan önce çık / bilinen kayıptan sonra gir" arbitrajı işe yaramaz.
contract HouseVault is ERC4626, Ownable2Step {
    using SafeERC20 for IERC20;

    error OnlyMarket();
    error Cooldown(uint256 unlockAt);
    error CapacityExceeded();
    error MarketAlreadySet();
    error DepositForOther();
    error NonTransferable();

    event MarketSet(address market);
    event CooldownSet(uint64 seconds_);
    event MaxUtilizationSet(uint16 bps);
    event Reserved(uint256 amount, uint256 totalReserved);
    event Released(uint256 amount, uint256 totalReserved);
    event PaidOut(address to, uint256 amount);

    // --- sıcak durum: ardışık slotlar → MIP-8'de aynı sayfa ---
    address public market;
    uint64 public cooldown = 120; // en uzun pencere + grace'ten uzun
    uint16 public maxUtilizationBps = 5_000; // rezerv ≤ bakiyenin %50'si
    uint256 public reserved;

    mapping(address => uint64) public lastDepositAt;

    constructor(IERC20 asset_, address owner_)
        ERC20("MonTap LP", "mtLP")
        ERC4626(asset_)
        Ownable(owner_)
    {}

    modifier onlyMarket() {
        if (msg.sender != market) revert OnlyMarket();
        _;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Tek seferlik: market adresi sonradan değiştirilemez.
    function setMarket(address market_) external onlyOwner {
        if (market != address(0)) revert MarketAlreadySet();
        market = market_;
        emit MarketSet(market_);
    }

    function setCooldown(uint64 seconds_) external onlyOwner {
        cooldown = seconds_;
        emit CooldownSet(seconds_);
    }

    function setMaxUtilization(uint16 bps) external onlyOwner {
        require(bps <= 10_000, "bps");
        maxUtilizationBps = bps;
        emit MaxUtilizationSet(bps);
    }

    // ---------------------------------------------------------------- market hooks

    /// @notice Bu bakiye ve rezerv ile `extraReserve` kadar daha rezerve edilebilir mi?
    /// @param incoming Aynı işlemde kasaya henüz aktarılmamış stake toplamı (batch içi).
    function canReserve(uint256 extraReserve, uint256 incoming) public view returns (bool) {
        uint256 bal = IERC20(asset()).balanceOf(address(this)) + incoming;
        return (reserved + extraReserve) * 10_000 <= bal * maxUtilizationBps;
    }

    /// @notice Market'in batch başına tek çağrıda okuduğu kapasite bilgisi.
    function capacityInfo() external view returns (uint256 bal, uint256 reserved_, uint256 maxUtilBps) {
        return (IERC20(asset()).balanceOf(address(this)), reserved, maxUtilizationBps);
    }

    /// @dev Market stake'leri bu çağrıdan önce kasaya aktarmış olmalı.
    function reserve(uint256 amount) external onlyMarket {
        if (!canReserve(amount, 0)) revert CapacityExceeded();
        reserved += amount;
        emit Reserved(amount, reserved);
    }

    /// @notice Bahis kaybedildi: rezerv serbest, stake kasada kalır (LP kârı).
    function release(uint256 amount) external onlyMarket {
        reserved -= amount;
        emit Released(amount, reserved);
    }

    /// @notice Bahis kazanıldı: rezervden düş ve ödemeyi gönder.
    function payout(address to, uint256 amount) external onlyMarket {
        reserved -= amount;
        IERC20(asset()).safeTransfer(to, amount);
        emit PaidOut(to, amount);
    }

    // ---------------------------------------------------------------- ERC4626

    function totalAssets() public view override returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        return bal > reserved ? bal - reserved : 0;
    }

    /// @dev Inflation saldırısına karşı sanal paylar (6 ondalıklı USDC → 9 ondalıklı pay).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (_locked(owner_)) return 0;
        return super.maxWithdraw(owner_);
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        if (_locked(owner_)) return 0;
        return super.maxRedeem(owner_);
    }

    /// @dev Başkası adına yatırım yok: aksi halde biri kurbana toz yatırıp cooldown'unu sürekli sıfırlayabilir.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (caller != receiver) revert DepositForOther();
        lastDepositAt[receiver] = uint64(block.timestamp);
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        if (_locked(owner_)) revert Cooldown(lastDepositAt[owner_] + cooldown);
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    /// @dev LP payları transfer edilemez: cooldown transferle aşılamaz ve kimse başkasının kilidini uzatamaz.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, value);
    }

    function _locked(address owner_) internal view returns (bool) {
        return block.timestamp < uint256(lastDepositAt[owner_]) + cooldown;
    }
}
