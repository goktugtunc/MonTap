# Monad Developer Research for MonTap (tap-trading on a price grid)

Researched 2026-10-24. Main sources: docs.monad.xyz (raw `.md` pages via `llms.txt`), the `monad-crypto/protocols` repo, docs.pyth.network, monad.xyz/blog, category.xyz/blogs and the `monad-developers/typewriter` repo. I also made live JSON-RPC calls to `rpc.monad.xyz` and `testnet-rpc.monad.xyz` on 2026-10-24.

Tags used below:
- **[VERIFIED-ONCHAIN]**: I checked it with a live RPC call (eth_getCode, eth_call or block data).
- **[DOCS]**: stated in a primary doc. The link is given.
- **[UNVERIFIED]**: inferred, from a secondary source, or not confirmed. Check it before relying on it.

---

## 0. TL;DR: key values

| Item | Mainnet | Testnet |
|---|---|---|
| Chain ID | `143` | `10143` |
| Primary RPC (QuickNode) | `https://rpc.monad.xyz` / `wss://rpc.monad.xyz` (25 rps) | `https://testnet-rpc.monad.xyz` / `wss://testnet-rpc.monad.xyz` (50 rps; 25 rps for call/estimateGas) |
| Explorers | monadvision.com, monadscan.com | testnet.monadvision.com, testnet.monadscan.com |
| Block time | 300 ms (MIP-12). [VERIFIED-ONCHAIN]: 1000 blocks took 302 s | same |
| Finality | `Finalized` 2 blocks after proposal (about 600 ms). `Verified` (state root) about 5 blocks after | same |
| Revision | `MONAD_TEN` (MIP-8 storage pages), client v0.16.5 | `MONAD_TEN`, v0.16.5 |
| Min base fee | 100 gwei (MON-gwei). [VERIFIED-ONCHAIN] `baseFeePerGas = 100000000000` | 100 gwei |
| Gas charged | **gas_limit × price**, not gas used | same |
| Pyth Core (original, upgraded in place) | `0x2880aB155794e7179c9eE2e38200202908C17B43` | `0x2880aB155794e7179c9eE2e38200202908C17B43` |
| Pyth Core Compatible ("upgraded") | `0xB754BA51E3861Ac0Cb67f73CD046dE790A36508d` | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` |
| Pyth Pro (formerly Lazer) verifier | `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` | same |
| Pyth Entropy | `0xD458261E832415CFd3BAE5E416FdF3230ce6F134` | `0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320` |
| USDC (native, Circle) | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| CCTP domain | 15 | 15 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | same |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` | same |
| EntryPoint v0.7 / v0.8 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` / `0x4337084d9e255fF0702461CF8895cE9E3b5Ff108` | same |

Every Pyth, USDC and Entropy address in this table has bytecode on its network. I checked this with `eth_getCode` on 2026-10-24 **[VERIFIED-ONCHAIN]**.

**Recommendations, in short:**
- **Build and demo on testnet (10143).** Mainnet is also cheap: 200k gas costs 0.02 MON, about $0.0005. Pyth, USDC and the AA infra are live on both networks.
- **Toolchain:** Foundry ≥ 1.8.0 with `network = "monad"`, solc `0.8.31` and `evm_version = "osaka"`.
- **Hermes now needs an API key.** Since 2026-08-26 every Hermes request returns 401 without one (I confirmed this). Get a key at https://pythdata.app/signup. The Pyth update fee is **0**.
- **Simplest popup-free stack:** a Privy (or Dynamic) embedded wallet for login, plus app-level session keys in your contract (one EIP-712 grant, then the session key signs taps), plus a backend relayer that batches taps and pays gas. Skip ERC-4337 and 7702 for the hackathon. Section 5 has the details.
- **Typewriter** (`monad-developers/typewriter`) matches the concept closely: passkeys, session keys, ms confirmations and sponsored settlement. But it is a prototype ("Not ready for production use"), and mutations **cannot call external contracts** such as Pyth. Don't build the core on it. Borrow its design.

---

## 1. Networks

### 1.1 Mainnet ([DOCS] https://docs.monad.xyz/developer-essentials/network-information)

| RPC | Provider | Rate limit | Batch limit | Notes |
|---|---|---|---|---|
| `https://rpc.monad.xyz`, `wss://rpc.monad.xyz` | QuickNode | 25 rps | 100 | |
| `https://rpc1.monad.xyz`, `wss://rpc1.monad.xyz` | Alchemy | 15 rps | 100 | `debug_`/`trace_` disabled |
| `https://rpc2.monad.xyz` | Goldsky Edge | 300 / 10 s | 10 | HTTPS only, no WS. Historical `eth_call` supported |
| `https://rpc3.monad.xyz`, `wss://rpc3.monad.xyz` | Ankr | 300 / 10 s | 10 | `debug_` disabled |
| `https://rpc-mainnet.monadinfra.com`, `wss://…` | Monad Foundation | 20 rps | 1 | Historical state supported |

- Explorers: https://monadvision.com (BlockVision) and https://monadscan.com (Etherscan). Traces: Tenderly, Phalcon. UserOps: Jiffyscan (`?network=monad`). Visualizer: https://gmonads.com
- WMON: `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`. CreateX: `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`. Foundry/EIP-7997 deterministic deployer: `0x4e59b44847b379578588920ca78fbf26c0b4956c`.
- Simple7702Account (eth-infinitism): `0xe6Cae83BdE06E4c305530e199D7217f42808555B`.

### 1.2 Testnet ([DOCS] https://docs.monad.xyz/developer-essentials/testnet)
- Testnet was **reset from genesis on 2025-12-16**. Ignore older tutorials and addresses.
- RPCs:
  - `https://testnet-rpc.monad.xyz` + `wss://` (QuickNode): 50 rps, 25 rps for `eth_call`/`eth_estimateGas`, batch 100, archive yes.
  - `https://rpc.ankr.com/monad_testnet`: 300 req/10 s and 12k/10 min, no archive.
  - `https://rpc-testnet.monadinfra.com` + `wss://`: 20 rps, no batching, archive yes.
