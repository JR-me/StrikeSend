/**
 * useCircleWallets.js
 * ─────────────────────────────────────────────────────────────────────────────
 * React hook that wires the StrikeSend frontend to Circle Programmable Wallets.
 *
 * Replaces useStrikeSend.js for the wallet/auth layer while keeping all the
 * same strike/collect semantics. No MetaMask. No seed phrases. No gas worries.
 *
 * ── Flow ──────────────────────────────────────────────────────────────────────
 *
 *  SENDER (developer-controlled wallet — server signs everything):
 *    loginSender(userId)          → creates wallet on server if needed
 *    approveSender(token, amount) → server calls approve() via Circle API
 *    strike(token, commitment, schedule) → server calls strike() via Circle API
 *
 *  RECIPIENT (user-controlled wallet — PIN in browser):
 *    loginRecipient(userId)       → creates wallet + returns challengeId
 *    initCircleSDK(challengeId)   → frontend Circle SDK shows PIN setup UI
 *    confirmPinComplete(cId)      → server looks up wallet address after PIN
 *    prepareCollect(secret, idx)  → server builds payload + sign challenge
 *    executeCollect(challengeId)  → user enters PIN → server submits collectFor()
 *
 *  SHARED:
 *    getSplits(secret)            → reads split schedule from chain
 *    getBalance(walletId)         → USDC/EURC balance for any wallet
 *
 * ── Install ───────────────────────────────────────────────────────────────────
 *  npm install @circle-fin/user-controlled-wallets
 *  (The Circle Web SDK — handles the PIN iframe in the browser)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *  import { useCircleWallets } from "./useCircleWallets";
 *
 *  const {
 *    loginSender, loginRecipient, initCircleSDK, confirmPinComplete,
 *    approveSender, strike, getSplits, prepareCollect, executeCollect,
 *    wallet, loading, error, pinPending,
 *  } = useCircleWallets();
 */

import { useState, useCallback, useRef } from "react";

// ─── Config ───────────────────────────────────────────────────────────────────
// URL of your circle-wallets-server.js instance
export const CIRCLE_SERVER_URL = process.env.REACT_APP_CIRCLE_SERVER || "http://localhost:3002";

