// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ███████╗████████╗██████╗ ██╗██╗  ██╗███████╗███████╗███████╗███╗   ██╗██████╗
 * ██╔════╝╚══██╔══╝██╔══██╗██║██║ ██╔╝██╔════╝██╔════╝██╔════╝████╗  ██║██╔══██╗
 * ███████╗   ██║   ██████╔╝██║█████╔╝ █████╗  ███████╗█████╗  ██╔██╗ ██║██║  ██║
 * ╚════██║   ██║   ██╔══██╗██║██╔═██╗ ██╔══╝  ╚════██║██╔══╝  ██║╚██╗██║██║  ██║
 * ███████║   ██║   ██║  ██║██║██║  ██╗███████╗███████║███████╗██║ ╚████║██████╔╝
 * ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═══╝╚═════╝
 *
 * @title   StrikeSend v3.1 — ERC-20 Privacy Layer (Arc Testnet)
 * @notice  Routes USDC / EURC through a time-delayed, sender-defined split escrow,
 *          breaking the on-chain link between sender and recipient.
 *
 * @dev     v3.1 changes vs v3.0
 *          • Added reclaim() — sender can recover uncollected splits after
 *            RECLAIM_DELAY (30 days), preventing permanent fund loss if secret
 *            is lost or never delivered.
 *          • Added Reclaimed event for indexing.
 *          • Two-step ownership transfer (proposeOwner / acceptOwnership)
 *            replaces single-step transferOwnership, preventing accidental
 *            permanent loss of admin control.
 *
 * ── Arc Testnet specifics ─────────────────────────────────────────────────────
 *  Chain ID : 5042002
 *  Gas token: USDC (native, 18-decimal precision internally; ERC-20 = 6 decimals)
 *  USDC ERC-20: 0x3600000000000000000000000000000000000000
 *  EURC ERC-20: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
 *  Explorer : https://testnet.arcscan.app
 *  Faucet   : https://faucet.circle.com
 *
 * ── Arc EVM differences handled here ─────────────────────────────────────────
 *  1. PREV_RANDAO = 0 always on Arc. This contract does NOT use block.prevrandao,
 *     blockhash(), or any on-chain randomness. Split amounts and delays are
 *     fully sender-specified via SplitParam[]. Safe.
 *  2. Sub-second blocks may share block.timestamp. Release checks use
 *     block.timestamp >= releaseTime (not strict >), so this is safe.
 *  3. No native ETH. Gas is paid in USDC. This contract uses the ERC-20
 *     interface only and reverts on any native value send.
 *  4. Deterministic finality <1s. One confirmation is sufficient.
 *  5. SELFDESTRUCT restricted — not used here.
 *  6. EIP-1559 fee market. Transactions must set maxFeePerGas >= 20 Gwei.
 *
 * ── Flow ──────────────────────────────────────────────────────────────────────
 *  1. Sender generates random secret off-chain → commitment = keccak256(secret).
 *  2. Sender calls token.approve(thisContract, totalAmount).
 *  3. Sender calls strike(token, commitment, splitParams[]).
 *  4. Contract pulls tokens; schedule locked on-chain.
 *  5. Sender sends raw secret to recipient via private channel (Signal, etc.).
 *  6a. Recipient calls collect(secret, i) — pays own gas.
 *  6b. OR recipient signs payload; relayer calls collectFor() — gasless.
 *  7.  If secret lost: sender calls reclaim(commitment) after 30 days
 *      to recover any uncollected splits.
 *
 * ── Privacy properties ────────────────────────────────────────────────────────
 *  • Commitment (hash) on-chain; raw secret revealed only at collect time.
 *  • No sender↔recipient address link stored on-chain.
 *  • Nullifiers prevent double-spending.
 *  • Multiple splits → multiple unrelated-looking transactions.
 *  • collectFor() → recipient never touches the chain.
 *  • reclaim() uses commitment (not secret) — does not break privacy model.
 *
 * ── Deployment ────────────────────────────────────────────────────────────────
 *  Remix: compile with 0.8.20, deploy on Arc Testnet (chainId 5042002):
 *    _owner: 0x0000000000000000000000000000000000000000  (uses msg.sender)
 *    _usdc:  0x3600000000000000000000000000000000000000
 *    _eurc:  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
}

