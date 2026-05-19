/**
 * StrikeSend — Circle Programmable Wallets Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces MetaMask with Circle Programmable Wallets for both sender and
 * recipient. Neither party needs a browser wallet, seed phrase, or USDC for
 * gas. Everything is signed server-side (developer-controlled wallets) or via
 * a 6-digit PIN flow (user-controlled wallets).
 *
 * Architecture:
 *
 *   SENDER  →  email login  →  Circle dev-controlled wallet
 *                               signs approve() + strike() server-side
 *
 *   RECIPIENT  →  email login  →  Circle user-controlled wallet
 *                                  PIN challenge → Circle SDK → collectFor()
 *
 * Endpoints:
 *   POST /wallets/create-sender        Create a dev-controlled sender wallet
 *   POST /wallets/create-recipient     Create a user-controlled recipient wallet
 *   POST /wallets/init-recipient       Init PIN flow for recipient (returns challengeId)
 *   POST /wallets/balance              Get USDC/EURC balance for a wallet
 *   POST /strike/approve               Approve USDC spend (server-signed)
 *   POST /strike/execute               Call strike() (server-signed)
 *   POST /collect/prepare              Build collectFor payload + create challenge
 *   POST /collect/status               Poll challenge status → auto-submit when complete
 *   GET  /wallets/:walletId            Wallet info + balances
 *   GET  /health                       Server health + Circle API status
 *
 * Setup:
 *   npm install express cors dotenv @circle-fin/developer-controlled-wallets ethers
 *   cp .env.circle .env — fill in CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, etc.
 *   node circle-wallets-server.js
 *
 * Docs: developers.circle.com/wallets
 */

import express                                  from "express";
import cors                                     from "cors";
import { ethers }                               from "ethers";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import "dotenv/config";

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT             = process.env.PORT                || 3002;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN      || "http://localhost:5173";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const RPC_URL          = process.env.RPC_URL             || "https://rpc.testnet.arc.network";
const CIRCLE_API_KEY   = process.env.CIRCLE_API_KEY;
const CIRCLE_SECRET    = process.env.CIRCLE_ENTITY_SECRET;
const RELAYER_FEE_BPS  = parseInt(process.env.RELAYER_FEE_BPS || "50");

// Arc Testnet blockchain identifier used by Circle APIs
// Confirmed from Circle docs quickstart: "ARC-TESTNET"
const ARC_BLOCKCHAIN   = "ARC-TESTNET";

if (!CIRCLE_API_KEY || !CIRCLE_SECRET) {
  console.error("❌  Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in .env");
  console.error("    Get them at console.circle.com → API keys");
  process.exit(1);
}
if (!CONTRACT_ADDRESS) {
  console.error("❌  Missing CONTRACT_ADDRESS in .env");
  process.exit(1);
}

// ─── Circle SDK client ────────────────────────────────────────────────────────
const circle = initiateDeveloperControlledWalletsClient({
  apiKey:       CIRCLE_API_KEY,
  entitySecret: CIRCLE_SECRET,
});

// ─── Ethers provider (read-only — for contract reads) ─────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ─── Arc gas settings ─────────────────────────────────────────────────────────
const ARC_GAS_FEE      = "25000000000"; // 25 Gwei in wei (Arc 20 Gwei floor + headroom)
const ARC_GAS_PRIORITY = "1000000000";  // 1 Gwei tip

// ─── Token addresses (Arc Testnet) ───────────────────────────────────────────
const TOKENS = {
  USDC: { address: "0x3600000000000000000000000000000000000000", decimals: 6 },
  EURC: { address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", decimals: 6 },
};

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  { name: "approve",   type: "function", inputs: [{ name:"spender",type:"address" },{ name:"amount",type:"uint256" }], outputs: [{ type:"bool" }], stateMutability: "nonpayable" },
  { name: "allowance", type: "function", inputs: [{ name:"owner",type:"address" },{ name:"spender",type:"address" }], outputs: [{ type:"uint256" }], stateMutability: "view" },
  { name: "balanceOf", type: "function", inputs: [{ name:"account",type:"address" }], outputs: [{ type:"uint256" }], stateMutability: "view" },
];