// Circle App ID — from console.circle.com → User-Controlled Wallets → App ID
// Needed to initialise the Circle Web SDK in the browser
export const CIRCLE_APP_ID = process.env.REACT_APP_CIRCLE_APP_ID || "YOUR_CIRCLE_APP_ID";

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useCircleWallets() {
  const [wallet,     setWallet]     = useState(null);   // { walletId, address, type, userId }
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [pinPending, setPinPending] = useState(false);  // true while waiting for PIN input

  // Holds the Circle Web SDK instance after initCircleSDK() is called
  const sdkRef = useRef(null);

  // ─── Internal helpers ───────────────────────────────────────────────────────

  function _err(e) {
    return e?.message || String(e);
  }

  async function _post(path, body = {}) {
    const res = await fetch(`${CIRCLE_SERVER_URL}${path}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  }

  async function _get(path) {
    const res = await fetch(`${CIRCLE_SERVER_URL}${path}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  }

  // ─── Sender login (developer-controlled wallet) ─────────────────────────────
  /**
   * Creates or retrieves a developer-controlled sender wallet.
   * Server signs all transactions — no MetaMask needed.
   *
   * @param {string} userId   Your app's user ID (email, UUID, etc.)
   */
  const loginSender = useCallback(async (userId) => {
    setError("");
    try {
      setLoading(true);
      const data = await _post("/wallets/create-sender", { userId });
      const w = {
        walletId: data.walletId,
        address:  data.address,
        userId,
        type:     "sender",
      };
      setWallet(w);
      return w;
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Recipient login (user-controlled wallet — PIN auth) ────────────────────
  /**
   * Creates a user-controlled recipient wallet and starts the PIN setup flow.
   * Returns a challengeId and encryptionKey that you pass to initCircleSDK().
   *
   * @param {string} userId
   * @returns {{ challengeId, encryptionKey }}
   */
  const loginRecipient = useCallback(async (userId) => {
    setError("");
    try {
      setLoading(true);
      const data = await _post("/wallets/create-recipient", { userId });
      // Don't set wallet yet — address is only available after PIN is set
      return { challengeId: data.challengeId, encryptionKey: data.encryptionKey };
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Initialise Circle Web SDK and trigger PIN UI ───────────────────────────
  /**
   * Loads the Circle Web SDK (dynamic import) and executes the PIN challenge.
   * The SDK renders a secure PIN iframe inside your page.
   *
   * Call this after loginRecipient() returns the challengeId.
   *
   * @param {string} challengeId    From loginRecipient()
   * @param {string} encryptionKey  From loginRecipient()
   * @returns {Promise<void>}        Resolves when the user completes the PIN
   */
  const initCircleSDK = useCallback(async (challengeId, encryptionKey) => {
    setError("");
    setPinPending(true);
    try {
      // Dynamic import — Circle Web SDK is a browser-only package
      const { W3SSdk } = await import("@circle-fin/user-controlled-wallets");

      if (!sdkRef.current) {
        sdkRef.current = new W3SSdk();
        await sdkRef.current.setAppSettings({ appId: CIRCLE_APP_ID });
      }

      // Pass auth to SDK
      await sdkRef.current.setAuthentication({ userToken: challengeId, encryptionKey });

      // Execute the challenge — renders PIN iframe in the page
      await new Promise((resolve, reject) => {
        sdkRef.current.execute(challengeId, (error, result) => {
          if (error) reject(new Error(error.message || "PIN challenge failed"));
          else       resolve(result);
        });
      });
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setPinPending(false);
    }
  }, []);

  // ─── Confirm wallet address after PIN is set ────────────────────────────────
  /**
   * Called after initCircleSDK() resolves.
   * Fetches the wallet address from the server (now that PIN is confirmed).
   *
   * @param {string} challengeId
   * @param {string} userId
   */
  const confirmPinComplete = useCallback(async (challengeId, userId) => {
    setError("");
    try {
      setLoading(true);
      const data = await _post("/wallets/pin-complete", { challengeId });
      const w = {
        walletId: data.walletId,
        address:  data.address,
        userId,
        type:     "recipient",
      };
      setWallet(w);
      return w;
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Get wallet balance ─────────────────────────────────────────────────────
  /**
   * Returns USDC and EURC balances for any walletId.
   * @param {string} walletId
   * @returns {{ USDC: string, EURC: string }}
   */
  const getBalance = useCallback(async (walletId) => {
    setError("");
    try {
      const data = await _get(`/wallets/${walletId}`);
      return data.balances; // { USDC: "100.00", EURC: "0.00" }
    } catch (e) {
      setError(_err(e));
      throw e;
    }
  }, []);

  // ─── Approve token spend (sender) ──────────────────────────────────────────
  /**
   * Approves the StrikeSend contract to pull tokens from the sender's wallet.
   * Server-signed — no user interaction required.
   *
   * @param {string} userId
   * @param {string} tokenSymbol  "USDC" | "EURC"
   * @param {string} humanAmount  e.g. "500.00"
   * @returns {{ txHash }}
   */
  const approveSender = useCallback(async (userId, tokenSymbol, humanAmount) => {
    setError("");
    try {
      setLoading(true);
      return await _post("/strike/approve", { userId, tokenSymbol, humanAmount });
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Strike ─────────────────────────────────────────────────────────────────
  /**
   * Deposits tokens into StrikeSend with the sender's split schedule.
   * Server-signed — no user interaction required after approveSender().
   *
   * @param {string} userId
   * @param {string} tokenSymbol   "USDC" | "EURC"
   * @param {string} commitment    0x bytes32 — keccak256(secret), generated client-side
   * @param {Array}  schedule      [{ amount: "100.00", delaySeconds: 0 }, ...]
   *
   * NOTE: Generate the secret client-side with generateSecret() from useStrikeSend.js
   * and pass only the commitment here. Never send the raw secret to the server.
   *
   * @returns {{ txHash, numSplits }}
   */
  const strike = useCallback(async (userId, tokenSymbol, commitment, schedule) => {
    setError("");
    try {
      setLoading(true);
      return await _post("/strike/execute", { userId, tokenSymbol, commitment, schedule });
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Get splits (read-only) ─────────────────────────────────────────────────
  /**
   * Fetches split schedule for a given secret.
   * No wallet or auth required — reads directly from chain.
   *
   * @param {string} secret  0x bytes32 hex
   * @returns {{ token: string, splits: SplitRow[] }}
   */
  const getSplits = useCallback(async (secret) => {
    setError("");
    try {
      setLoading(true);
      return await _get(`/splits/${secret}`);
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Prepare collect (recipient) ────────────────────────────────────────────
  /**
   * Step 1 of the PIN-gated collect flow.
   * The server fetches the collectPayload from the contract and creates a
   * Circle sign challenge. The user must enter their PIN to sign it.
   *
   * @param {string} userId
   * @param {string} secret
   * @param {number} splitIndex
   * @returns {{ challengeId, encryptionKey }}
   */
  const prepareCollect = useCallback(async (userId, secret, splitIndex) => {
    setError("");
    try {
      setLoading(true);
      return await _post("/collect/prepare", { userId, secret, splitIndex });
    } catch (e) {
      setError(_err(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Execute collect (recipient — PIN flow) ─────────────────────────────────
  /**
   * Full two-step collect flow:
   *   1. Calls prepareCollect() to get the sign challenge
   *   2. Shows the Circle PIN UI via initCircleSDK()
   *   3. Calls /collect/submit to relay the signed collectFor()
   *
   * This is the main "Collect" button handler — call this from the UI.
   *
   * @param {string} userId
   * @param {string} secret
   * @param {number} splitIndex
   * @returns {{ txHash, recipientAddr }}
   */
  const executeCollect = useCallback(async (userId, secret, splitIndex) => {
    setError("");
    try {
      setLoading(true);

      // Step 1 — get challengeId + encryptionKey from server
      const { challengeId, encryptionKey } = await prepareCollect(userId, secret, splitIndex);

      // Step 2 — show PIN UI and wait for user to sign
      setPinPending(true);
      await initCircleSDK(challengeId, encryptionKey);
      setPinPending(false);

      // Step 3 — server submits collectFor() with the signature
      const result = await _post("/collect/submit", { challengeId });
      return result; // { txHash, recipientAddr }
    } catch (e) {
      setError(_err(e));
      setPinPending(false);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [prepareCollect, initCircleSDK]);

  // ─── Server health ──────────────────────────────────────────────────────────
  const getServerHealth = useCallback(async () => {
    try {
      const res = await fetch(`${CIRCLE_SERVER_URL}/health`);
      return await res.json();
    } catch {
      return { status: "offline" };
    }
  }, []);

  return {
    // State
    wallet,
    loading,
    error,
    pinPending,
    connected:  !!wallet,
    isSender:   wallet?.type === "sender",
    isRecipient: wallet?.type === "recipient",

    // Sender flow
    loginSender,
    approveSender,
    strike,

    // Recipient flow
    loginRecipient,
    initCircleSDK,
    confirmPinComplete,
    prepareCollect,
    executeCollect,

    // Shared
    getSplits,
    getBalance,
    getServerHealth,

    // Constants
    CIRCLE_SERVER_URL,
    CIRCLE_APP_ID,
  };
}
