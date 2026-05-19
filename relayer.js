/**
 * StrikeSend Relayer Server — v3 (Arc Testnet)
 * ─────────────────────────────────────────────────────────────────────────────
 * Submits collectFor() on behalf of recipients so they need zero USDC in their
 * wallet to collect splits.
 *
 * Arc Testnet specifics handled here:
 *  • Gas token is USDC (native). No ETH. balance check uses getBalance() which
 *    returns USDC on Arc — displayed as "X USDC" not "X ETH".
 *  • maxFeePerGas >= 20 Gwei (Arc protocol floor). Set to 25 Gwei + 1 Gwei tip.
 *  • getSplits() returns (address token, uint256[], uint256[], bool[]).
 *    Old (ETH-only) ABI returning (uint256[], uint256[], bool[]) will revert.
 *  • Amounts are 6-decimal (USDC/EURC). formatUnits(x, 6) not formatEther(x).
 *  • Collected event has extra `address token` field before recipient.
 *  • Chain ID 5042002. collectPayload() is chainId-bound — will reject Sepolia sigs.
 *
 * Setup:
 *   1. npm install express ethers dotenv cors
 *   2. cp .env.example .env  →  fill in values
 *   3. node relayer.js
 *
 * Relayer wallet needs USDC on Arc Testnet for gas. Get it at faucet.circle.com.
 * It earns back RELAYER_FEE_BPS of every split it collects.
 *
 * Security: relayer cannot steal funds — the contract verifies the recipient's
 * EIP-191 signature and only sends payout to the signed recipient address.
 */

import express    from "express";
import cors       from "cors";
import { ethers } from "ethers";
import "dotenv/config";

// ─── Config from .env ─────────────────────────────────────────────────────────
const PORT             = process.env.PORT              || 3001;
const RPC_URL          = process.env.RPC_URL           || "https://rpc.testnet.arc.network";
const RELAYER_KEY      = process.env.RELAYER_PRIVATE_KEY;   // required
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;      // required
const RELAYER_FEE_BPS  = parseInt(process.env.RELAYER_FEE_BPS || "50");
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN    || "http://localhost:5173";

if (!RELAYER_KEY || !CONTRACT_ADDRESS) {
  console.error("❌  Missing RELAYER_PRIVATE_KEY or CONTRACT_ADDRESS in .env");
  process.exit(1);
}

// ─── Arc gas settings ─────────────────────────────────────────────────────────
// Arc enforces a 20 Gwei minimum base fee (EIP-1559 + EWMA). Transactions
// with maxFeePerGas below 20 Gwei will be rejected by the network.
const ARC_GAS = {
  maxFeePerGas:         ethers.parseUnits("25", "gwei"), // 5 Gwei above floor
  maxPriorityFeePerGas: ethers.parseUnits("1",  "gwei"), // tip to help inclusion
};

// ─── ABI — only what the relayer calls ───────────────────────────────────────
// IMPORTANT: getSplits v3 returns (address token, uint256[], uint256[], bool[])
// The old v2 signature (uint256[], uint256[], bool[]) is WRONG — do not use it.
const ABI = [
  // Main action
  "function collectFor(bytes32 secret, uint256 splitIndex, address recipient, uint256 relayerFeeBps, bytes signature) external",

  // Pre-flight validation
  "function getSplits(bytes32 secret) external view returns (address token, uint256[] amounts, uint256[] releaseTimes, bool[] collected)",
  "function collectPayload(bytes32 secret, uint256 splitIndex, address recipient, uint256 relayerFeeBps) external view returns (bytes32)",

  // Event — includes `address token` before recipient (v3)
  "event Collected(bytes32 indexed commitment, uint256 splitIndex, address indexed token, address indexed recipient, address relayer, uint256 payout, uint256 relayerFee, uint256 timestamp)",
];

// ─── USDC / EURC token decimals lookup ───────────────────────────────────────
const TOKEN_DECIMALS = {
  "0x3600000000000000000000000000000000000000": 6, // USDC
  "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a": 6, // EURC
};

function getDecimals(tokenAddr) {
  return TOKEN_DECIMALS[tokenAddr?.toLowerCase()] ??
         TOKEN_DECIMALS[tokenAddr] ??
         6;
}