const SS_ABI = [
  { name: "strike", type: "function",
    inputs: [
      { name:"token",type:"address" },
      { name:"commitment",type:"bytes32" },
      { name:"params",type:"tuple[]",components:[{ name:"amount",type:"uint256" },{ name:"delaySeconds",type:"uint256" }] }
    ],
    outputs: [], stateMutability: "nonpayable" },
  { name: "collectFor", type: "function",
    inputs: [
      { name:"secret",type:"bytes32" },
      { name:"splitIndex",type:"uint256" },
      { name:"recipient",type:"address" },
      { name:"relayerFeeBps",type:"uint256" },
      { name:"signature",type:"bytes" }
    ],
    outputs: [], stateMutability: "nonpayable" },
  { name: "collectPayload", type: "function",
    inputs: [
      { name:"secret",type:"bytes32" },
      { name:"splitIndex",type:"uint256" },
      { name:"recipient",type:"address" },
      { name:"relayerFeeBps",type:"uint256" }
    ],
    outputs: [{ type:"bytes32" }], stateMutability: "view" },
  { name: "getSplits", type: "function",
    inputs: [{ name:"secret",type:"bytes32" }],
    outputs: [
      { name:"token",type:"address" },
      { name:"amounts",type:"uint256[]" },
      { name:"releaseTimes",type:"uint256[]" },
      { name:"collected",type:"bool[]" }
    ], stateMutability: "view" },
];

// ─── ABI encoders ─────────────────────────────────────────────────────────────
const erc20Interface = new ethers.Interface(ERC20_ABI);
const ssInterface    = new ethers.Interface(SS_ABI);

function encodeApprove(spender, amount) {
  return erc20Interface.encodeFunctionData("approve", [spender, amount]);
}
function encodeStrike(tokenAddr, commitment, params) {
  return ssInterface.encodeFunctionData("strike", [tokenAddr, commitment, params]);
}
function encodeCollectFor(secret, splitIndex, recipient, feeBps, sig) {
  return ssInterface.encodeFunctionData("collectFor", [secret, splitIndex, recipient, feeBps, sig]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseToken(sym) {
  const t = TOKENS[sym?.toUpperCase()];
  if (!t) throw new Error(`Unknown token: ${sym}`);
  return t;
}
function rawAmount(human, decimals) {
  return ethers.parseUnits(parseFloat(human).toFixed(decimals), decimals).toString();
}
function humanAmount(raw, decimals) {
  return ethers.formatUnits(raw, decimals);
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN }));

