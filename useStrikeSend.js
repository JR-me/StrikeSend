/**
 * useStrikeSend.js — v3
 * ─────────────────────────────────────────────────────────────────────────────
 * React hook wiring StrikeSend v3 (ERC-20, Arc Testnet) to the UI.
 *
 * Key changes from v2:
 *  • Network    : Arc Testnet (chainId 5042002) — not Sepolia
 *  • Gas token  : USDC (native on Arc). No ETH anywhere.
 *  • strike()   : takes (tokenAddress, commitment, SplitParam[]) — no msg.value
 *  • Approve    : ERC-20 approve() required before every strike()
 *  • getSplits(): returns (token, amounts[], releaseTimes[], collected[])
 *  • Amounts    : formatUnits(amt, 6) — not formatEther()
 *  • Gas        : maxFeePerGas >= 20 Gwei (Arc protocol floor), set to 25 Gwei
 *  • Auto-add   : addArcNetwork() adds Arc Testnet to MetaMask if not present
 *
 * Install:  npm install ethers
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { ethers } from "ethers";

// ─── Arc Testnet network ──────────────────────────────────────────────────────
export const CHAIN_ID     = 5042002;
export const CHAIN_HEX    = "0x4CDB52";           // hex of 5042002
export const NETWORK_NAME = "Arc Testnet";
export const ARC_RPC      = "https://rpc.testnet.arc.network";
export const ARC_EXPLORER = "https://testnet.arcscan.app";
export const ARC_FAUCET   = "https://faucet.circle.com";

// ─── Token addresses (official Arc Testnet — docs.arc.io) ────────────────────
export const TOKENS = {
  USDC: {
    symbol:   "USDC",
    name:     "USD Coin",
    address:  "0x3600000000000000000000000000000000000000",
    decimals: 6,
    color:    "#2775ca",
    badge:    "$",
  },
  EURC: {
    symbol:   "EURC",
    name:     "Euro Coin",
    address:  "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    decimals: 6,
    color:    "#1a56db",
    badge:    "€",
  },
};

// ─── Contract ─────────────────────────────────────────────────────────────────
// Paste your deployed StrikeSend address here after Remix deploy on Arc Testnet
export const CONTRACT_ADDRESS = "0xYOUR_STRIKESEND_ADDRESS_HERE";

// ─── Relayer ──────────────────────────────────────────────────────────────────
export const RELAYER_URL     = "http://localhost:3001";
export const RELAYER_FEE_BPS = 50; // 0.5 % — must match relayer .env

// ─── Gas overrides (Arc EIP-1559) ─────────────────────────────────────────────
// Arc enforces a 20 Gwei minimum base fee. Txs below this stay pending.
// We default to 25 Gwei (5 Gwei headroom) + 1 Gwei tip.
export const ARC_GAS = {
  maxFeePerGas:         ethers.parseUnits("25", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("1",  "gwei"),
};

// ─── StrikeSend ABI — v3 (ERC-20, configurable splits) ───────────────────────
export const STRIKESEND_ABI = [
  // Write
  "function strike(address token, bytes32 commitment, tuple(uint256 amount, uint256 delaySeconds)[] params) external",
  "function collect(bytes32 secret, uint256 splitIndex) external",
  "function collectAll(bytes32 secret) external",
  "function collectFor(bytes32 secret, uint256 splitIndex, address recipient, uint256 relayerFeeBps, bytes signature) external",
  // Admin
  "function setTokenAllowed(address token, bool allowed) external",
  "function transferOwnership(address newOwner) external",
  // Read
  "function getSplits(bytes32 secret) external view returns (address token, uint256[] amounts, uint256[] releaseTimes, bool[] collected)",
  "function unlocked(bytes32 secret) external view returns (uint256 total)",
  "function toCommitment(bytes32 secret) external pure returns (bytes32)",
  "function collectPayload(bytes32 secret, uint256 splitIndex, address recipient, uint256 relayerFeeBps) external view returns (bytes32)",
  "function tokenAllowed(address) external view returns (bool)",
  "function owner() external view returns (address)",
  // Events
  "event Struck(bytes32 indexed commitment, address indexed token, address indexed striker, uint256 totalAmount, uint256 numSplits, uint256 timestamp)",
  "event SplitScheduled(bytes32 indexed commitment, uint256 splitIndex, uint256 amount, uint256 releaseTime)",
  "event Collected(bytes32 indexed commitment, uint256 splitIndex, address indexed token, address indexed recipient, address relayer, uint256 payout, uint256 relayerFee, uint256 timestamp)",
  "event TokenAllowed(address indexed token, bool allowed)",
];

// ─── ERC-20 ABI ───────────────────────────────────────────────────────────────
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useStrikeSend() {
  const [wallet,   setWallet]   = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer,   setSigner]   = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");
  const [wrongNet, setWrongNet] = useState(false);

  const contractRef = useRef(null);

  // ── Internal factories ──────────────────────────────────────────────────────
  function _ss(sp)  { return new ethers.Contract(CONTRACT_ADDRESS, STRIKESEND_ABI, sp); }
  function _tok(addr, sp) { return new ethers.Contract(addr, ERC20_ABI, sp); }
  const _prov = useCallback(() => provider || new ethers.JsonRpcProvider(ARC_RPC), [provider]);

  function _msg(e) {
    return e?.info?.error?.message || e?.reason || e?.shortMessage || e?.message || "Error";
  }

  function _decimals(tokenAddr) {
    return Object.values(TOKENS).find(
      t => t.address.toLowerCase() === tokenAddr?.toLowerCase()
    )?.decimals ?? 6;
  }

  function _fmt(raw, tokenAddr) {
    return ethers.formatUnits(raw, _decimals(tokenAddr));
  }

  // ── Add Arc Testnet to wallet ───────────────────────────────────────────────
  const addArcNetwork = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId:           CHAIN_HEX,
          chainName:         NETWORK_NAME,
          // Arc native token is USDC with 18-decimal precision internally
          // (wallets that don't support custom gas tokens show "ETH" — that's OK)
          nativeCurrency:    { name: "USD Coin", symbol: "USDC", decimals: 18 },
          rpcUrls:           [ARC_RPC],
          blockExplorerUrls: [ARC_EXPLORER],
        }],
      });
    } catch (e) {
      console.warn("addArcNetwork:", e.message);
    }
  }, []);

  // ── Connect wallet ──────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    setError("");
    if (!window.ethereum) { setError("No wallet found — install MetaMask."); return null; }
    try {
      setLoading(true);
      await window.ethereum.request({ method: "eth_requestAccounts" });
      const prov = new ethers.BrowserProvider(window.ethereum);
      const net  = await prov.getNetwork();

      if (Number(net.chainId) !== CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: CHAIN_HEX }],
          });
        } catch (sw) {
          // 4902 = chain unknown — add it then retry
          if (sw.code === 4902 || sw?.error?.code === 4902) {
            await addArcNetwork();
            // retry switch
            await window.ethereum.request({
              method: "wallet_switchEthereumChain",
              params: [{ chainId: CHAIN_HEX }],
            });
          } else {
            setWrongNet(true);
            setError(`Switch MetaMask to ${NETWORK_NAME} and try again.`);
            return null;
          }
        }
      }

      const prov2 = new ethers.BrowserProvider(window.ethereum);
      const sign  = await prov2.getSigner();
      const addr  = await sign.getAddress();

      setProvider(prov2);
      setSigner(sign);
      setWrongNet(false);
      contractRef.current = _ss(sign);

      const w = { address: addr, shortAddress: addr.slice(0,6) + "…" + addr.slice(-4) };
      setWallet(w);
      return w;
    } catch (e) {
      setError(_msg(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [addArcNetwork]);

  const disconnect = useCallback(() => {
    setWallet(null); setProvider(null); setSigner(null);
    setWrongNet(false); contractRef.current = null;
  }, []);

  // ── Chain / account listeners ───────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const onAcc   = () => disconnect();
    const onChain = () => window.location.reload();
    window.ethereum.on("accountsChanged", onAcc);
    window.ethereum.on("chainChanged",    onChain);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAcc);
      window.ethereum.removeListener("chainChanged",    onChain);
    };
  }, [disconnect]);

  // ── Token balance ───────────────────────────────────────────────────────────
  const getTokenBalance = useCallback(async (tokenSymbol, addr) => {
    const tok = TOKENS[tokenSymbol];
    if (!tok) throw new Error("Unknown token");
    const raw = await _tok(tok.address, _prov()).balanceOf(addr);
    return ethers.formatUnits(raw, tok.decimals);
  }, [_prov]);

  // ── Check / grant allowance ─────────────────────────────────────────────────
  const hasAllowance = useCallback(async (tokenSymbol, humanAmount) => {
    if (!wallet) return false;
    const tok     = TOKENS[tokenSymbol]; if (!tok) return false;
    const allowed = await _tok(tok.address, _prov()).allowance(wallet.address, CONTRACT_ADDRESS);
    return allowed >= ethers.parseUnits(humanAmount, tok.decimals);
  }, [wallet, _prov]);

  /**
   * approve(tokenSymbol, humanAmount)
   * Grants the StrikeSend contract permission to pull tokens.
   * Call this before strike() when hasAllowance() returns false.
   */
  const approveToken = useCallback(async (tokenSymbol, humanAmount) => {
    setError("");
    if (!signer) throw new Error("Wallet not connected");
    const tok = TOKENS[tokenSymbol]; if (!tok) throw new Error("Unknown token");
    try {
      setLoading(true);
      const raw = ethers.parseUnits(humanAmount, tok.decimals);
      const tx  = await _tok(tok.address, signer).approve(CONTRACT_ADDRESS, raw, ARC_GAS);
      const rec = await tx.wait(1);
      return { txHash: rec.hash };
    } catch (e) { setError(_msg(e)); throw e; }
    finally     { setLoading(false); }
  }, [signer]);

  // ── Generate secret ─────────────────────────────────────────────────────────
  /**
   * Returns { secret, commitment }.
   * secret     — random 0x 32-byte hex. Share with recipient off-chain.
   * commitment — keccak256(secret). Passed on-chain inside strike().
   */
  const generateSecret = useCallback(() => {
    const secret     = ethers.hexlify(ethers.randomBytes(32));
    const commitment = ethers.keccak256(
      ethers.solidityPacked(["bytes32"], [secret])
    );
    return { secret, commitment };
  }, []);

  // ── Strike ──────────────────────────────────────────────────────────────────
  /**
   * Deposits ERC-20 tokens with a sender-defined split schedule.
   *
   * @param {string} tokenSymbol   "USDC" | "EURC"
   * @param {string} commitment    0x bytes32 from generateSecret()
   * @param {Array}  schedule      [{ amount: "100.00", delayMs: 3600000 }, ...]
   *
   * amount   — human-readable string ("100.00")
   * delayMs  — milliseconds until this split unlocks (0 = immediate)
   *
   * Requires: approveToken() called first with totalAmount.
   */
  const strike = useCallback(async (tokenSymbol, commitment, schedule) => {
    setError("");
    if (!contractRef.current) throw new Error("Wallet not connected");
    const tok = TOKENS[tokenSymbol]; if (!tok) throw new Error("Unknown token");
    try {
      setLoading(true);

      // Convert to on-chain types: raw 6-decimal amount + delay in seconds
      const params = schedule.map(s => ({
        amount:       ethers.parseUnits(
                        parseFloat(s.amount || "0").toFixed(tok.decimals),
                        tok.decimals
                      ),
        delaySeconds: BigInt(Math.max(0, Math.floor((s.delayMs || 0) / 1000))),
      }));

      const tx  = await contractRef.current.strike(tok.address, commitment, params, ARC_GAS);
      const rec = await tx.wait(1);

      let numSplits = schedule.length;
      const iface = new ethers.Interface(STRIKESEND_ABI);
      for (const log of rec.logs) {
        try {
          const p = iface.parseLog(log);
          if (p?.name === "Struck") numSplits = Number(p.args.numSplits);
        } catch {}
      }
      return { txHash: rec.hash, numSplits, receipt: rec };
    } catch (e) { setError(_msg(e)); throw e; }
    finally     { setLoading(false); }
  }, []);

  // ── getSplits ───────────────────────────────────────────────────────────────
  /**
   * @param {string} secret
   * @param {'contract'|'relayer'} source
   * @returns {{ token: string, splits: SplitRow[] }}
   *
   * SplitRow: { index, amountRaw, amount, releaseTime, releaseMs, collected, unlocked }
   */
  const getSplits = useCallback(async (secret, source = "contract") => {
    setError("");
    try {
      setLoading(true);

      if (source === "relayer") {
        const res  = await fetch(`${RELAYER_URL}/splits/${secret}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Relayer lookup failed");
        return data; // server returns { token, splits }
      }

      const prov = _prov();
      const c    = contractRef.current || _ss(prov);

      // v3 signature: (address token, uint256[] amounts, uint256[] releaseTimes, bool[] collected)
      const [tokenAddr, amounts, releaseTimes, collected] = await c.getSplits(secret);
      const now = Math.floor(Date.now() / 1000);
      const sym = Object.values(TOKENS).find(
        t => t.address.toLowerCase() === tokenAddr.toLowerCase()
      )?.symbol || "USDC";
      const dec = TOKENS[sym]?.decimals ?? 6;

      return {
        token: sym,
        splits: amounts.map((amt, i) => ({
          index:       i,
          amountRaw:   amt.toString(),
          amount:      ethers.formatUnits(amt, dec),
          releaseTime: Number(releaseTimes[i]),
          releaseMs:   Number(releaseTimes[i]) * 1000,
          collected:   collected[i],
          unlocked:    !collected[i] && Number(releaseTimes[i]) <= now,
        })),
      };
    } catch (e) { setError(_msg(e)); throw e; }
    finally     { setLoading(false); }
  }, [_prov]);

  // ── Collect direct ──────────────────────────────────────────────────────────
  const collectDirect = useCallback(async (secret, splitIndex) => {
    setError("");
    if (!contractRef.current) throw new Error("Wallet not connected");
    try {
      setLoading(true);
      const tx  = await contractRef.current.collect(secret, splitIndex, ARC_GAS);
      const rec = await tx.wait(1);

      const iface = new ethers.Interface(STRIKESEND_ABI);
      let payout = "", fee = "";
      for (const log of rec.logs) {
        try {
          const p = iface.parseLog(log);
          if (p?.name === "Collected") {
            const d = _decimals(p.args.token);
            payout = ethers.formatUnits(p.args.payout, d);
            fee    = ethers.formatUnits(p.args.relayerFee, d);
          }
        } catch {}
      }
      return { txHash: rec.hash, payout, relayerFee: fee };
    } catch (e) { setError(_msg(e)); throw e; }
    finally     { setLoading(false); }
  }, []);

  // ── Collect all direct ──────────────────────────────────────────────────────
  const collectAllDirect = useCallback(async (secret) => {
    setError("");
    if (!contractRef.current) throw new Error("Wallet not connected");
    try {
      setLoading(true);
      const tx  = await contractRef.current.collectAll(secret, ARC_GAS);
      const rec = await tx.wait(1);

      const iface = new ethers.Interface(STRIKESEND_ABI);
      let total = 0n, dec = 6;
      for (const log of rec.logs) {
        try {
          const p = iface.parseLog(log);
          if (p?.name === "Collected") {
            dec   = _decimals(p.args.token);
            total += p.args.payout;
          }
        } catch {}
      }
      return { txHash: rec.hash, totalAmount: ethers.formatUnits(total, dec) };
    } catch (e) { setError(_msg(e)); throw e; }
    finally     { setLoading(false); }
  }, []);

  // ── Collect via relayer (gasless) ───────────────────────────────────────────
  /**
   * Recipient signs off-chain; relayer calls collectFor() and pays USDC gas.
   * @param {string} secret
   * @param {number} splitIndex
   * @param {string} [recipientAddr]  defaults to connected wallet
   */
  const collectViaRelayer = useCallback(async (secret, splitIndex, recipientAddr) => {
    setError("");
    if (!signer) throw new Error("Wallet must be connected to sign");
    const recipient = recipientAddr || wallet?.address;
    if (!recipient) throw new Error("No recipient address");
    try {
      setLoading(true);

      // Fetch exact payload from contract (chain-ID bound — no cross-chain replay)
      const payload   = await _ss(_prov()).collectPayload(
        secret,
        BigInt(splitIndex),
        recipient,
        BigInt(RELAYER_FEE_BPS)
      );

      // EIP-191 sign — ethers prepends "\x19Ethereum Signed Message:\n32"
      const signature = await signer.signMessage(ethers.getBytes(payload));

      const res = await fetch(`${RELAYER_URL}/relay`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, splitIndex, recipient, relayerFeeBps: RELAYER_FEE_BPS, signature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Relay failed");
      return data; // { txHash, payout, relayerFee }
    } catch (e) { setError(_msg(e)); throw e; }
    finally     { setLoading(false); }
  }, [signer, wallet, _prov]);

  // ── Relayer health ──────────────────────────────────────────────────────────
  const getRelayerHealth = useCallback(async () => {
    try { return await (await fetch(`${RELAYER_URL}/health`)).json(); }
    catch { return { status: "offline" }; }
  }, []);

  return {
    wallet, provider, signer, loading, error, wrongNet,
    connected: !!wallet,
    addArcNetwork, connect, disconnect,
    getTokenBalance, hasAllowance, approveToken,
    generateSecret,
    strike, getSplits,
    collectDirect, collectAllDirect, collectViaRelayer,
    getRelayerHealth,
    // Expose constants so UI can import from the hook
    TOKENS, CONTRACT_ADDRESS, RELAYER_URL, RELAYER_FEE_BPS,
    CHAIN_ID, NETWORK_NAME, ARC_EXPLORER, ARC_FAUCET,
  };
}