contract StrikeSend {

    // ─────────────────────────────────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────────────────────────────────

    struct Split {
        uint256 amount;       // 6-decimal ERC-20 token units locked in this split
        uint256 releaseTime;  // Unix timestamp; collect allowed when block.timestamp >= this
        bool    collected;    // True once funds have been transferred out
    }

    struct StrikeData {
        address token;        // ERC-20 token address (USDC or EURC)
        address striker;      // Depositor — not revealed during collect
        uint256 totalAmount;  // Sum of all split amounts
        uint256 numSplits;    // Length of the split schedule
        uint256 timestamp;    // block.timestamp at deposit
        bool    exists;       // Prevents commitment reuse
    }

    /**
     * @dev  Input type for each split in a strike() call.
     *
     *  amount       — token units in 6-decimal ERC-20 terms.
     *                 Example: 1_000_000 = 1 USDC / 1 EURC.
     *
     *  delaySeconds — seconds from block.timestamp until this split is collectable.
     *                 0 = immediately collectable.
     *                 Max = 604800 (7 days).
     *
     *  Frontend note: the UI stores delays as milliseconds (delayMs).
     *  The hook must convert: delaySeconds = Math.floor(split.delayMs / 1000)
     *  before encoding the transaction.
     */
    struct SplitParam {
        uint256 amount;
        uint256 delaySeconds;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    mapping(bytes32 => StrikeData)                 public strikes;
    mapping(bytes32 => mapping(uint256 => Split))  public splits;
    mapping(bytes32 => bool)                       public nullifiers;
    mapping(address => bool)                       public tokenAllowed;

    address public owner;
    address public proposedOwner; // v3.1: two-step ownership transfer

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant MAX_SPLITS      = 7;
    uint256 public constant MAX_DELAY       = 7 days;   // 604 800 seconds
    uint256 public constant MAX_RELAYER_FEE = 500;      // 5 % in basis points
    uint256 public constant RECLAIM_DELAY   = 30 days;  // v3.1: sender reclaim window

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TokenAllowed(address indexed token, bool allowed);

    event Struck(
        bytes32 indexed commitment,
        address indexed token,
        address indexed striker,
        uint256 totalAmount,
        uint256 numSplits,
        uint256 timestamp
    );

    event SplitScheduled(
        bytes32 indexed commitment,
        uint256 splitIndex,
        uint256 amount,
        uint256 releaseTime
    );

    // relayer == address(0) for direct collect / collectAll
    event Collected(
        bytes32 indexed commitment,
        uint256 splitIndex,
        address indexed token,
        address indexed recipient,
        address relayer,
        uint256 payout,
        uint256 relayerFee,
        uint256 timestamp
    );

    // v3.1: emitted when sender reclaims uncollected splits
    event Reclaimed(
        bytes32 indexed commitment,
        address indexed striker,
        address indexed token,
        uint256 amount,
        uint256 timestamp
    );

    // v3.1: two-step ownership events
    event OwnershipProposed(address indexed proposedOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address _owner, address _usdc, address _eurc) {
        owner = (_owner == address(0)) ? msg.sender : _owner;
        if (_usdc != address(0)) { tokenAllowed[_usdc] = true; emit TokenAllowed(_usdc, true); }
        if (_eurc != address(0)) { tokenAllowed[_eurc] = true; emit TokenAllowed(_eurc, true); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "StrikeSend: not owner");
        _;
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        tokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /**
     * @notice  v3.1: Step 1 of two-step ownership transfer.
     *          Proposes a new owner; they must call acceptOwnership() to confirm.
     *          Prevents accidental permanent loss of admin control.
     */
    function proposeOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "StrikeSend: zero address");
        proposedOwner = newOwner;
        emit OwnershipProposed(newOwner);
    }

    /**
     * @notice  v3.1: Step 2 of two-step ownership transfer.
     *          Must be called by the proposed new owner to accept control.
     */
    function acceptOwnership() external {
        require(msg.sender == proposedOwner, "StrikeSend: not proposed owner");
        emit OwnershipTransferred(owner, proposedOwner);
        owner         = proposedOwner;
        proposedOwner = address(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // strike()
    // ─────────────────────────────────────────────────────────────────────────

    function strike(
        address           token,
        bytes32           commitment,
        SplitParam[] calldata params
    ) external {
        require(tokenAllowed[token],              "StrikeSend: token not allowed");
        require(!strikes[commitment].exists,      "StrikeSend: commitment already used");
        require(commitment != bytes32(0),         "StrikeSend: zero commitment");
        require(params.length >= 1,               "StrikeSend: at least 1 split required");
        require(params.length <= MAX_SPLITS,      "StrikeSend: max 7 splits");

        uint256 total = 0;
        for (uint256 i = 0; i < params.length; i++) {
            require(params[i].amount > 0,                "StrikeSend: split amount is 0");
            require(params[i].delaySeconds <= MAX_DELAY, "StrikeSend: delay > 7 days");
            total += params[i].amount;
        }

        // Pull tokens. Arc enforces USDC blocklist pre-mempool and at runtime;
        // if sender is blocklisted, transferFrom reverts here.
        require(IERC20(token).transferFrom(msg.sender, address(this), total),
                "StrikeSend: transferFrom failed");

        strikes[commitment] = StrikeData({
            token:       token,
            striker:     msg.sender,
            totalAmount: total,
            numSplits:   params.length,
            timestamp:   block.timestamp,
            exists:      true
        });

        for (uint256 i = 0; i < params.length; i++) {
            uint256 releaseTime = block.timestamp + params[i].delaySeconds;
            splits[commitment][i] = Split({
                amount:      params[i].amount,
                releaseTime: releaseTime,
                collected:   false
            });
            emit SplitScheduled(commitment, i, params[i].amount, releaseTime);
        }

        emit Struck(commitment, token, msg.sender, total, params.length, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // collect()  — direct (caller pays USDC gas)
    // ─────────────────────────────────────────────────────────────────────────

    function collect(bytes32 secret, uint256 splitIndex) external {
        bytes32 commitment = _toCommitment(secret);

        require(strikes[commitment].exists,                 "StrikeSend: unknown commitment");
        require(splitIndex < strikes[commitment].numSplits, "StrikeSend: invalid split index");

        Split storage s = splits[commitment][splitIndex];
        require(!s.collected,                               "StrikeSend: already collected");
        require(block.timestamp >= s.releaseTime,           "StrikeSend: time-lock active");

        bytes32 nullifier = keccak256(abi.encodePacked(commitment, splitIndex));
        require(!nullifiers[nullifier],                     "StrikeSend: nullifier spent");

        nullifiers[nullifier] = true;
        s.collected = true;

        address token = strikes[commitment].token;
        emit Collected(commitment, splitIndex, token, msg.sender, address(0), s.amount, 0, block.timestamp);

        require(IERC20(token).transfer(msg.sender, s.amount), "StrikeSend: transfer failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // collectAll()  — batch all matured splits
    // ─────────────────────────────────────────────────────────────────────────

    function collectAll(bytes32 secret) external {
        bytes32 commitment = _toCommitment(secret);
        require(strikes[commitment].exists, "StrikeSend: unknown commitment");

        uint256 n      = strikes[commitment].numSplits;
        uint256 payout = 0;
        address token  = strikes[commitment].token;

        for (uint256 i = 0; i < n; i++) {
            Split storage s   = splits[commitment][i];
            bytes32 nullifier = keccak256(abi.encodePacked(commitment, i));
            if (!s.collected && !nullifiers[nullifier] && block.timestamp >= s.releaseTime) {
                nullifiers[nullifier] = true;
                s.collected = true;
                payout += s.amount;
                emit Collected(commitment, i, token, msg.sender, address(0), s.amount, 0, block.timestamp);
            }
        }

        require(payout > 0, "StrikeSend: nothing collectable yet");
        require(IERC20(token).transfer(msg.sender, payout), "StrikeSend: transfer failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // collectFor()  — gasless via relayer
    // ─────────────────────────────────────────────────────────────────────────

    function collectFor(
        bytes32        secret,
        uint256        splitIndex,
        address        recipient,
        uint256        relayerFeeBps,
        bytes calldata signature
    ) external {
        require(recipient != address(0),                    "StrikeSend: zero recipient");
        require(relayerFeeBps <= MAX_RELAYER_FEE,           "StrikeSend: fee too high");

        bytes32 commitment = _toCommitment(secret);

        require(strikes[commitment].exists,                 "StrikeSend: unknown commitment");
        require(splitIndex < strikes[commitment].numSplits, "StrikeSend: invalid split index");

        Split storage s = splits[commitment][splitIndex];
        require(!s.collected,                               "StrikeSend: already collected");
        require(block.timestamp >= s.releaseTime,           "StrikeSend: time-lock active");

        bytes32 nullifier = keccak256(abi.encodePacked(commitment, splitIndex));
        require(!nullifiers[nullifier],                     "StrikeSend: nullifier spent");

        bytes32 payload = collectPayload(secret, splitIndex, recipient, relayerFeeBps);
        require(_recoverSigner(payload, signature) == recipient, "StrikeSend: invalid signature");

        nullifiers[nullifier] = true;
        s.collected = true;

        address token  = strikes[commitment].token;
        uint256 fee    = (s.amount * relayerFeeBps) / 10_000;
        uint256 payout = s.amount - fee;

        emit Collected(commitment, splitIndex, token, recipient, msg.sender, payout, fee, block.timestamp);

        if (fee > 0) {
            require(IERC20(token).transfer(msg.sender, fee), "StrikeSend: fee transfer failed");
        }
        require(IERC20(token).transfer(recipient, payout), "StrikeSend: payout transfer failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // reclaim()  — v3.1: sender recovers uncollected splits after 30 days
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice  Allows the original striker to recover any uncollected splits
     *          after RECLAIM_DELAY (30 days) has passed since the strike.
     *
     * @dev     Safety properties:
     *          • Only callable by the original striker address.
     *          • Only after 30 days — gives recipients a generous collection window.
     *          • Only refunds splits not yet collected — already-collected splits
     *            are unaffected; the recipient keeps what they already took.
     *          • Uses commitment (not secret) — privacy model is preserved;
     *            no new on-chain link between striker and recipient is created.
     *          • Nullifiers marked spent so splits cannot be double-claimed
     *            if reclaim() and collect() race (collect wins if it lands first).
     *
     * @param   commitment  The keccak256 hash of the secret (same value emitted
     *                      in the Struck event at deposit time).
     */
    function reclaim(bytes32 commitment) external {
        StrikeData storage sd = strikes[commitment];

        require(sd.exists,                "StrikeSend: unknown commitment");
        require(msg.sender == sd.striker, "StrikeSend: not striker");
        require(
            block.timestamp >= sd.timestamp + RECLAIM_DELAY,
            "StrikeSend: reclaim too early — wait 30 days from deposit"
        );

        uint256 refund = 0;
        uint256 n      = sd.numSplits;

        for (uint256 i = 0; i < n; i++) {
            Split storage s   = splits[commitment][i];
            bytes32 nullifier = keccak256(abi.encodePacked(commitment, i));

            // Skip splits already collected by the recipient
            if (!s.collected && !nullifiers[nullifier]) {
                nullifiers[nullifier] = true;
                s.collected = true;
                refund += s.amount;
            }
        }

        require(refund > 0, "StrikeSend: nothing to reclaim — all splits already collected");

        address token = sd.token;
        emit Reclaimed(commitment, msg.sender, token, refund, block.timestamp);

        require(IERC20(token).transfer(msg.sender, refund), "StrikeSend: reclaim transfer failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────────────

    function getSplits(bytes32 secret)
        external view
        returns (
            address          token,
            uint256[] memory amounts,
            uint256[] memory releaseTimes,
            bool[]    memory collected_
        )
    {
        bytes32 commitment = _toCommitment(secret);
        require(strikes[commitment].exists, "StrikeSend: unknown commitment");

        uint256 n    = strikes[commitment].numSplits;
        token        = strikes[commitment].token;
        amounts      = new uint256[](n);
        releaseTimes = new uint256[](n);
        collected_   = new bool[](n);

        for (uint256 i = 0; i < n; i++) {
            amounts[i]      = splits[commitment][i].amount;
            releaseTimes[i] = splits[commitment][i].releaseTime;
            collected_[i]   = splits[commitment][i].collected;
        }
    }

    function unlocked(bytes32 secret) external view returns (uint256 total) {
        bytes32 commitment = _toCommitment(secret);
        if (!strikes[commitment].exists) return 0;
        uint256 n = strikes[commitment].numSplits;
        for (uint256 i = 0; i < n; i++) {
            Split storage s   = splits[commitment][i];
            bytes32 nullifier = keccak256(abi.encodePacked(commitment, i));
            if (!s.collected && !nullifiers[nullifier] && block.timestamp >= s.releaseTime) {
                total += s.amount;
            }
        }
    }

    /**
     * @notice  Returns the unix timestamp after which reclaim() becomes callable.
     *          Returns 0 if the commitment does not exist.
     */
    function reclaimAvailableAt(bytes32 commitment) external view returns (uint256) {
        if (!strikes[commitment].exists) return 0;
        return strikes[commitment].timestamp + RECLAIM_DELAY;
    }

    /**
     * @notice  Payload the recipient must EIP-191 sign to authorise collectFor().
     *          Chain-ID bound (5042002) — prevents cross-chain replay.
     */
    function collectPayload(
        bytes32 secret,
        uint256 splitIndex,
        address recipient,
        uint256 relayerFeeBps
    ) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "StrikeSend:collectFor",
            _toCommitment(secret),
            splitIndex,
            recipient,
            relayerFeeBps,
            block.chainid
        ));
    }

    function toCommitment(bytes32 secret) external pure returns (bytes32) {
        return _toCommitment(secret);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _toCommitment(bytes32 secret) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(secret));
    }

    /// @dev EIP-191 personal_sign recovery — matches ethers.js signMessage(getBytes(payload))
    function _recoverSigner(bytes32 payload, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "StrikeSend: bad sig length");
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "StrikeSend: bad sig v");
        return ecrecover(ethHash, v, r, s);
    }

    /// @dev Reject native USDC sends — use strike() with ERC-20 transferFrom.
    receive() external payable { revert("StrikeSend: use strike()"); }
}