- WMON (testnet): `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541`.
- Faucets:
  - Official: https://faucet.monad.xyz [DOCS]. The page returned HTTP 429 to my fetch, so its eligibility rules are **[UNVERIFIED]**.
  - Alchemy: https://www.alchemy.com/faucets/monad-testnet (reportedly 1 MON / 24 h) **[UNVERIFIED]**.
  - Chainstack also runs one.
  - App hub: https://testnet.monad.xyz/
- Token list: https://github.com/monad-crypto/token-list/blob/main/tokenlist-testnet.json

### 1.3 Explorers and verification endpoints ([DOCS] https://docs.monad.xyz/tooling-and-infra/block-explorers)
| Explorer | Verifier type and URL |
|---|---|
| MonadVision (main + test) | Sourcify: `https://sourcify-api-monad.blockvision.org` |
| Monadscan mainnet | Etherscan: `https://api.monadscan.com/api` |
| Monadscan testnet | Etherscan: `https://api-testnet.monadscan.com/api` |

Socialscan is **not** listed in the official docs anymore. `monad.socialscan.io` and `monad-testnet.socialscan.io` respond (HTTP 429 to curl), so they probably exist **[UNVERIFIED]**. Use MonadVision or Monadscan.

### 1.4 Which network for the hackathon?
**Testnet 10143.** You get free MON, test USDC from Circle's faucet, the same `MONAD_TEN` revision as mainnet, and Pyth on the same core address. For a "live on mainnet" story, deploy the identical contracts to 143 at the end. Gas is negligible, but the vault needs real USDC. For heavy relaying, get a dedicated RPC key: QuickNode, Alchemy, Ankr, Goldsky Edge (`https://edge.goldsky.com/standard/evm/143?key=…`), Dwellir or others. The 25 rps public limit will throttle a keeper, a relayer and the UI together.

---

## 2. Toolchain

### 2.1 Foundry ([DOCS] https://docs.monad.xyz/tooling-and-infra/toolkits/foundry)
- **Foundry v1.8.0 or later** (official `foundryup`) has first-class Monad support: gas model, opcode pricing, MIP-8 pages, 128 KB code limit, precompiles and trace decoding.
- The legacy `category-labs/foundry` fork stops at MonadNine and lacks MIP-8. **Do not use it.** Replace `anvil --monad` with `anvil --network monad`.
- Local node: `anvil --network monad --block-time 0.3`. Forking with `anvil --fork-url https://testnet-rpc.monad.xyz` picks the hardfork automatically.
- Pin a hardfork with `hardfork = "monad:MonadTen"` (default) or `--hardfork MonadNine`.

```toml
# foundry.toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.31"          # Monad Hardhat docs pin 0.8.31; Foundry docs don't pin one
evm_version = "osaka"    # "The osaka EVM target is required when compiling contracts for Monad" (Hardhat page)
network = "monad"        # Monad execution semantics for forge test/script/cast/chisel
optimizer = true
optimizer_runs = 200
via_ir = false
# verification-friendly metadata (from the Monad verify guide)
metadata = true
metadata_hash = "none"
use_literal_content = true

eth-rpc-url = "https://testnet-rpc.monad.xyz"
chain_id = 10143

[rpc_endpoints]
monad_testnet = "https://testnet-rpc.monad.xyz"
monad = "https://rpc.monad.xyz"

[etherscan]
monad_testnet = { key = "${MONADSCAN_API_KEY}", url = "https://api-testnet.monadscan.com/api", chain = 10143 }
monad = { key = "${MONADSCAN_API_KEY}", url = "https://api.monadscan.com/api", chain = 143 }
```

`evm_version = "osaka"` in foundry.toml is my inference from the Hardhat page and the "Fusaka opcodes supported" statement. The Foundry page itself only sets `network = "monad"` **[UNVERIFIED for Foundry specifically]**.

Deploy and verify:
```sh
forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --private-key $PK
# Sourcify / MonadVision (no key needed)
forge verify-contract <ADDR> src/TapVault.sol:TapVault --chain 10143 \
  --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/
# Monadscan (Etherscan-type)
forge verify-contract <ADDR> src/TapVault.sol:TapVault --chain 10143 \
  --verifier etherscan --etherscan-api-key $MONADSCAN_API_KEY --watch
```

- Template: https://github.com/monad-developers/foundry-monad (defaults to testnet).
- CI: `foundry-rs/foundry-toolchain@v1` with `version: v1.8.0` and `forge test --network monad`.
- When a forge script broadcasts many txs, Monad charges the full gas limit. Set `--gas-estimate-multiplier` low, e.g. 110, instead of the default 130 [inference].

### 2.2 Hardhat 3 ([DOCS] https://docs.monad.xyz/tooling-and-infra/toolkits/hardhat)
- Template: `git clone https://github.com/monad-developers/hardhat3-monad`. Requires Node ≥ 22.13 and Hardhat ≥ 3.1.0 for solc 0.8.31.
- Config: `solidity: { version: "0.8.31", settings: { evmVersion: "osaka" } }`. Networks: `monadTestnet` (`https://testnet-rpc.monad.xyz`, 10143) and `monadMainnet` (`https://rpc.monad.xyz`, 143).
- Verification: `sourcify.apiUrl = "https://sourcify-api-monad.blockvision.org"` plus the Monadscan Etherscan-v2 key.

### 2.3 Client libs
- `viem >= 2.40.0`. It ships `monad` and `monadTestnet` in `viem/chains`.
- `alloy-chains >= 0.2.20`.

---

## 3. Execution and gas differences vs Ethereum

Primary pages:
- https://docs.monad.xyz/developer-essentials/differences
- https://docs.monad.xyz/developer-essentials/summary
- https://docs.monad.xyz/developer-essentials/opcode-pricing

