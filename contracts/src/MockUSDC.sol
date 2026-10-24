// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Demo/test için 6 ondalıklı, EIP-2612 destekli USDC. Jüri faucet beklemeden oynayabilsin diye herkes basabilir.
contract MockUSDC is ERC20, ERC20Permit {
    uint256 public constant MAX_MINT = 1_000e6;

    /// @param treasury Kasayı fonlamak için 1M tUSDC alır.
    constructor(address treasury) ERC20("MonTap Test USDC", "tUSDC") ERC20Permit("MonTap Test USDC") {
        _mint(treasury, 1_000_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        require(amount <= MAX_MINT, "max 1000");
        _mint(to, amount);
    }
}