// ─── In-memory store (replace with a DB in production) ───────────────────────
// Maps userId → { walletId, address, walletSetId }
const walletStore = new Map();
// Maps challengeId → { userId, walletId, action, metadata }
const challengeStore = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    // Ping Circle by fetching entity config
    const cfg = await circle.getEntityConfig();
    res.json({
      status:      "ok",
      circle:      "connected",
      appId:       cfg.data?.appId || "see console.circle.com",
      contract:    CONTRACT_ADDRESS,
      network:     ARC_BLOCKCHAIN,
      relayerFee:  `${RELAYER_FEE_BPS} bps`,
      wallets:     walletStore.size,
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallets/create-sender
// Creates a developer-controlled EOA wallet for a sender on Arc Testnet.
// The server holds the signing key — no MetaMask needed.
//
// Body: { userId: string }
// Returns: { walletId, address, walletSetId }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/wallets/create-sender", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    // Create a wallet set to group this sender's wallets
    const wsRes = await circle.createWalletSet({ name: `StrikeSend-Sender-${userId}` });
    const walletSetId = wsRes.data?.walletSet?.id;
    if (!walletSetId) throw new Error("Wallet set creation failed");

    // Create a single EOA on Arc Testnet
    const wRes = await circle.createWallets({
      walletSetId,
      blockchains: [ARC_BLOCKCHAIN],
      count: 1,
      accountType: "EOA",
    });
    const wallet = wRes.data?.wallets?.[0];
    if (!wallet) throw new Error("Wallet creation failed");

    const record = {
      userId,
      walletId:    wallet.id,
      address:     wallet.address,
      walletSetId,
      type:        "sender",
      blockchain:  ARC_BLOCKCHAIN,
      createdAt:   new Date().toISOString(),
    };
    walletStore.set(`sender:${userId}`, record);

    console.log(`✓ Sender wallet created: ${userId} → ${wallet.address}`);
    res.json({ walletId: wallet.id, address: wallet.address, walletSetId });
  } catch (e) {
    console.error("create-sender error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallets/create-recipient
// Creates a user-controlled wallet for a recipient.
// The recipient will authenticate with a 6-digit PIN via the Circle Web SDK.
// The server gets a challengeId back — pass it to the frontend SDK.
//
// Body: { userId: string }
// Returns: { challengeId } — pass to circle.execute(challengeId) in the browser
// ─────────────────────────────────────────────────────────────────────────────
app.post("/wallets/create-recipient", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  try {
    // Step 1: Create the user in Circle's system
    await circle.createUser({ userId });

    // Step 2: Create a user session token (60-minute validity)
    const tokenRes = await circle.createUserToken({ userId });
    const { userToken, encryptionKey } = tokenRes.data || {};
    if (!userToken) throw new Error("Failed to create user token");

    // Step 3: Initialize the user with wallet creation
    // This returns a challengeId the frontend SDK uses to show the PIN setup UI
    const initRes = await circle.createUserPinWithWallets({
      userToken,
      accountType: "EOA",
      blockchains:  [ARC_BLOCKCHAIN],
    });
    const challengeId = initRes.data?.challengeId;
    if (!challengeId) throw new Error("Failed to get challenge ID");

    // Store pending state — wallet address will be available after PIN is set
    challengeStore.set(challengeId, {
      userId,
      action:      "init-wallet",
      userToken,
      encryptionKey,
      createdAt:   new Date().toISOString(),
    });

    console.log(`✓ Recipient challenge created: ${userId} → ${challengeId}`);

    // encryptionKey must be passed to the Circle Web SDK in the browser
    res.json({ challengeId, encryptionKey, userToken });
  } catch (e) {
    console.error("create-recipient error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallets/pin-complete
// Called after the recipient completes the PIN flow in the browser.
// Looks up the wallet address and stores it.
//
// Body: { challengeId: string }
// Returns: { walletId, address }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/wallets/pin-complete", async (req, res) => {
  const { challengeId } = req.body;
  if (!challengeId) return res.status(400).json({ error: "challengeId required" });

  const pending = challengeStore.get(challengeId);
  if (!pending) return res.status(404).json({ error: "Unknown challengeId" });

  try {
    // Fetch wallets using the session token
    const walletsRes = await circle.listWallets({ userToken: pending.userToken });
    const wallet = walletsRes.data?.wallets?.find(w => w.blockchain === ARC_BLOCKCHAIN);
    if (!wallet) return res.status(202).json({ status: "pending", message: "PIN setup not yet complete" });

    const record = {
      userId:     pending.userId,
      walletId:   wallet.id,
      address:    wallet.address,
      type:       "recipient",
      blockchain: ARC_BLOCKCHAIN,
      createdAt:  new Date().toISOString(),
    };
    walletStore.set(`recipient:${pending.userId}`, record);
    challengeStore.delete(challengeId);

    console.log(`✓ Recipient wallet confirmed: ${pending.userId} → ${wallet.address}`);
    res.json({ walletId: wallet.id, address: wallet.address });
  } catch (e) {
    console.error("pin-complete error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /wallets/:walletId
// Returns wallet info and USDC/EURC balances.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/wallets/:walletId", async (req, res) => {
  try {
    const wRes = await circle.getWallet({ id: req.params.walletId });
    const w = wRes.data?.wallet;
    if (!w) return res.status(404).json({ error: "Wallet not found" });

    // Read token balances directly from chain (no Circle API needed for reads)
    const balances = {};
    for (const [sym, tok] of Object.entries(TOKENS)) {
      try {
        const tc  = new ethers.Contract(tok.address, ["function balanceOf(address) view returns (uint256)"], provider);
        const raw = await tc.balanceOf(w.address);
        balances[sym] = humanAmount(raw, tok.decimals);
      } catch { balances[sym] = "0.00"; }
    }

    res.json({
      walletId:   w.id,
      address:    w.address,
      blockchain: w.blockchain,
      state:      w.state,
      balances,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /strike/approve
// Approves the StrikeSend contract to spend tokens from a sender wallet.
// Signed server-side by the developer-controlled wallet — no MetaMask needed.
//
// Body:
//   { userId: string, tokenSymbol: "USDC"|"EURC", humanAmount: "100.00" }
//
// Returns: { txHash }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/strike/approve", async (req, res) => {
  const { userId, tokenSymbol, humanAmount } = req.body;
  if (!userId || !tokenSymbol || !humanAmount)
    return res.status(400).json({ error: "userId, tokenSymbol, humanAmount required" });

  const senderRecord = walletStore.get(`sender:${userId}`);
  if (!senderRecord) return res.status(404).json({ error: "Sender wallet not found — call /wallets/create-sender first" });

  try {
    const tok     = parseToken(tokenSymbol);
    const rawAmt  = rawAmount(humanAmount, tok.decimals);
    const calldata = encodeApprove(CONTRACT_ADDRESS, rawAmt);

    // Submit transaction via Circle API — server-side signing, no user interaction
    const txRes = await circle.createContractExecutionTransaction({
      walletId:        senderRecord.walletId,
      contractAddress: tok.address,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters:   [CONTRACT_ADDRESS, rawAmt],
      fee: {
        type:                "EIP1559",
        maxFee:              ARC_GAS_FEE,
        maxPriorityFee:      ARC_GAS_PRIORITY,
      },
    });

    const txId = txRes.data?.id;
    if (!txId) throw new Error("Transaction creation failed");

    // Poll for confirmation (Arc is <1s finality)
    const txHash = await pollTxConfirmation(txId);
    console.log(`✓ Approve ${humanAmount} ${tokenSymbol} for ${userId}: ${txHash}`);
    res.json({ txHash, txId, walletId: senderRecord.walletId });
  } catch (e) {
    console.error("approve error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /strike/execute
// Calls strike() on the StrikeSend contract from the sender's wallet.
// Signed server-side. Approve must be called first.
//
// Body:
//   {
//     userId:      string,
//     tokenSymbol: "USDC" | "EURC",
//     commitment:  "0x...",   ← keccak256(secret), generated client-side
//     schedule:    [{ amount: "100.00", delaySeconds: 0 }, ...]
//   }
//
// Returns: { txHash, numSplits }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/strike/execute", async (req, res) => {
  const { userId, tokenSymbol, commitment, schedule } = req.body;
  if (!userId || !tokenSymbol || !commitment || !Array.isArray(schedule) || !schedule.length)
    return res.status(400).json({ error: "userId, tokenSymbol, commitment, schedule[] required" });

  const senderRecord = walletStore.get(`sender:${userId}`);
  if (!senderRecord) return res.status(404).json({ error: "Sender wallet not found" });

  try {
    const tok    = parseToken(tokenSymbol);
    const params = schedule.map(s => ({
      amount:       rawAmount(s.amount, tok.decimals),
      delaySeconds: String(Math.floor(Number(s.delaySeconds || s.delayMs / 1000 || 0))),
    }));

    // Build the ABI parameters array for Circle API
    const abiParams = [
      tok.address,
      commitment,
      params.map(p => [p.amount, p.delaySeconds]),
    ];

    const txRes = await circle.createContractExecutionTransaction({
      walletId:             senderRecord.walletId,
      contractAddress:      CONTRACT_ADDRESS,
      abiFunctionSignature: "strike(address,bytes32,tuple(uint256,uint256)[])",
      abiParameters:        abiParams,
      fee: {
        type:           "EIP1559",
        maxFee:         ARC_GAS_FEE,
        maxPriorityFee: ARC_GAS_PRIORITY,
      },
    });

    const txId = txRes.data?.id;
    if (!txId) throw new Error("Strike transaction creation failed");

    const txHash = await pollTxConfirmation(txId);
    console.log(`✓ Strike ${schedule.length} splits for ${userId}: ${txHash}`);
    res.json({ txHash, txId, numSplits: schedule.length });
  } catch (e) {
    console.error("strike error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /collect/prepare
// Prepares a gasless collect for a recipient:
//   1. Fetches the collectPayload from the contract
//   2. Creates a SIGN_MESSAGE challenge for the recipient's user-controlled wallet
//   3. Returns the challengeId to the frontend — user enters PIN to sign
//
// Body:
//   { userId: string, secret: "0x...", splitIndex: 0 }
//
// Returns: { challengeId, encryptionKey, payload }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/collect/prepare", async (req, res) => {
  const { userId, secret, splitIndex } = req.body;
  if (!userId || !secret || splitIndex == null)
    return res.status(400).json({ error: "userId, secret, splitIndex required" });

  const recipientRecord = walletStore.get(`recipient:${userId}`);
  if (!recipientRecord) return res.status(404).json({ error: "Recipient wallet not found — call /wallets/create-recipient first" });

  try {
    // Fetch the exact bytes32 payload the contract expects
    const ssContract = new ethers.Contract(CONTRACT_ADDRESS, SS_ABI, provider);
    const payload    = await ssContract.collectPayload(
      secret,
      BigInt(splitIndex),
      recipientRecord.address,
      BigInt(RELAYER_FEE_BPS)
    );

    // Create a fresh session token for this user
    const tokenRes = await circle.createUserToken({ userId });
    const { userToken, encryptionKey } = tokenRes.data || {};
    if (!userToken) throw new Error("Failed to create user token");

    // Create a SIGN_MESSAGE challenge
    // The recipient will see a PIN prompt in the Circle Web SDK
    const challengeRes = await circle.signMessage({
      userToken,
      walletId: recipientRecord.walletId,
      message:  payload, // the bytes32 hex — Circle signs it as personal_sign
    });
    const challengeId = challengeRes.data?.challengeId;
    if (!challengeId) throw new Error("Failed to create sign challenge");

    // Store challenge context so /collect/submit can pick it up
    challengeStore.set(challengeId, {
      userId,
      walletId:      recipientRecord.walletId,
      recipientAddr: recipientRecord.address,
      action:        "collect",
      secret,
      splitIndex:    Number(splitIndex),
      payload,
      userToken,
      createdAt:     new Date().toISOString(),
    });

    console.log(`→ Collect challenge created: ${userId} split[${splitIndex}] → ${challengeId}`);
    res.json({ challengeId, encryptionKey, payload });
  } catch (e) {
    console.error("collect/prepare error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /collect/submit
// Called after the recipient completes the PIN sign challenge.
// Fetches the signature from Circle and submits collectFor() on-chain
// from the relayer wallet (server-side, no recipient gas needed).
//
// Body: { challengeId: string }
// Returns: { txHash, payout, relayerFee }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/collect/submit", async (req, res) => {
  const { challengeId } = req.body;
  if (!challengeId) return res.status(400).json({ error: "challengeId required" });

  const ctx = challengeStore.get(challengeId);
  if (!ctx) return res.status(404).json({ error: "Unknown challengeId" });
  if (ctx.action !== "collect") return res.status(400).json({ error: "Challenge is not a collect action" });

  try {
    // Fetch the signed message result from Circle
    const sigRes = await circle.getSignedMessage({
      userToken: ctx.userToken,
      id:        challengeId,
    });
    const sigData  = sigRes.data;
    const status   = sigData?.status;

    if (status === "PENDING" || status === "IN_PROGRESS") {
      return res.status(202).json({ status: "pending", message: "Waiting for PIN completion" });
    }
    if (status !== "COMPLETE") {
      return res.status(400).json({ error: `Challenge status: ${status}` });
    }

    const signature = sigData?.signature;
    if (!signature) throw new Error("No signature in response");

    // Now submit collectFor() using the relayer wallet server-side
    // The relayer wallet is a dev-controlled wallet that pays gas
    const relayerRecord = walletStore.get("relayer");
    if (!relayerRecord) throw new Error("Relayer wallet not initialised — call /wallets/create-relayer");

    const txRes = await circle.createContractExecutionTransaction({
      walletId:             relayerRecord.walletId,
      contractAddress:      CONTRACT_ADDRESS,
      abiFunctionSignature: "collectFor(bytes32,uint256,address,uint256,bytes)",
      abiParameters: [
        ctx.secret,
        String(ctx.splitIndex),
        ctx.recipientAddr,
        String(RELAYER_FEE_BPS),
        signature,
      ],
      fee: {
        type:           "EIP1559",
        maxFee:         ARC_GAS_FEE,
        maxPriorityFee: ARC_GAS_PRIORITY,
      },
    });

    const txId   = txRes.data?.id;
    if (!txId) throw new Error("collectFor transaction creation failed");

    const txHash = await pollTxConfirmation(txId);
    challengeStore.delete(challengeId);

    console.log(`✓ collectFor submitted: ${ctx.userId} split[${ctx.splitIndex}] → ${txHash}`);
    res.json({ txHash, txId, recipientAddr: ctx.recipientAddr });
  } catch (e) {
    console.error("collect/submit error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /wallets/create-relayer
// Creates the server-side dev-controlled relayer wallet.
// Call this once during setup — stores as "relayer" in walletStore.
// Fund it with USDC at faucet.circle.com.
//
// Body: {}
// Returns: { walletId, address }
// ─────────────────────────────────────────────────────────────────────────────
app.post("/wallets/create-relayer", async (_req, res) => {
  try {
    const wsRes = await circle.createWalletSet({ name: "StrikeSend-Relayer" });
    const walletSetId = wsRes.data?.walletSet?.id;
    if (!walletSetId) throw new Error("Wallet set creation failed");

    const wRes = await circle.createWallets({
      walletSetId,
      blockchains: [ARC_BLOCKCHAIN],
      count: 1,
      accountType: "EOA",
    });
    const wallet = wRes.data?.wallets?.[0];
    if (!wallet) throw new Error("Relayer wallet creation failed");

    const record = {
      walletId:   wallet.id,
      address:    wallet.address,
      walletSetId,
      type:       "relayer",
      blockchain: ARC_BLOCKCHAIN,
      createdAt:  new Date().toISOString(),
    };
    walletStore.set("relayer", record);

    console.log(`✓ Relayer wallet created: ${wallet.address}`);
    console.log(`  Fund it at https://faucet.circle.com`);
    res.json({ walletId: wallet.id, address: wallet.address });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /splits/:secret
// Read-only split lookup (no wallet needed). Proxies to the contract.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/splits/:secret", async (req, res) => {
  try {
    const ssContract = new ethers.Contract(CONTRACT_ADDRESS, SS_ABI, provider);
    const [tokenAddr, amounts, releaseTimes, collected] = await ssContract.getSplits(req.params.secret);

    const sym = Object.entries(TOKENS).find(
      ([, t]) => t.address.toLowerCase() === tokenAddr.toLowerCase()
    )?.[0] || "USDC";
    const dec = TOKENS[sym]?.decimals || 6;
    const now = Math.floor(Date.now() / 1000);

    const splits = amounts.map((amt, i) => ({
      index:       i,
      amount:      humanAmount(amt, dec),
      amountRaw:   amt.toString(),
      releaseTime: Number(releaseTimes[i]),
      releaseMs:   Number(releaseTimes[i]) * 1000,
      collected:   collected[i],
      unlocked:    !collected[i] && Number(releaseTimes[i]) <= now,
    }));

    res.json({ token: sym, tokenAddress: tokenAddr, splits });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll Circle's transaction API until confirmed or failed.
 * Arc has <1s finality so this typically resolves in 2-3 polls.
 */
async function pollTxConfirmation(txId, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await circle.getTransaction({ id: txId });
    const tx = r.data?.transaction;
    if (!tx) throw new Error(`Transaction ${txId} not found`);

    if (tx.state === "CONFIRMED") return tx.txHash;
    if (tx.state === "FAILED")    throw new Error(`Transaction failed: ${tx.errorReason || "unknown"}`);

    // Pending/Sent — wait and retry
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  throw new Error(`Transaction ${txId} did not confirm within ${maxMs}ms`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   StrikeSend Circle Wallets Server  ·  Arc Testnet   ║
╚══════════════════════════════════════════════════════╝
  Port     : ${PORT}
  Network  : ${ARC_BLOCKCHAIN}
  Contract : ${CONTRACT_ADDRESS}
  Docs     : developers.circle.com/wallets

  Setup checklist:
  1. POST /wallets/create-relayer        ← create relayer wallet
  2. Fund relayer at faucet.circle.com
  3. POST /wallets/create-sender         ← per sender user
  4. POST /wallets/create-recipient      ← per recipient user
  5. Frontend completes PIN setup via Circle Web SDK
  `);
});