// ─── Ethers setup ─────────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(RELAYER_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

console.log(`
╔══════════════════════════════════════════════════╗
║        StrikeSend Relayer — Arc Testnet          ║
╚══════════════════════════════════════════════════╝
  Relayer : ${wallet.address}
  Contract: ${CONTRACT_ADDRESS}
  RPC     : ${RPC_URL}
  Fee     : ${RELAYER_FEE_BPS} bps (${RELAYER_FEE_BPS / 100}%)
  Gas     : maxFeePerGas=25 Gwei  tip=1 Gwei
`);

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN }));

// ─────────────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    // On Arc, getBalance() returns USDC (native gas token) in 18-decimal wei.
    // We display with 6 decimals for human readability (matches ERC-20 face value).
    const raw     = await provider.getBalance(wallet.address);
    const network = await provider.getNetwork();

    res.json({
      status:   "ok",
      network:  network.name || `chainId ${network.chainId}`,
      chainId:  Number(network.chainId),
      relayer:  wallet.address,
      balance:  ethers.formatUnits(raw, 6) + " USDC", // native USDC balance
      feeBps:   RELAYER_FEE_BPS,
      contract: CONTRACT_ADDRESS,
      gasFloor: "20 Gwei (Arc protocol minimum)",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /splits/:secret
// Returns split details without the recipient needing a connected wallet.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/splits/:secret", async (req, res) => {
  const { secret } = req.params;

  if (!isBytes32(secret)) {
    return res.status(400).json({
      error: "secret must be a 0x-prefixed 32-byte hex string",
    });
  }

  try {
    // v3 returns: (address token, uint256[] amounts, uint256[] releaseTimes, bool[] collected)
    const [tokenAddr, amounts, releaseTimes, collected] = await contract.getSplits(secret);
    const now = Math.floor(Date.now() / 1000);
    const dec = getDecimals(tokenAddr);

    const splits = amounts.map((amt, i) => ({
      index:       i,
      amountRaw:   amt.toString(),
      amount:      ethers.formatUnits(amt, dec),  // human-readable "100.00"
      releaseTime: Number(releaseTimes[i]),
      releaseMs:   Number(releaseTimes[i]) * 1000,
      collected:   collected[i],
      unlocked:    !collected[i] && Number(releaseTimes[i]) <= now,
    }));

    res.json({ token: tokenAddr, splits });
  } catch (err) {
    res.status(400).json({ error: parseContractError(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /relay
// Validates a signed collect request and submits it on-chain.
//
// Body:
// {
//   "secret":        "0x...",
//   "splitIndex":    0,
//   "recipient":     "0x...",
//   "relayerFeeBps": 50,
//   "signature":     "0x..."   ← EIP-191 personal_sign of collectPayload(...)
// }
//
// Response:
// {
//   "txHash":     "0x...",
//   "token":      "0x3600...",
//   "payout":     "99.50 USDC",
//   "relayerFee": "0.50 USDC"
// }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/relay", async (req, res) => {
  const { secret, splitIndex, recipient, relayerFeeBps, signature } = req.body;

  // ── Input validation ────────────────────────────────────────────────────────
  const valErr = validateRequest({ secret, splitIndex, recipient, relayerFeeBps, signature });
  if (valErr) return res.status(400).json({ error: valErr });

  if (Number(relayerFeeBps) !== RELAYER_FEE_BPS) {
    return res.status(400).json({
      error: `This relayer charges ${RELAYER_FEE_BPS} bps. You sent ${relayerFeeBps}.`,
    });
  }

  // ── Pre-flight (don't burn gas if it's going to fail) ───────────────────────
  let tokenAddr;
  try {
    const [tok, amounts, releaseTimes, collected] = await contract.getSplits(secret);
    tokenAddr = tok;
    const idx = Number(splitIndex);

    if (idx >= amounts.length) {
      return res.status(400).json({ error: `Split index ${idx} does not exist` });
    }
    if (collected[idx]) {
      return res.status(400).json({ error: "This split has already been collected" });
    }

    const now = Math.floor(Date.now() / 1000);
    const rt  = Number(releaseTimes[idx]);
    if (rt > now) {
      return res.status(400).json({
        error:     `Split not yet unlocked. Unlocks in ${fmtDuration(rt - now)}.`,
        unlocksAt: rt,
      });
    }

    // Check relayer USDC balance (native token on Arc)
    const rawBal = await provider.getBalance(wallet.address);
    // Estimate: 200k gas * 25 Gwei = 5_000_000 Gwei = 0.000005 USDC (very cheap)
    // Still worth checking the balance isn't zero
    if (rawBal === 0n) {
      console.error("Relayer USDC balance is zero — fund it at faucet.circle.com");
      return res.status(503).json({
        error: "Relayer has no USDC for gas. Fund it at faucet.circle.com and retry.",
      });
    }
  } catch (err) {
    return res.status(400).json({ error: `Pre-flight failed: ${parseContractError(err)}` });
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  try {
    console.log(
      `→ Relaying: secret=${secret.slice(0,10)}… ` +
      `idx=${splitIndex} recipient=${recipient}`
    );

    // Estimate gas with 20% buffer; fall back to 250k if estimation fails
    let gasLimit;
    try {
      const est = await contract.collectFor.estimateGas(
        secret, BigInt(splitIndex), recipient, BigInt(relayerFeeBps), signature
      );
      gasLimit = est * 120n / 100n;
    } catch {
      gasLimit = 250_000n;
    }

    const tx = await contract.collectFor(
      secret,
      BigInt(splitIndex),
      recipient,
      BigInt(relayerFeeBps),
      signature,
      { ...ARC_GAS, gasLimit }
    );

    console.log(`  tx: ${tx.hash}`);
    const receipt = await tx.wait(1);

    // Parse Collected event — note: token is the 3rd indexed field in v3
    let payout     = "unknown";
    let relayerFee = "0";
    let token      = tokenAddr;

    const iface = new ethers.Interface(ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "Collected") {
          token = parsed.args.token || tokenAddr;
          const dec = getDecimals(token);
          payout     = ethers.formatUnits(parsed.args.payout,     dec) + " " + tokenSymbol(token);
          relayerFee = ethers.formatUnits(parsed.args.relayerFee, dec) + " " + tokenSymbol(token);
        }
      } catch { /* non-matching log */ }
    }

    console.log(`  ✓ payout=${payout}  fee=${relayerFee}  block=${receipt.blockNumber}`);

    res.json({
      success:     true,
      txHash:      receipt.hash,
      blockNumber: receipt.blockNumber,
      token,
      payout,
      relayerFee,
    });
  } catch (err) {
    console.error("collectFor failed:", err.message);
    res.status(500).json({ error: `Transaction failed: ${parseContractError(err)}` });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateRequest({ secret, splitIndex, recipient, relayerFeeBps, signature }) {
  if (!isBytes32(secret))
    return "secret must be a 0x-prefixed 32-byte hex string";
  if (splitIndex == null || isNaN(Number(splitIndex)) || Number(splitIndex) < 0)
    return "splitIndex must be a non-negative integer";
  if (!ethers.isAddress(recipient))
    return "recipient must be a valid Ethereum address";
  if (relayerFeeBps == null || isNaN(Number(relayerFeeBps)) ||
      Number(relayerFeeBps) < 0 || Number(relayerFeeBps) > 500)
    return "relayerFeeBps must be 0–500";
  if (!signature || !signature.startsWith("0x") || signature.length !== 132)
    return "signature must be 0x-prefixed 65-byte hex (132 chars)";
  return null;
}

function isBytes32(val) {
  return typeof val === "string" && /^0x[0-9a-fA-F]{64}$/.test(val);
}

function parseContractError(err) {
  return err?.info?.error?.message
      || err?.reason
      || err?.shortMessage
      || err?.message
      || "Unknown error";
}

function fmtDuration(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function tokenSymbol(addr) {
  const MAP = {
    "0x3600000000000000000000000000000000000000": "USDC",
    "0x89b50855aa3be2f677cd6303cec089b5f319d72a": "EURC",
  };
  return MAP[addr?.toLowerCase()] || "tokens";
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Relayer listening on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
