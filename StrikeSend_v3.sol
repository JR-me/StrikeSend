// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
}

contract StrikeSend {

    struct Split {
        uint256 amount;
        uint256 releaseTime;
        bool    collected;
    }

    struct StrikeData {
        address token;
        address striker;
        uint256 totalAmount;
        uint256 numSplits;
        uint256 timestamp;
        bool    exists;
    }

    struct SplitParam {
        uint256 amount;
        uint256 delaySeconds;
    }

    mapping(bytes32 => StrikeData)                 public strikes;
    mapping(bytes32 => mapping(uint256 => Split))  public splits;
    mapping(bytes32 => bool)                       public nullifiers;
    mapping(address => bool)                       public tokenAllowed;

    address public owner;
    address public proposedOwner;

    uint256 public constant MAX_SPLITS      = 7;
    uint256 public constant MAX_DELAY       = 7 days;
    uint256 public constant MAX_RELAYER_FEE = 500;
    uint256 public constant RECLAIM_DELAY   = 30 days;

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

    event Reclaimed(
        bytes32 indexed commitment,
        address indexed striker,
        address indexed token,
        uint256 amount,
        uint256 timestamp
    );

    event OwnershipProposed(address indexed proposedOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address _owner, address _usdc, address _eurc) {
        owner = (_owner == address(0)) ? msg.sender : _owner;
        if (_usdc != address(0)) { tokenAllowed[_usdc] = true; emit TokenAllowed(_usdc, true); }
        if (_eurc != address(0)) { tokenAllowed[_eurc] = true; emit TokenAllowed(_eurc, true); }
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "StrikeSend: not owner");
        _;
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        tokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function proposeOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "StrikeSend: zero address");
        proposedOwner = newOwner;
        emit OwnershipProposed(newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == proposedOwner, "StrikeSend: not proposed owner");
        emit OwnershipTransferred(owner, proposedOwner);
        owner         = proposedOwner;
        proposedOwner = address(0);
    }

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

    function reclaim(bytes32 commitment) external {
        StrikeData storage sd = strikes[commitment];

        require(sd.exists,                "StrikeSend: unknown commitment");
        require(msg.sender == sd.striker, "StrikeSend: not striker");
        require(
            block.timestamp >= sd.timestamp + RECLAIM_DELAY,
            "StrikeSend: reclaim too early: wait 30 days from deposit"
        );

        uint256 refund = 0;
        uint256 n      = sd.numSplits;

        for (uint256 i = 0; i < n; i++) {
            Split storage s   = splits[commitment][i];
            bytes32 nullifier = keccak256(abi.encodePacked(commitment, i));

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

    function reclaimAvailableAt(bytes32 commitment) external view returns (uint256) {
        if (!strikes[commitment].exists) return 0;
        return strikes[commitment].timestamp + RECLAIM_DELAY;
    }

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

    function _toCommitment(bytes32 secret) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(secret));
    }

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

    receive() external payable { revert("StrikeSend: use strike()"); }
}