### 3.1 Gas is charged on gas LIMIT
- `fee = value + gas_price × gas_limit`. Unused gas is **not** refunded. This is a DoS defense for async execution.
- What this means for you:
  - **Hardcode gas limits** for fixed-cost calls like `placeBet` and `settle`. Measure them with `forge test --network monad --gas-report`, then add a small buffer.
  - Category Labs measured padding strategies. A static **+7.5%** gave the best failure/waste trade-off: about 1.2–2% failures and about 7–9% unused gas. Dynamic per-(to, selector) padding with a 5% fallback, clipped to 0–50%, is better still ([blog](https://www.category.xyz/blogs/setting-your-gas-limit-on-monad)).
  - MetaMask-style wallets set a **huge gas limit when `eth_estimateGas` reverts**. On Monad that burns money, so always set `gas` yourself.
- Limits:
  - Per-tx gas limit: **30M**.
  - Block gas limit: **150M** [VERIFIED-ONCHAIN].
  - Throughput: 500 Mgas/s.
  - Docs disagree on the target: the summary says 80% = 120M, but the gas-pricing formula still says "target = 160M", left over from the 200M era. Treat the 120M figure as current **[doc inconsistency]**.
- Base fee:
  - Minimum is 100 gwei. The EIP-1559-like controller increases slowly and decreases quickly (max step 1/28, β = 0.96).
  - `eth_maxPriorityFeePerGas` returns a **hardcoded 2 gwei**. I confirmed `0x77359400`.
  - `eth_feeHistory` with `latest` repeats the last base fee.
- Tx ordering: priority gas auction (descending effective gas price).
- Tx types 0, 1, 2 and 4 are supported. **Type 3 (blobs) is rejected.**

### 3.2 Reserve balance (exact rules)
[DOCS] https://docs.monad.xyz/developer-essentials/reserve-balance

- `user_reserve_balance = 10 MON` for every EOA. Execution delay is k = 3 blocks.
- **Consensus time:** for each EOA, the sum of `gas_limit × max_fee` over *inflight* txs (those included in the last k blocks) must be ≤ `min(10 MON, balance at block n−k)`. Otherwise the tx is excluded.
- **Execution time:** a tx reverts if an account's ending balance (before refunds) *dips* (decreases **and** ends) below 10 MON by more than the sender's gas spend.
  - For non-senders, such as a 7702-delegated EOA being called, the floor is `min(balance at tx start, 10 MON)`.
  - The tx is still included and still pays gas. That is why explorers show "included but reverted" txs.
- **Emptying exception** for undelegated EOAs: if the sender sent no other tx in the last k blocks and has no (un)delegation in the last k blocks, it may go below 10 MON. In practice this allows one draining tx about every 0.9–1.2 s.
- **7702-delegated EOAs cannot use the exception.** Any tx that lowers their balance below 10 MON reverts. Receiving MON, or leaving the balance unchanged, is fine. So a sponsored 7702 account holding 0 MON works.
- Precompile `0x1001` `dippedIntoReserve()` (selector `0x3a61584e`, 100 gas) must be invoked with CALL, not STATICCALL.
- **What this means for the keeper/relayer EOA:**
  - Inflight gas budget ≤ 10 MON per key. At 102 gwei × 300k gas = 0.0306 MON per tx, that is about **326 txs per 3 blocks per key**. That's plenty, but keep each relayer key funded with **> 10 MON**.
  - Rotate several keys if you exceed that.
  - Contracts (the vault) are not EOAs, so reserve-balance rules do not apply to them.

### 3.3 VM differences
- Contract code size limit **128 KB**; initcode limit **256 KB**.
- **Memory:** expansion cost is linear (`w/2` gas per word instead of `3w + w²/512`). Memory is capped at **8 MB per tx**, shared across call frames. Exceeding the cap acts like out-of-gas for that frame.
- **Cold access repricing:**
  - Account access: 2,600 → **10,100**. Affects BALANCE, EXT*, *CALL, SELFDESTRUCT.
  - Storage: 2,100 per slot → **8,100 per 128-slot page**.
  - Warm access is 100 in both cases.
- Precompile repricing:
  - ecRecover: 6000
  - ecAdd: 300
  - ecMul: 30,000
  - ecPairing: 225k + 170k per point
  - blake2f: 2 × rounds
  - point_eval: 200k
- Opcodes as of Fusaka/Osaka are supported, including CLZ (EIP-7939). EIP-2935 (historical block hashes) is on.

### 3.4 MIP-8 storage pages (live on mainnet since 2026-09-02, timestamp 1788359400)
- `page = slot >> 7`, i.e. 128 consecutive slots. Warmth is tracked per (account, page) per tx.
- **SLOAD:** 8,100 on the first touch of a page, then 100.
- **SSTORE components:**
  - base: 100
  - page load: 8,000 on the first access to the page
  - page write: 2,800 on the first value-changing write to the page
  - state growth: **17,000** each time the page's net non-zero slot count reaches a new high within the tx
  - Ethereum's 20k/2.9k schedule does not apply.
- Cost examples:
  - Fresh slot, first touch of its page: 27,900
  - Fresh slot in a page already written: 17,100
  - Overwrite in a page already written: 100
- An access list entry warms its entire page.
- **Layout rules for MonTap:**
  1. **Don't use `mapping(uint256 => Bet)` for sequential bet IDs.** Each key hashes to its own page, so every new bet pays a fresh 8,100 + 2,800 + 17k×slots.
  2. Use a **dynamic array `Bet[] bets`** with packed 2-slot structs instead. Elements are consecutive, so about 64 bets share a page, and a batch of N taps in one tx pays the page load and write cost once.
  3. Hot config (Pyth address, feed IDs, caps, totals, `reservedLiability`) belongs in **consecutive top-level state variables** so they share page 0 (one cold load, 8,100 total).
  4. Per-cell or per-window exposure: store it in a struct array indexed by `(windowId % N)` rather than a nested mapping, or accept the per-key page cost.
  5. Per-user mappings (session keys, balances) cost one page each per user. That is unavoidable but fine, and struct fields under one key share a page.
  6. Minimize *net new* slots. State growth (17k) dominates. Pack `Bet` into 2 slots, e.g. slot0 = `address user | uint96 stake` and slot1 = `int64 level | uint40 start | uint40 end | uint32 multBps | uint8 feed | uint8 dir | uint8 status`.

```solidity
struct Bet {               // 2 slots
    address user;          // 20
    uint96  stake;         // 12  (USDC 6 decimals -> plenty)
    int64   level;         // Pyth price units (expo of the feed)
    uint40  windowStart;   // unix seconds
    uint40  windowEnd;
    uint32  multBps;       // 10000 = 1x
    uint8   feedIdx;
    uint8   dir;           // 0 = touch-from-below (up), 1 = touch-from-above (down)
    uint8   status;        // 0 open, 1 won, 2 lost, 3 refunded
}
Bet[] public bets;        // consecutive slots -> shared 128-slot pages
```

### 3.5 Precompiles ([DOCS] https://docs.monad.xyz/developer-essentials/precompiles)
- `0x01`–`0x11`: all Fusaka Ethereum precompiles, including BLS12-381.
- **`0x0100` P256VERIFY** (EIP-7951, same interface as RIP-7212): 160-byte input `hash|r|s|qx|qy`, returns 32-byte `1` on success, **6,900 gas**. Use it for passkey or WebAuthn session-key signatures.
- `0x1000`: staking.
- `0x1001`: reserve balance (see 3.2).

### 3.6 Mempool, blocks, finality, timestamps
- **No global mempool.**
  - The RPC node forwards the tx to the next N = 3 leaders and retries up to K = 3 times ([DOCS](https://docs.monad.xyz/monad-arch/consensus/local-mempool)).
  - `newPendingTransactions` is not supported.
  - `eth_getTransactionByHash` returns `null` until the tx is included.
  - The `pending` tag behaves like `latest`.
- **Block states:**
  - `Proposed` (= `latest`, speculatively executed)
  - `Voted` (= `safe`, T+1)
  - `Finalized` (= `finalized`, T+2, about 600 ms, irreversible)
  - `Verified` (state root, T+5)
  - Receipts appear at `Proposed`.
  - Docs guidance: update the UI on Proposed and credit value on Finalized. Wait for Verified only for off-chain financial logic such as bridges.
- **`block.timestamp` is in seconds.** With 300 ms blocks, **3–4 consecutive blocks share a timestamp**. There is no millisecond timestamp in the header [VERIFIED-ONCHAIN: header fields are the standard ones].
  - Never use `block.timestamp` for sub-second ordering. Use `block.number` (about 300 ms per tick) or the oracle's publish time.
- **Realtime receipts:** `eth_sendRawTransactionSync` (EIP-7966) is supported.
  - Params: `[signedTx, timeout_ms]`. Returns the full receipt once the tx is in a `Proposed` block.
  - It is event-driven and only available on nodes with execution events enabled.
  - Both public endpoints recognize it [VERIFIED-ONCHAIN: they returned "transaction is not ready to be processed" for junk input rather than "method not supported"].
  - viem exposes `sendRawTransactionSync` and `sendTransactionSync` in recent 2.x versions **[UNVERIFIED exact version]**.
- **Async validation:** `eth_sendRawTransaction` may accept txs with nonce gaps or insufficient balance, because the RPC may lag state. You get no early rejection, so manage nonces locally.
- **Other RPC notes:**
  - `eth_call`/`estimateGas` gas caps: 200M (QuickNode, Alchemy, MF) or 1B (Ankr).
  - Calls ≤ 8.1M gas go to the fast pool; larger calls go to a slow pool with limited concurrency.
  - `eth_getLogs` ranges are tiny: **100 blocks** on QuickNode/MF, 1,000 on Alchemy/Ankr. 100 blocks is only 30 s of chain.
  - `debug_trace*` requires an explicit options object (`{}`), and its default tracer is `callTracer`.
  - Historical state is not on full nodes. For old-block `eth_call`, use `rpc-mainnet.monadinfra.com` or `rpc2`.
  - `eth_simulateV1` exists but is gated by a node flag.

---

## 4. Oracles

### 4.1 Pyth on Monad
Sources:
- https://docs.monad.xyz/tooling-and-infra/oracles
- https://github.com/monad-crypto/protocols/blob/main/mainnet/pyth.jsonc
- https://docs.pyth.network/llms-price-feeds-core.txt
- https://docs.pyth.network/pro/pyth-core-upgrade.mdx

**The 2026-08-26 Pyth Core upgrade (important):**
- Pyth Core now sources prices from the Pyth Pro (ex-Lazer) router architecture, with higher frequency and lower latency.
- The contract interface is unchanged. Both the original contract (upgraded in place) and the "Pyth Core Compatible" contract work.
- **Hermes requires an API key** on every request: `Authorization: Bearer $PYTH_API_KEY`, or `accessToken` in `HermesClient`. Without it you get HTTP 401 [VERIFIED].
  - Endpoints: `https://hermes.pyth.network` or the drop-in `https://pyth.dourolabs.app/hermes`.
  - Sign up at https://pythdata.app/signup (free trial, then paid). **Keep the key server-side.**
- **Update fee = 0** on all chains (OP-PIP-128). `getUpdateFee()` still works and returns 0; passing `msg.value = 0` is fine.

**Addresses:**

| | Mainnet 143 | Testnet 10143 |
|---|---|---|
| Pyth Core (original) | `0x2880aB155794e7179c9eE2e38200202908C17B43` | `0x2880aB155794e7179c9eE2e38200202908C17B43` |
| Pyth Core Compatible (Pyth recommends for new integrations per protocols repo) | `0xB754BA51E3861Ac0Cb67f73CD046dE790A36508d` | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` |
| Pyth Pro verifier | `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` | same |
| Entropy | `0xD458261E832415CFd3BAE5E416FdF3230ce6F134` | `0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320` |

- All have code [VERIFIED-ONCHAIN].
- The Pyth Pro doc lists Pro only on Base, Ethereal, Polynomial and Soneium. But bytecode exists at `0xACeA…` on Monad, and the protocols repo lists it, so Pro on Monad is **[partially verified]**: code is present, but the signer config is untested.
- Old beta contract `0xad2B52D2af1a9bD5c561894Cdd84f7505e1CD0B5` no longer serves MON/USD. Don't use it.

**Feed IDs** (same on all chains):

| Feed | ID |
|---|---|
| BTC/USD | `0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43` |
| ETH/USD | `0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace` |
| SOL/USD | `0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` |
| MON/USD | `0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1` |
| USDC/USD | `0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a` |

Pyth Pro uses numeric IDs: BTC = 1, ETH = 2, SOL = 5.

**Sponsored push feeds on Monad mainnet:**
- BTC, ETH, SOL and MON are "premium": 0.02% deviation, 1 h heartbeat. 60 feeds in total.
- Observed on 2026-10-24 via `getPriceUnsafe(BTC)`:
  - Compatible contract: publishTime 1 s behind head.
  - Original contract: about 8 s behind head.
  - [VERIFIED-ONCHAIN]
- Good enough for **display**, but don't rely on push cadence for settlement.

**Pull flow** (one tx):
```solidity
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
// 1) latest price (e.g. for opening checks)
uint fee = pyth.getUpdateFee(updateData);                 // 0 now
pyth.updatePriceFeeds{value: fee}(updateData);
PythStructs.Price memory p = pyth.getPriceNoOlderThan(feedId, 5); // seconds
// 2) settlement against a TIME WINDOW (no storage write, verifies signature):
PythStructs.PriceFeed[] memory f = pyth.parsePriceFeedUpdates{value: fee}(
    updateData, ids, uint64(windowStart), uint64(windowEnd));   // reverts if publishTime outside [min,max]
```
- `Price` = `{int64 price, uint64 conf, int32 expo, uint publishTime}`. `publishTime` is in **seconds** in Core.
- Hermes endpoints:
  - Latest: `GET /v2/updates/price/latest?ids[]=…`
  - Stream: `GET /v2/updates/price/stream?ids[]=…` (SSE, auto-closes after 24 h, so reconnect)
  - Historical (for delayed settlement): `GET /v2/updates/price/{publish_time}?ids[]=…`
- Latency: Pythnet aggregation is about 400 ms. After the upgrade, Core updates are "higher-frequency" (no exact figure). Pyth Pro channels: `real_time` (≤ 50 ms), `fixed_rate@50ms`, `@200ms`, `@1000ms`, with microsecond `timestampUs`.
- Pyth Pro requires a paid token from a data distributor (https://pyth.network/pro). Probably not worth it for a hackathon.
- Error selectors:
  - `StalePrice`: 0x19abf40e
  - `PriceFeedNotFound`: 0x14aebe68
  - `InsufficientFee`: 0x025dbdd4

### 4.2 Alternatives on Monad ([DOCS] oracles page + protocols repo)

**Chainlink**
- Data Streams (pull, low latency, needs a Chainlink access agreement):
  - Router `0x33566fE5976AAa420F3d5C64996641Fc3858CaDB`
  - VerifierProxy `0xEd813D895457907399E41D36Ec0bE103E32148c8` (mainnet)
- Push feeds:
  - BTC/USD proxy `0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546`
  - ETH/USD proxy `0x1B1414782B859871781bA3E4B0979b9ca57A0A04`
  - MON/USD proxy `0xBcD78f76005B7515837af6b50c7C52BCf73822fb`
  - Push feeds are too slow for touch options.

**Stork**
- Pull, sub-second. Contract `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` on mainnet and testnet.
- Asset IDs:
  - BTCUSD `0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de`
  - ETHUSD `0x59102b37de83bdda9f38ac8254e596f0d9ac61d2035c07936675e87342817160`
  - MONUSD `0xa4f6b07ae0c89e3f3cc03c1badcc3e9adffdf7206bafcd56d142979800887385`
  - SOLUSD `0x1dcd89dfded9e8a9b0fa1745a8ebbacbb7c81e33d5abc81616633206d932e837`
- The API needs a key from Stork **[UNVERIFIED terms]**.

**RedStone**
- Push feeds: BTC `0xED2B1ca5D7E246f615c2291De309643D41FeC97e`, ETH `0xc44be6D00307c3565FDf753e852Fc003036cBc13`, MON `0x1C9582E87eD6E99bc23EC0e6Eb52eE9d7C0D6bcd`. Pull model also available. Testnet push feeds use 0.5% deviation / 6 h heartbeat, so they're unusable for this product.

**Supra**
- Pull and push. Testnet pull `0xF8522B7fcE37439b98A2be282d413A44269028bE`. **Chronicle** also has push feeds.

**Verdict:** Pyth Core via Hermes (with API key) is the simplest path that gives verifiable per-second prices with timestamps. Stork is the backup if you hit Hermes quota limits.

---

## 5. Account abstraction and popup-free UX

### 5.1 EIP-7702 ([DOCS] https://docs.monad.xyz/developer-essentials/eip-7702)
- Fully supported (type `0x04`). Delegation code is `0xef0100 || addr`. Clear it by delegating to `address(0)`.
- **Monad caveats:**
  1. A delegated EOA can't have its balance *lowered below 10 MON* (see 3.2). If your users hold **USDC, not MON**, this is irrelevant. Sponsored flows with 0 MON work.
  2. `CREATE`/`CREATE2` are banned inside delegated-code frames.
  3. Pointing to a Monad precompile reverts.

### 5.2 ERC-4337 bundlers and paymasters ([DOCS] https://docs.monad.xyz/tooling-and-infra/wallet-infra/account-abstraction)
- Mainnet (supported): Alchemy (Gas Manager + Bundler), Biconomy (MEE), Pimlico, Sequence (relayer), thirdweb, ZeroDev. FastLane (shMonad bundler) is marked "unknown" on mainnet.
- Testnet: Alchemy, Biconomy, FastLane, Gelato, Openfort, Pimlico, Sequence, thirdweb, ZeroDev.
- EntryPoints v0.6, v0.7, v0.8 and v0.9 are canonical (addresses in section 0 and on the network page).
- Gotcha: with gas-limit charging, bundlers that over-pad `callGasLimit`/`verificationGasLimit` cost the paymaster real money. Set limits explicitly where possible [inference].

### 5.3 Embedded wallets on Monad ([DOCS] https://docs.monad.xyz/tooling-and-infra/wallet-infra/embedded-wallets)
- Listed for mainnet:
  - Alchemy Account Kit
  - Coinbase CDP Embedded Wallets
  - Crossmint
  - Cubist
  - Dynamic (TEE / TSS-MPC)
  - Fordefi
  - **Mera** (Category Labs; passkey-derived EOAs, no server)
  - MetaMask Embedded Wallet (has a Monad quickstart)
  - Openfort
  - Para (policy engine for sessions)
  - Portal
  - **Privy** (TEE+SSS, server wallets, delegated actions)
  - Reown AppKit
  - Sequence (Smart Sessions)
  - thirdweb
  - Turnkey (policy engine, delegated access)
- Session-key implementations that exist: ZeroDev Kernel permissions/session keys, Biconomy Smart Sessions, Alchemy Modular Account session keys, thirdweb session keys, Sequence Smart Sessions, Privy server-delegated actions/session signers, Para policies. Each is from that vendor's docs, not separately verified on Monad **[UNVERIFIED per-vendor on Monad]**.

### 5.4 Recommended hackathon stack (simplest that works)
**Option A (recommended): app-level session keys plus your own relayer, no 4337 dependency.**
1. Login: **Privy** embedded wallet (email/Google) gives the user an EOA. Dynamic, thirdweb or Mera are equivalent.
2. One signature at session start, which can be invisible with embedded wallets:
   - The frontend generates an ephemeral keypair. Use secp256k1, or a non-extractable WebCrypto P-256 key verified via `0x0100`.
   - The user's wallet signs an EIP-712 `SessionGrant{user, sessionKey, maxStakePerBet, maxTotalStake, expiry, nonce}`.
3. Funding: a USDC `permit` (EIP-2612; native Circle USDC supports it) plus `depositWithPermit`, submitted by the relayer. That makes it gasless too.
4. Each tap: the session key signs an EIP-712 `Tap{cellId/level/window, stake, nonce, deadline}` with no popup. The backend validates it, shows it as pending in the UI, and batches taps every 300 ms into `placeBets(Tap[], sigs[])` sent with `eth_sendRawTransactionSync`. You get a receipt in about 300–600 ms.
5. The contract verifies the grant (cache the session key on-chain after the first use), enforces limits and records bets.

Why A:
- It's the fewest vendors (just the login SDK).
- MON reserve rules never touch users.
- Gas cost is one tx per batch.
- It's the same architecture Typewriter uses, minus the prototype risk.

**Option B:** 7702 smart EOA (ZeroDev Kernel or Alchemy MA v2) plus a paymaster plus vendor session keys. More "standard", but you get UserOp latency from bundler polling, more gas, and vendor-specific permission plumbing.

**Option C:** Typewriter (section 6). Not recommended as the base.

---

## 6. Typewriter and Monad Private Settlement

### 6.1 Typewriter (announced 2026-10-08)
Sources:
- https://monad.xyz/blog/introducing-typewriter
- https://github.com/monad-developers/typewriter (MIT, TypeScript + Solidity, last push 2026-10-23, 6 stars)

**What it is:** a framework for apps that need custom sequencing, fast confirmations and built-in gas sponsorship. You write state and "mutations" in Solidity, inheriting `typewriter/Typewriter.sol`. A server built with `createTypewriter(...)`:
- receives user-signed mutations
- orders them (`fifo`, or `batch` with `batchIntervalMs` and a `batchOrder`)
- executes them locally in revm against its copy of state
- answers `accepted` in **single-digit ms**
- submits batches on-chain every `submitIntervalMs`, e.g. 300

Mutation lifecycle: received → accepted → included → safe → finalized.

**Other details:**
- State is persisted in Postgres.
- Reorg handling is Ponder-inspired.
- Accounts are native: a bytes32 ID with multiple credentials (P256, WebAuthnP256 or secp256k1), a per-credential mutation-permission bitset, expiry, and 2-D nonces (uint192 lane + uint64 seq). Signatures use EIP-712 domain `{name:"Typewriter",version:"1"}`.
- Only the `SCHEDULER` address can submit. Users can bypass via `enqueue()`, then `forceExecute()` after `FORCE_INCLUSION_DELAY` (example value 658; the unit is not stated).
- Examples: https://github.com/monad-exp/order-book (`apps/token`, `apps/order-book` with WebAuthn bootstrap and session keys).

**Maturity:** "under active development. Not ready for production use… not audited". The blog calls it a "prototype".

**Fit for MonTap, and blockers:**
- **Mutations cannot call arbitrary external contracts.** That rules out calling Pyth `parsePriceFeedUpdates` inside a mutation.
- Block-dependent values (`block.timestamp`) may differ between local and on-chain execution. Touch windows depend on time.
- It is only a hackathon fit if you keep oracle settlement in a separate non-Typewriter contract.

**Verdict:** worth citing ("Typewriter-style sequencing") and borrowing its account and session-key design, but don't depend on it.

### 6.2 Monad Private Settlement (announced 2026-10-06)
Source: https://monad.xyz/blog/monad-private-settlement

Encrypted "domains" (tx, state and code encrypted) enabled by a standard EVM contract on the L1, aimed at institutions. **"A published design and is not yet live."** It has no SDK and is irrelevant for the hackathon.

### 6.3 Related Category Labs research (proposals, not live)

**Scheduled Transactions** (2026-10-22, https://www.category.xyz/blogs/scheduled-transactions)
- A precompile `schedule(target_block, to, value, gas_limit, data)` with prepaid gas.
- It would allow crank-less settlement at a fixed block, but it is a **proposal** ("design is not final"). Forum: https://forum.monad.xyz/t/scheduled-transactions/567

**Giving Ordering Rights to Applications** (2026-07-20)
- A "unanimity override" ordering rule for app-specified tx ordering. Research stage only.

---

## 7. Stablecoins

| | Address | Notes |
|---|---|---|
| USDC mainnet | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | Native Circle, CCTP V2 ([DOCS] tokens-and-bridges page). Bridge UI: https://monadbridge.com |
| USDC testnet | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | Circle (protocols repo, testnet/circle_usdc.jsonc) [VERIFIED-ONCHAIN code] |
| CCTP V2 mainnet | TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, MessageTransmitterV2 `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | domain 15 |
| CCTP V2 testnet | TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | domain 15 |

- Test USDC: **https://faucet.circle.com**. Select "Monad Testnet". **20 USDC per request, once every 2 h** per address per chain.
- For the demo LP vault, also deploy a `MockUSDC` with an open `mint()` so judges can play freely.
- USDC has 6 decimals and is a FiatToken proxy (upgradeable, blocklist). Handle `transfer` reverts.

---

## 8. Indexing and real-time data

- Officially listed:
  - Envio HyperIndex/HyperSync (network id `143`/`10143`)
  - Goldsky:
    - Subgraphs: network `monad` / `monad-testnet`
    - Turbo pipelines: dataset prefix `monad.`
    - Edge RPC: HTTPS only
  - The Graph (`monad-mainnet` / `monad-testnet`)
  - Allium (`monad_mainnet`/`monad_testnet`)
  - QuickNode Streams (`monad-mainnet`/`monad-testnet`)
  - thirdweb Insight
  - GhostGraph
  - SQD, SubQuery, Sentio, Ormi, StreamingFast Substreams
- **Ponder** is not listed but works with any EVM RPC through viem chains **[UNVERIFIED on Monad]**. Use a paid RPC, because public `eth_getLogs` is capped at 100 blocks (30 s).
- **WebSockets (`eth_subscribe`):**
  - `newHeads` and `logs` fire at **`Proposed`**, i.e. speculatively executed and still subject to change.
  - `monadNewHeads` and `monadLogs` add `blockId` and `commitState` (Proposed/Voted/Finalized/Verified) and re-emit as the state advances.
  - A block can skip Voted.
  - **Abandoned proposals get no explicit removal event.** Finalization of a different block at the same height silently supersedes them.
  - `syncing` and `newPendingTransactions` are unsupported.
  - Default max is 100 subscriptions per connection.
  - Goldsky Edge has no WS.
- **Recommended backend pattern:**
  - Subscribe to `monadLogs` for your contract.
  - Treat `Proposed` as optimistic UI.
  - Write to the DB/leaderboard as final only when you see `commitState = Finalized` for that `blockId`.
  - Key events by `blockId`, not by block number.
- The lowest-latency option is the Execution Events SDK (C/C++/Rust over shared memory). It needs your own node, which is overkill here.

---

## 9. Known pitfalls and gotchas

1. **Gas limit is the bill.** Default 30% estimate padding, or wallets falling back to huge limits on revert, wastes money. Hardcode limits with about 7.5–10% headroom.
2. **Nonces under high frequency:**
   - The RPC accepts nonce-gapped txs (async validation) and won't show pending txs.
   - Keep a **local nonce counter** per relayer key, seeded once from `eth_getTransactionCount(addr,"pending")`.
   - Send concurrently, and resync on errors.
   - Use several relayer keys for parallel lanes.
   - Each key's inflight gas over 3 blocks must stay ≤ min(10 MON, balance) (section 3.2).
3. **Batch instead of spamming.** At 300 ms blocks, one `placeBets([...])` per block (Typewriter's `submitIntervalMs: 300` pattern) beats N single txs on rate limits, nonces and MIP-8 page amortization.
4. **Public RPCs are load-balanced and can be inconsistent.**
   - On 2026-10-24, back-to-back calls to `rpc.monad.xyz` returned `finalized` = 116169350 and `safe` = 116169351, both *higher* than a `latest` = 116169349 read a moment earlier [observed].
   - Never assume monotonic heads across calls. Pin one dedicated provider for the keeper.
5. **Speculative data:** receipts, logs and `latest` reads come from `Proposed` blocks and *can change*, including turning back to `null`. Compare against the tracked `finalized` height before paying out off-chain or crediting.
6. **`eth_getLogs` ranges are tiny** (100 blocks on QuickNode/MF), and backfills burn rate limit. Use WS, an indexer, or `eth_getBlockReceipts`.
7. **`block.timestamp` has 1-second granularity** and 3–4 blocks share it. Don't build sub-second windows on it.
8. **Historical `eth_call` fails** on normal full nodes. Use `rpc-mainnet.monadinfra.com` or `rpc2.monad.xyz`.
9. **`debug_trace*` needs `{}`**, and only `callTracer` is supported.
10. **Reserve balance:** a keeper or relayer EOA with < 10 MON has a shrinking inflight budget. Delegated (7702) EOAs can't spend below 10 MON. Txs that violate the rules are *included and reverted*, and still pay gas.
11. **Testnet was reset on 2025-12-16.** Old addresses and tutorials are wrong.
12. **Hermes needs an API key** (401 otherwise). The SSE stream closes after 24 h.
13. **The legacy Monad Foundry fork lacks MIP-8**, so gas numbers will be wrong. Use the official forge ≥ 1.8.

---

## 10. Security design for a touch-option ("tap cell") contract

Pyth best practices: https://docs.pyth.network/pro/best-practices.mdx (Adversarial Selection, Latency, Delayed Settlement).

### 10.1 Threats specific to 300 ms blocks plus a pull oracle

**Late betting / latency arbitrage**
- Users see CEX prices before the chain or oracle does. If a cell's window has already started, or starts within the oracle latency, a user can tap a level that has *already been touched*.
- **Rule:** `windowStart >= block.timestamp + MIN_LEAD`. Use `MIN_LEAD` ≥ 2–3 s; Hermes plus relay latency is about 1 s and timestamps have 1 s granularity.
- Also reject taps whose `deadline` (signed) has passed. Don't trust a client-provided "placedAt".
- Price the multiplier from distance to level, time-to-window and volatility, with a house edge.

**Adversarial selection of updates**
- Anyone can submit *any* valid signed Pyth update in range. For touch options that is fine and even desirable: any update in `[windowStart, windowEnd]` with `price` crossing the level proves a touch.
- But you **must bound publishTime to the window** with `parsePriceFeedUpdates(min = windowStart, max = windowEnd)`. Never use `getPriceUnsafe` or the stored price for settlement.
- **Also require `publishTime > betPlacedAt`**, in addition to ≥ windowStart. This blocks proving a touch with a price published before the bet existed. Store `placedAt = block.timestamp` and require `publishTime >= max(windowStart, placedAt + 1)`.

**Confidence**
- Require `conf * 10_000 / |price| <= MAX_CONF_BPS`, e.g. 20 bps for BTC/ETH and looser for MON.
- Optionally make it conservative for the house: an up-touch requires `price - conf >= level`.

**Sampling semantics**
- "Touch" means at least one *published Pyth update* in the window crossed the level. It is not continuous price.
- Hermes historical lookups are per second (`/v2/updates/price/{publish_time}`).
- Document this rule in the UI so the game is provably fair.

**Loss resolution**
- You can't prove a no-touch on-chain with a single update. Use **timeout-based expiry**: after `windowEnd + GRACE`, e.g. 30 s, anyone can call `expire(betId)` and the stake goes to the vault.
- Because win proofs are **permissionless**, users and watchers can submit them, not just your keeper. That keeps settlement fair even if the keeper is down or biased.

**Keeper censorship and MEV**
- There is no public mempool, but leaders still see txs, and the default ordering is a priority-fee auction.
- Since outcomes depend only on the oracle and windows, not tx ordering, front-running a settlement gains nothing beyond the gas race.
- Make payouts go to `bet.user`, never to `msg.sender`.

**Oracle manipulation**
- BTC/ETH/SOL on Pyth are robust. MON/USD is thinner, so apply lower per-cell caps and wider confidence thresholds.
- Hardcode the Pyth address and feed IDs per network as immutables, and validate `expo`.

**Replay**
- EIP-712 domain with chainId and verifyingContract.
- Per-session nonces, or a 2-D lane+seq like Typewriter's.
- Session expiry and spend caps, enforced on-chain.

### 10.2 Vault solvency and LP safety

**Liability accounting**
- On each bet: `reservedLiability += stake * (multBps - 10_000) / 10_000` (the net max payout).
- Require `reservedLiability <= freeAssets * MAX_UTIL_BPS`, e.g. 50%.
- Release the reservation on settle or expire.

**Exposure caps**
- Max payout per bet.
- Per (feed, windowStart, level-bucket) cell cap, which stops many users piling onto one cell that is about to be touched.
- Per window across all cells.
- Per user per window.

**LP front-running of known outcomes**
- An LP who sees a touch happen off-chain could withdraw before the winning proof lands and socialize the loss to the others.
- Mitigations:
  - ERC-4626 `totalAssets()` = balance − reservedLiability (worst case).
  - A withdrawal **request queue with a delay** longer than the max window plus grace, e.g. 2–5 min.
  - Or epoch-based withdrawals.
- Deposits should also be delayed or priced at the worst case, to stop "deposit after a known loss" arbitrage.

**Other vault hygiene**
- ERC-4626 inflation attack: use OpenZeppelin ERC4626 with `_decimalsOffset()`, or a seeded dead-shares deposit.
- Circuit breakers: `pause()` new bets if the oracle is stale (no update for more than N s) or conf blows out. Settlement and expiry stay always-open.
- Rounding: round payouts down and reservations up. Use `SafeERC20`.

### 10.3 Contract sketch
```solidity
function placeBets(Tap[] calldata taps, bytes[] calldata sessSigs) external onlyRelayer {
    for (uint i; i < taps.length; ++i) {
        Tap calldata t = taps[i];
        _verifySession(t, sessSigs[i]);                     // EIP-712, session limits, nonce, deadline >= block.timestamp
        require(t.windowStart >= block.timestamp + MIN_LEAD, "late");
        uint mult = _quote(t);                              // or verify server-signed quote with expiry
        uint liab = uint(t.stake) * (mult - 1e4) / 1e4;
        _reserve(t.cellKey, liab);                          // per-cell / per-window / global utilization caps
        balances[t.user] -= t.stake;                        // pre-deposited USDC (internal ledger)
        bets.push(Bet(t.user, t.stake, t.level, t.windowStart, t.windowEnd, uint32(mult), t.feedIdx, t.dir, 0));
        // emit with placedAt = block.timestamp stored or implied
    }
}

function settleWin(uint betId, bytes[] calldata updateData) external payable {   // permissionless
    Bet storage b = bets[betId];
    require(b.status == 0);
    bytes32[] memory ids = new bytes32[](1); ids[0] = feedIds[b.feedIdx];
    uint64 minT = uint64(_max(b.windowStart, placedAt[betId] + 1));
    PythStructs.PriceFeed[] memory f =
        pyth.parsePriceFeedUpdates{value: 0}(updateData, ids, minT, uint64(b.windowEnd));
    PythStructs.Price memory p = f[0].price;
    require(_confOk(p) && _touched(b, p), "no touch");
    b.status = 1; _release(b); _pay(b.user, b.stake * b.multBps / 1e4);
}

function expire(uint betId) external { /* require block.timestamp > windowEnd + GRACE; status=2; release; stake stays in vault */ }
```

Keeper loop:
1. Hold a Hermes SSE stream for BTC/ETH/SOL/MON.
2. Keep an in-memory index of open bets by (feed, window).
3. On every update, check crossings.
4. If a cell is touched, immediately submit `settleWin` batched (a `settleWins(uint[] , bytes[])` variant) with `eth_sendRawTransactionSync`.
5. Also run the `expire` sweeper.
6. Persist the raw update binaries for audit and replay.

---

## Source index

**Monad docs**
- https://docs.monad.xyz/llms.txt
- …/developer-essentials/{network-information, testnet, differences, summary, gas-pricing, opcode-pricing, precompiles, reserve-balance, eip-7702, best-practices, transactions, changelog, changelog/releases}
- https://docs.monad.xyz/reference/json-rpc/overview
- https://docs.monad.xyz/monad-arch/consensus/{block-states, local-mempool}
- https://docs.monad.xyz/monad-arch/realtime-data/data-sources
- https://docs.monad.xyz/tooling-and-infra/{toolkits/foundry, toolkits/hardhat, block-explorers, oracles, wallet-infra/account-abstraction, wallet-infra/embedded-wallets, indexers/indexing-frameworks}
- https://docs.monad.xyz/guides/verify-smart-contract/foundry

**Addresses**
- https://github.com/monad-crypto/protocols: mainnet/{pyth, chainlink, stork, redstone, circle_cctp}.jsonc and testnet/{pyth_network, circle_usdc, circle_cctp}.jsonc

**Pyth**
- https://docs.pyth.network/llms-price-feeds-core.txt
- https://docs.pyth.network/llms-price-feeds-pro.txt
- https://docs.pyth.network/pro/{pyth-core-upgrade, contract-addresses, on-chain-fees, best-practices}.mdx

**Monad and Category Labs blogs**
- https://monad.xyz/blog/introducing-typewriter
- https://monad.xyz/blog/monad-private-settlement
- https://github.com/monad-developers/typewriter
- https://www.category.xyz/blogs/{setting-your-gas-limit-on-monad, scheduled-transactions, giving-ordering-rights-to-applications}

**Circle faucet**
- https://faucet.circle.com
