/**
 * useAuth.js — Unified Auth for StrikeSend
 * ─────────────────────────────────────────────────────────────────────────────
 * Single hook that supports all three user types transparently:
 *
 *   MODE A  "metamask"  — existing MetaMask / injected wallet users
 *                          signs transactions in-browser, pays own gas
 *
 *   MODE B  "circle"    — email users with Circle Programmable Wallets
 *                          sender: server signs (dev-controlled wallet)
 *                          recipient: 6-digit PIN (user-controlled wallet)
 *                          no MetaMask, no seed phrase, no gas worries
 *
 *   MODE C  "readonly"  — no wallet at all
 *                          can look up splits by pasting a secret key
 *                          collect only available via gasless relayer
 *
 * The app calls the SAME functions regardless of mode:
 *
 *   connect(mode, opts)         — start an auth session
 *   disconnect()
 *   approve(token, amount)      — ERC-20 approve()
 *   strike(token, comm, sched)  — StrikeSend.strike()
 *   collect(secret, idx)        — StrikeSend.collect() or collectFor()
 *   collectAll(secret)          — StrikeSend.collectAll() or batch collectFor()
 *   getSplits(secret)           — read split schedule (always works)
 *   getBalance(tokenSym)        — USDC/EURC balance
 *   generateSecret()            — always client-side regardless of mode
 *
 * Usage:
 *   import { useAuth, AUTH_MODES } from "./useAuth";
 *
 *   const { connect, strike, collect, wallet, authMode, loading, error } = useAuth();
 *
 *   // MetaMask user
 *   await connect(AUTH_MODES.METAMASK);
 *
 *   // Email / Circle user
 *   await connect(AUTH_MODES.CIRCLE, { userId: "alice@example.com", role: "sender" });
 *
 *   // No wallet — read-only
 *   await connect(AUTH_MODES.READONLY);
 *
 * Install:
 *   npm install ethers @circle-fin/user-controlled-wallets
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { ethers } from "ethers";

// ─── Auth mode constants ──────────────────────────────────────────────────────
export const AUTH_MODES = {
  METAMASK: "metamask",
  CIRCLE:   "circle",
  READONLY: "readonly",
};

// ─── Arc Testnet ──────────────────────────────────────────────────────────────
const CHAIN_ID     = 5042002;
const CHAIN_HEX    = "0x4CDB52";
const NETWORK_NAME = "Arc Testnet";
const ARC_RPC      = "https://rpc.testnet.arc.network";
const ARC_EXPLORER = "https://testnet.arcscan.app";
const ARC_FAUCET   = "https://faucet.circle.com";

// ─── Token addresses ──────────────────────────────────────────────────────────
export const TOKENS = {
  USDC: { symbol:"USDC", name:"USD Coin",  address:"0x3600000000000000000000000000000000000000", decimals:6, color:"#2775ca", badge:"$" },
  EURC: { symbol:"EURC", name:"Euro Coin", address:"0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", decimals:6, color:"#1a56db", badge:"€" },
};

// ─── Contract address ─────────────────────────────────────────────────────────
export const CONTRACT_ADDRESS = process.env.REACT_APP_CONTRACT_ADDRESS
  || "0xYOUR_STRIKESEND_ADDRESS_HERE";

// ─── Server URLs ──────────────────────────────────────────────────────────────
const RELAYER_URL      = process.env.REACT_APP_RELAYER_URL      || "http://localhost:3001";
const CIRCLE_SRV_URL   = process.env.REACT_APP_CIRCLE_SERVER    || "http://localhost:3002";
const CIRCLE_APP_ID    = process.env.REACT_APP_CIRCLE_APP_ID    || "";
const RELAYER_FEE_BPS  = parseInt(process.env.REACT_APP_RELAYER_FEE_BPS || "50");

// ─── Arc gas ──────────────────────────────────────────────────────────────────
const ARC_GAS = {
  maxFeePerGas:         ethers.parseUnits("25", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("1",  "gwei"),
};

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const STRIKESEND_ABI = [
  "function strike(address token, bytes32 commitment, tuple(uint256 amount, uint256 delaySeconds)[] params) external",
  "function collect(bytes32 secret, uint256 splitIndex) external",
  "function collectAll(bytes32 secret) external",
  "function collectFor(bytes32 secret, uint256 splitIndex, address recipient, uint256 relayerFeeBps, bytes signature) external",
  "function getSplits(bytes32 secret) external view returns (address token, uint256[] amounts, uint256[] releaseTimes, bool[] collected)",
  "function unlocked(bytes32 secret) external view returns (uint256 total)",
  "function collectPayload(bytes32 secret, uint256 splitIndex, address recipient, uint256 relayerFeeBps) external view returns (bytes32)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtUnits(raw, sym) {
  return ethers.formatUnits(raw, TOKENS[sym]?.decimals ?? 6);
}
function parseUnits(human, sym) {
  return ethers.parseUnits(
    parseFloat(human).toFixed(TOKENS[sym]?.decimals ?? 6),
    TOKENS[sym]?.decimals ?? 6
  );
}

async function circlePost(path, body = {}) {
  const res = await fetch(`${CIRCLE_SRV_URL}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Circle server error ${res.status}`);
  return data;
}
async function circleGet(path) {
  const res = await fetch(`${CIRCLE_SRV_URL}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Circle server error ${res.status}`);
  return data;
}
async function relayerPost(path, body = {}) {
  const res = await fetch(`${RELAYER_URL}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Relayer error ${res.status}`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────
export function useAuth() {
  // ── Shared state ─────────────────────────────────────────────────────────────
  const [authMode,    setAuthMode]    = useState(null);   // AUTH_MODES.*
  const [wallet,      setWallet]      = useState(null);   // { address, shortAddress, type, userId?, walletId? }
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");
  const [wrongNet,    setWrongNet]    = useState(false);
  const [pinPending,  setPinPending]  = useState(false);  // Circle PIN UI is open

  // MetaMask refs
  const mmProvider  = useRef(null);
  const mmSigner    = useRef(null);
  const mmContract  = useRef(null);

  // Circle SDK ref
  const circleSdk   = useRef(null);
  // Circle user context (set after connect in circle mode)
  const circleCtx   = useRef(null); // { userId, role, walletId }

  // Read-only provider (used by all modes for reads)
  const roProvider  = useRef(new ethers.JsonRpcProvider(ARC_RPC));

  function _err(e) {
    return e?.info?.error?.message || e?.reason || e?.shortMessage || e?.message || String(e);
  }

  function _ss(sp)      { return new ethers.Contract(CONTRACT_ADDRESS, STRIKESEND_ABI, sp); }
  function _tok(a, sp)  { return new ethers.Contract(a, ERC20_ABI, sp); }

  // ── Chain / account listeners (MetaMask) ─────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const onAcc   = () => disconnect();
    const onChain = () => window.location.reload();
    window.ethereum.on("accountsChanged", onAcc);
    window.ethereum.on("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAcc);
      window.ethereum.removeListener("chainChanged", onChain);
    };
  }, []); // eslint-disable-line

  // ─────────────────────────────────────────────────────────────────────────────
  // connect()
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Connect with any auth mode.
   *
   * @param {string} mode   AUTH_MODES.METAMASK | AUTH_MODES.CIRCLE | AUTH_MODES.READONLY
   * @param {object} opts
   *   MetaMask:  {}
   *   Circle:    { userId: string, role: "sender"|"recipient" }
   *   Readonly:  {}
   */
  const connect = useCallback(async (mode, opts = {}) => {
    setError("");
    setLoading(true);
    try {
      // ── MODE A: MetaMask ────────────────────────────────────────────────────
      if (mode === AUTH_MODES.METAMASK) {
        if (!window.ethereum) {
          throw new Error("MetaMask not detected. Install it at metamask.io or use email login instead.");
        }
        await window.ethereum.request({ method: "eth_requestAccounts" });
        let prov = new ethers.BrowserProvider(window.ethereum);
        const net = await prov.getNetwork();

        if (Number(net.chainId) !== CHAIN_ID) {
          try {
            await window.ethereum.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: CHAIN_HEX }],
            });
          } catch (sw) {
            if (sw.code === 4902 || sw?.error?.code === 4902) {
              // Arc not in wallet yet — add it
              await window.ethereum.request({
                method: "wallet_addEthereumChain",
                params: [{
                  chainId:           CHAIN_HEX,
                  chainName:         NETWORK_NAME,
                  nativeCurrency:    { name: "USD Coin", symbol: "USDC", decimals: 18 },
                  rpcUrls:           [ARC_RPC],
                  blockExplorerUrls: [ARC_EXPLORER],
                }],
              });
              await window.ethereum.request({
                method: "wallet_switchEthereumChain",
                params: [{ chainId: CHAIN_HEX }],
              });
            } else {
              setWrongNet(true);
              throw new Error(`Switch MetaMask to ${NETWORK_NAME} and try again.`);
            }
          }
        }

        prov = new ethers.BrowserProvider(window.ethereum);
        const signer = await prov.getSigner();
        const addr   = await signer.getAddress();

        mmProvider.current = prov;
        mmSigner.current   = signer;
        mmContract.current = _ss(signer);
        setWrongNet(false);

        const w = {
          address:      addr,
          shortAddress: addr.slice(0,6) + "…" + addr.slice(-4),
          type:         "metamask",
        };
        setWallet(w);
        setAuthMode(AUTH_MODES.METAMASK);
        return w;
      }

      // ── MODE B: Circle Programmable Wallets ─────────────────────────────────
      if (mode === AUTH_MODES.CIRCLE) {
        const { userId, role } = opts;
        if (!userId) throw new Error("userId required for Circle auth");
        if (!role || !["sender", "recipient"].includes(role))
          throw new Error("role must be 'sender' or 'recipient'");

        if (role === "sender") {
          // Developer-controlled wallet — server creates it instantly
          const data = await circlePost("/wallets/create-sender", { userId });
          circleCtx.current = { userId, role, walletId: data.walletId };

          const w = {
            address:      data.address,
            shortAddress: data.address.slice(0,6) + "…" + data.address.slice(-4),
            type:         "circle-sender",
            userId,
            walletId:     data.walletId,
          };
          setWallet(w);
          setAuthMode(AUTH_MODES.CIRCLE);
          return w;
        }

        if (role === "recipient") {
          // User-controlled wallet — need PIN setup first
          // Returns challengeId; caller must run initCirclePIN() to complete
          const data = await circlePost("/wallets/create-recipient", { userId });
          circleCtx.current = { userId, role, pendingChallenge: data.challengeId, encryptionKey: data.encryptionKey };

          // Wallet address not available yet — set a pending wallet state
          const w = {
            address:      null,
            type:         "circle-recipient-pending",
            userId,
            challengeId:  data.challengeId,
            encryptionKey: data.encryptionKey,
          };
          setWallet(w);
          setAuthMode(AUTH_MODES.CIRCLE);

          // Return the challenge data so the UI can call initCirclePIN()
          return { ...w, needsPin: true };
        }
      }

      // ── MODE C: Read-only (no wallet) ───────────────────────────────────────
      if (mode === AUTH_MODES.READONLY) {
        const w = {
          address:      null,
          type:         "readonly",
          shortAddress: "Read-only",
        };
        setWallet(w);
        setAuthMode(AUTH_MODES.READONLY);
        return w;
      }

      throw new Error(`Unknown auth mode: ${mode}`);
    } catch (e) {
      setError(_err(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // initCirclePIN()
  // Complete the PIN setup for a Circle recipient wallet.
  // Shows the Circle Web SDK PIN iframe in the browser.
  // Call this after connect(CIRCLE, { role: "recipient" }) returns needsPin: true
  // ─────────────────────────────────────────────────────────────────────────────
  const initCirclePIN = useCallback(async (challengeId, encryptionKey, userId) => {
    setError("");
    setPinPending(true);
    try {
      const { W3SSdk } = await import("@circle-fin/user-controlled-wallets");

      if (!circleSdk.current) {
        circleSdk.current = new W3SSdk();
        await circleSdk.current.setAppSettings({ appId: CIRCLE_APP_ID });
      }

      await circleSdk.current.setAuthentication({
        userToken:     challengeId,
        encryptionKey,
      });

      // Renders the PIN iframe — resolves when user completes PIN setup
      await new Promise((resolve, reject) => {
        circleSdk.current.execute(challengeId, (err, result) => {
          if (err) reject(new Error(err.message || "PIN setup failed"));
          else     resolve(result);
        });
      });

      // Fetch wallet address now that PIN is confirmed
      const data = await circlePost("/wallets/pin-complete", { challengeId });
      circleCtx.current = { ...(circleCtx.current || {}), walletId: data.walletId };

      const w = {
        address:      data.address,
        shortAddress: data.address.slice(0,6) + "…" + data.address.slice(-4),
        type:         "circle-recipient",
        userId:       userId || circleCtx.current?.userId,
        walletId:     data.walletId,
      };
      setWallet(w);
      return w;
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setPinPending(false);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // disconnect()
  // ─────────────────────────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    mmProvider.current  = null;
    mmSigner.current    = null;
    mmContract.current  = null;
    circleCtx.current   = null;
    setWallet(null);
    setAuthMode(null);
    setWrongNet(false);
    setError("");
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // generateSecret()
  // Always client-side — never goes to any server
  // ─────────────────────────────────────────────────────────────────────────────
  const generateSecret = useCallback(() => {
    const secret     = ethers.hexlify(ethers.randomBytes(32));
    const commitment = ethers.keccak256(
      ethers.solidityPacked(["bytes32"], [secret])
    );
    return { secret, commitment };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // getBalance()
  // Works for all modes — reads directly from chain
  // ─────────────────────────────────────────────────────────────────────────────
  const getBalance = useCallback(async (tokenSym, addressOverride) => {
    setError("");
    try {
      const tok  = TOKENS[tokenSym];
      if (!tok) throw new Error(`Unknown token: ${tokenSym}`);
      const addr = addressOverride || wallet?.address;
      if (!addr) return "0.00";
      const tc  = _tok(tok.address, roProvider.current);
      const raw = await tc.balanceOf(addr);
      return fmtUnits(raw, tokenSym);
    } catch (e) {
      setError(_err(e));
      return "0.00";
    }
  }, [wallet]);

  // ─────────────────────────────────────────────────────────────────────────────
  // approve()
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Approve the StrikeSend contract to spend tokens.
   *
   * MetaMask  → signs in-browser with MetaMask popup
   * Circle    → server signs silently (no user interaction)
   * Readonly  → throws (can't approve without a wallet)
   */
  const approve = useCallback(async (tokenSym, humanAmount) => {
    setError("");
    try {
      setLoading(true);
      const tok    = TOKENS[tokenSym];
      if (!tok) throw new Error(`Unknown token: ${tokenSym}`);
      const raw = parseUnits(humanAmount, tokenSym);

      if (authMode === AUTH_MODES.METAMASK) {
        if (!mmSigner.current) throw new Error("MetaMask not connected");
        const tc  = _tok(tok.address, mmSigner.current);
        const tx  = await tc.approve(CONTRACT_ADDRESS, raw, ARC_GAS);
        const rec = await tx.wait(1);
        return { txHash: rec.hash };
      }

      if (authMode === AUTH_MODES.CIRCLE) {
        const ctx = circleCtx.current;
        if (!ctx) throw new Error("Circle wallet not connected");
        return await circlePost("/strike/approve", {
          userId:      ctx.userId,
          tokenSymbol: tokenSym,
          humanAmount,
        });
      }

      throw new Error("Read-only mode — connect a wallet to approve tokens");
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, [authMode]);

  // ─────────────────────────────────────────────────────────────────────────────
  // strike()
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Deposit tokens into StrikeSend.
   * Approve must be called first with the total amount.
   *
   * @param {string} tokenSym    "USDC" | "EURC"
   * @param {string} commitment  bytes32 from generateSecret()
   * @param {Array}  schedule    [{ amount:"100.00", delaySeconds:0 }, ...]
   *
   * MetaMask  → signs in-browser
   * Circle    → server signs silently
   * Readonly  → throws
   */
  const strike = useCallback(async (tokenSym, commitment, schedule) => {
    setError("");
    try {
      setLoading(true);
      const tok = TOKENS[tokenSym];
      if (!tok) throw new Error(`Unknown token: ${tokenSym}`);

      if (authMode === AUTH_MODES.METAMASK) {
        if (!mmContract.current) throw new Error("MetaMask not connected");
        const params = schedule.map(s => ({
          amount:       parseUnits(s.amount, tokenSym),
          delaySeconds: BigInt(Math.floor(Number(s.delaySeconds ?? s.delayMs / 1000 ?? 0))),
        }));
        const tx  = await mmContract.current.strike(tok.address, commitment, params, ARC_GAS);
        const rec = await tx.wait(1);
        return { txHash: rec.hash, numSplits: schedule.length };
      }

      if (authMode === AUTH_MODES.CIRCLE) {
        const ctx = circleCtx.current;
        if (!ctx) throw new Error("Circle wallet not connected");
        return await circlePost("/strike/execute", {
          userId:      ctx.userId,
          tokenSymbol: tokenSym,
          commitment,
          schedule:    schedule.map(s => ({
            amount:       s.amount,
            delaySeconds: Math.floor(Number(s.delaySeconds ?? s.delayMs / 1000 ?? 0)),
          })),
        });
      }

      throw new Error("Read-only mode — connect a wallet to strike");
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, [authMode]);

  // ─────────────────────────────────────────────────────────────────────────────
  // getSplits()
  // Works in ALL modes — reads directly from chain, no wallet needed
  // ─────────────────────────────────────────────────────────────────────────────
  const getSplits = useCallback(async (secret) => {
    setError("");
    try {
      setLoading(true);
      const ro  = _ss(roProvider.current);
      const [tokenAddr, amounts, releaseTimes, collected] = await ro.getSplits(secret);
      const sym = Object.entries(TOKENS).find(
        ([, t]) => t.address.toLowerCase() === tokenAddr.toLowerCase()
      )?.[0] || "USDC";
      const dec = TOKENS[sym]?.decimals ?? 6;
      const now = Math.floor(Date.now() / 1000);
      return {
        token: sym,
        splits: amounts.map((amt, i) => ({
          index:       i,
          amount:      ethers.formatUnits(amt, dec),
          amountRaw:   amt.toString(),
          releaseTime: Number(releaseTimes[i]),
          releaseMs:   Number(releaseTimes[i]) * 1000,
          collected:   collected[i],
          unlocked:    !collected[i] && Number(releaseTimes[i]) <= now,
        })),
      };
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // collect()
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Collect a single matured split.
   *
   * MetaMask          → collect() directly — recipient pays USDC gas
   * Circle recipient  → PIN sign → collectFor() via Circle server (gasless)
   * Circle sender     → should not collect (but falls back to collectFor via relayer)
   * Readonly          → collectFor() via relayer — recipient signs off-chain
   *                     opts.recipientAddress + opts.signature required
   */
  const collect = useCallback(async (secret, splitIndex, opts = {}) => {
    setError("");
    try {
      setLoading(true);

      // ── MetaMask: direct on-chain collect ───────────────────────────────────
      if (authMode === AUTH_MODES.METAMASK) {
        if (!mmContract.current) throw new Error("MetaMask not connected");
        const tx  = await mmContract.current.collect(secret, splitIndex, ARC_GAS);
        const rec = await tx.wait(1);
        return { txHash: rec.hash };
      }

      // ── Circle recipient: PIN-gated collectFor ───────────────────────────────
      if (authMode === AUTH_MODES.CIRCLE) {
        const ctx = circleCtx.current;
        if (!ctx) throw new Error("Circle wallet not connected");

        // Step 1: get sign challenge from server
        const prep = await circlePost("/collect/prepare", {
          userId:     ctx.userId,
          secret,
          splitIndex,
        });

        // Step 2: show PIN UI
        setPinPending(true);
        await new Promise((resolve, reject) => {
          if (!circleSdk.current) {
            reject(new Error("Circle SDK not initialised — call initCirclePIN first"));
            return;
          }
          circleSdk.current.setAuthentication({
            userToken:     prep.challengeId,
            encryptionKey: prep.encryptionKey,
          }).then(() => {
            circleSdk.current.execute(prep.challengeId, (err, result) => {
              if (err) reject(new Error(err.message || "PIN sign failed"));
              else     resolve(result);
            });
          });
        });
        setPinPending(false);

        // Step 3: server submits collectFor() with the signature
        return await circlePost("/collect/submit", { challengeId: prep.challengeId });
      }

      // ── Readonly or no wallet: gasless via relayer ──────────────────────────
      // The relayer signs the transaction. Recipient must provide a valid
      // EIP-191 signature of collectPayload() to authorise the collect.
      // In readonly mode the UI should prompt for a signature separately,
      // or the user can use the relayer endpoint directly.
      if (authMode === AUTH_MODES.READONLY) {
        const { recipientAddress, signature } = opts;
        if (!recipientAddress || !signature) {
          throw new Error(
            "Read-only mode requires recipientAddress and signature to use the gasless relayer. " +
            "Connect MetaMask or use email login to collect directly."
          );
        }
        return await relayerPost("/relay", {
          secret,
          splitIndex,
          recipient:     recipientAddress,
          relayerFeeBps: RELAYER_FEE_BPS,
          signature,
        });
      }

      throw new Error("No auth mode — call connect() first");
    } catch (e) {
      setError(_err(e));
      setPinPending(false);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [authMode]);

  // ─────────────────────────────────────────────────────────────────────────────
  // collectAll()
  // ─────────────────────────────────────────────────────────────────────────────
  /**
   * Collect all matured splits in one operation.
   *
   * MetaMask  → single collectAll() tx
   * Circle    → one PIN sign per split (collectFor in a loop)
   * Readonly  → not supported (multiple signatures needed)
   */
  const collectAll = useCallback(async (secret, splits) => {
    setError("");
    try {
      setLoading(true);

      if (authMode === AUTH_MODES.METAMASK) {
        if (!mmContract.current) throw new Error("MetaMask not connected");
        const tx  = await mmContract.current.collectAll(secret, ARC_GAS);
        const rec = await tx.wait(1);
        return { txHash: rec.hash };
      }

      if (authMode === AUTH_MODES.CIRCLE) {
        // Collect each unlocked split individually (circle-server handles each)
        const unlockedSplits = (splits || []).filter(s => s.unlocked && !s.collected);
        if (!unlockedSplits.length) throw new Error("No unlocked splits to collect");

        const results = [];
        for (const sp of unlockedSplits) {
          // Each collect() call goes through PIN — in production you'd batch-sign
          const r = await collect(secret, sp.index);
          results.push(r);
        }
        return { collected: results.length, txHashes: results.map(r => r.txHash) };
      }

      throw new Error("collectAll is not available in read-only mode");
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, [authMode, collect]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Capability flags — use these in the UI to show/hide controls
  // ─────────────────────────────────────────────────────────────────────────────
  const canStrike   = !!wallet && authMode !== AUTH_MODES.READONLY;
  const canCollect  = !!wallet;           // readonly can collect via relayer
  const canApprove  = !!wallet && authMode !== AUTH_MODES.READONLY;
  const isMetaMask  = authMode === AUTH_MODES.METAMASK;
  const isCircle    = authMode === AUTH_MODES.CIRCLE;
  const isReadonly  = authMode === AUTH_MODES.READONLY;
  const isConnected = !!wallet;
  const isSender    = wallet?.type === "metamask" || wallet?.type === "circle-sender";
  const isRecipient = wallet?.type === "circle-recipient" || wallet?.type === "circle-recipient-pending";

  return {
    // ── State ──────────────────────────────────────────────────────────────────
    wallet,
    authMode,
    loading,
    error,
    wrongNet,
    pinPending,

    // ── Capability flags ───────────────────────────────────────────────────────
    isConnected,
    isMetaMask,
    isCircle,
    isReadonly,
    isSender,
    isRecipient,
    canStrike,
    canCollect,
    canApprove,

    // ── Auth actions ───────────────────────────────────────────────────────────
    connect,
    disconnect,
    initCirclePIN,

    // ── Core actions (same API for all modes) ──────────────────────────────────
    generateSecret,
    getBalance,
    approve,
    strike,
    getSplits,
    collect,
    collectAll,

    // ── Constants ──────────────────────────────────────────────────────────────
    AUTH_MODES,
    TOKENS,
    CONTRACT_ADDRESS,
    ARC_EXPLORER,
    ARC_FAUCET,
    RELAYER_FEE_BPS,
  };
}
