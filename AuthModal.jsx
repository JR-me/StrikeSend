/**
 * AuthModal.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Login / connect screen shown before the main StrikeSend app.
 * Lets users pick their auth mode:
 *
 *   [ Connect Wallet ]   → MetaMask / injected browser wallet
 *   [ Use Email ]        → Circle Programmable Wallets (PIN-based)
 *   [ Look up only ]     → No wallet, read-only (paste a secret to collect)
 *
 * Handles:
 *   • MetaMask detection (grey out if not installed)
 *   • Circle: email input + role selection (sender / recipient)
 *   • Circle: PIN setup flow (renders Circle SDK iframe)
 *   • Error display per mode
 *   • "Wrong network" banner for MetaMask users
 *
 * Usage:
 *   import AuthModal from "./AuthModal";
 *   import { useAuth, AUTH_MODES } from "./useAuth";
 *
 *   const auth = useAuth();
 *   if (!auth.isConnected) return <AuthModal auth={auth} />;
 */

import { useState, useEffect } from "react";
import { AUTH_MODES } from "./useAuth";

const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@600;700;900&family=DM+Sans:wght@400;500;600&display=swap');

.am-overlay{position:fixed;inset:0;background:rgba(6,6,8,.92);display:flex;align-items:center;justify-content:center;z-index:1000;padding:1rem;backdrop-filter:blur(6px)}
.am-box{background:linear-gradient(148deg,#141418 0%,#0e0e14 100%);border:.5px solid rgba(200,200,220,.14);border-radius:20px;padding:2rem;width:100%;max-width:420px;position:relative;overflow:hidden}
.am-box::before{content:'';position:absolute;top:0;left:0;right:0;height:.5px;background:linear-gradient(90deg,transparent,rgba(200,200,220,.28),transparent)}
.am-logo{width:52px;height:52px;border-radius:13px;object-fit:cover;border:.5px solid rgba(200,200,220,.18)}
.am-title{font-family:'Orbitron',monospace;font-size:16px;font-weight:900;letter-spacing:.1em;background:linear-gradient(130deg,#808090 0%,#d8d8e8 40%,#909098 70%,#c0c0cc 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.am-sub{font-family:'Orbitron',monospace;font-size:7px;color:#686876;letter-spacing:.22em;margin-top:3px}
.am-card{background:rgba(10,10,16,.8);border:.5px solid rgba(200,200,220,.13);border-radius:14px;padding:1.1rem 1.25rem;margin-bottom:.65rem;cursor:pointer;transition:border-color .2s,background .2s;position:relative}
.am-card:hover{border-color:rgba(200,200,220,.3);background:rgba(20,20,28,.9)}
.am-card.selected{border-color:rgba(91,164,232,.45);background:rgba(91,164,232,.06)}
.am-card.disabled{opacity:.4;cursor:not-allowed;pointer-events:none}
.am-card-title{font-family:'Orbitron',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;color:#c0c0cc;margin-bottom:4px}
.am-card-desc{font-size:12px;color:#585868;line-height:1.7}
.am-badge{display:inline-flex;align-items:center;gap:4px;font-family:'Orbitron',monospace;font-size:7px;font-weight:700;padding:2px 8px;border-radius:99px;letter-spacing:.12em;text-transform:uppercase;border:.5px solid;white-space:nowrap;float:right;margin-top:-2px}
.badge-green{color:#4ade80;background:rgba(74,222,128,.08);border-color:rgba(74,222,128,.28)}
.badge-blue{color:#5ba4e8;background:rgba(91,164,232,.1);border-color:rgba(91,164,232,.32)}
.badge-grey{color:#686876;background:rgba(200,200,220,.05);border-color:rgba(200,200,220,.12)}
.am-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;margin-right:12px;float:left}
.am-input{width:100%;background:rgba(8,8,14,.9);border:.5px solid rgba(200,200,220,.16);border-radius:9px;padding:10px 13px;font-size:13px;color:#d0d0e0;font-family:'DM Sans',sans-serif;outline:none;transition:border-color .2s;margin-top:10px;box-sizing:border-box}
.am-input:focus{border-color:rgba(200,200,220,.38)}
.am-role-row{display:flex;gap:8px;margin-top:10px}
.am-role{flex:1;padding:8px 0;text-align:center;border:.5px solid rgba(200,200,220,.16);border-radius:8px;font-family:'Orbitron',monospace;font-size:9px;font-weight:700;letter-spacing:.1em;cursor:pointer;color:#686876;background:transparent;transition:all .2s}
.am-role:hover{border-color:rgba(200,200,220,.3);color:#a0a0b0}
.am-role.active{border-color:rgba(91,164,232,.45);background:rgba(91,164,232,.1);color:#5ba4e8}
.am-btn{width:100%;padding:13px;font-family:'Orbitron',monospace;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;border:none;border-radius:9px;cursor:pointer;transition:opacity .2s,transform .15s;margin-top:14px;position:relative;overflow:hidden}
.am-btn-primary{background:linear-gradient(130deg,#404050 0%,#c8c8d8 35%,#808090 65%,#b8b8cc 100%);background-size:200% auto;color:#0a0a0e}
.am-btn-primary:hover{background-position:right center;transform:translateY(-1px)}
.am-btn-primary:disabled{opacity:.35;cursor:not-allowed;transform:none}
.am-btn-ghost{background:transparent;color:#808090;border:.5px solid rgba(200,200,220,.2)}
.am-btn-ghost:hover{border-color:rgba(200,200,220,.4);color:#b0b0c0;transform:translateY(-1px)}
.am-err{background:rgba(248,113,113,.08);border:.5px solid rgba(248,113,113,.22);border-radius:10px;padding:9px 13px;font-size:12px;color:#f87171;margin-top:10px;line-height:1.7}
.am-warn{background:rgba(250,204,21,.07);border:.5px solid rgba(250,204,21,.22);border-radius:10px;padding:9px 13px;font-size:12px;color:#facc15;margin-top:10px;line-height:1.7}
.am-pin-box{text-align:center;padding:1.5rem 0}
.am-pin-icon{font-size:40px;margin-bottom:12px}
.am-pin-title{font-family:'Orbitron',monospace;font-size:12px;font-weight:700;color:#c0c0cc;letter-spacing:.08em;margin-bottom:8px}
.am-pin-desc{font-size:12px;color:#585868;line-height:1.7}
.am-divider{border:none;border-top:.5px solid rgba(200,200,220,.1);margin:1rem 0}
.am-link{color:#5ba4e8;font-size:12px;text-decoration:none;border-bottom:.5px solid rgba(91,164,232,.3);padding-bottom:1px}
.am-link:hover{color:#80c0f8}
.am-spin{width:14px;height:14px;border:2px solid rgba(200,200,220,.15);border-top-color:#c0c0cc;border-radius:50%;animation:amspin .7s linear infinite;display:inline-block;vertical-align:middle;margin-right:6px}
@keyframes amspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.am-check{color:#4ade80;font-size:14px;margin-right:4px}
`;

function StyleInjector() {
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = STYLES;
    document.head.appendChild(el);
    return () => document.head.removeChild(el);
  }, []);
  return null;
}

// ─── MetaMask card ─────────────────────────────────────────────────────────────
function MetaMaskCard({ auth, selected, onSelect, onConnect }) {
  const hasMetaMask = typeof window !== "undefined" && !!window.ethereum;

  return (
    <div
      className={`am-card ${selected ? "selected" : ""} ${!hasMetaMask ? "disabled" : ""}`}
      onClick={hasMetaMask ? onSelect : undefined}
    >
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div className="am-icon" style={{ background: "rgba(245,130,32,.1)", border: ".5px solid rgba(245,130,32,.3)" }}>
          🦊
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div className="am-card-title">Connect Wallet</div>
            {hasMetaMask
              ? <span className="am-badge badge-green">● Detected</span>
              : <span className="am-badge badge-grey">Not installed</span>}
          </div>
          <div className="am-card-desc">
            MetaMask, Coinbase Wallet, or any injected browser wallet.
            You pay gas in USDC.
          </div>
          {!hasMetaMask && (
            <div style={{ marginTop: 6, fontSize: 11, color: "#5ba4e8" }}>
              <a className="am-link" href="https://metamask.io" target="_blank" rel="noreferrer">
                Install MetaMask ↗
              </a>{" "}
              or use email login below.
            </div>
          )}
        </div>
      </div>

      {selected && hasMetaMask && (
        <>
          {auth.wrongNet && (
            <div className="am-warn" style={{ marginTop: 10 }}>
              ⚠ Switch MetaMask to <strong>Arc Testnet</strong> (Chain ID 5042002) and try again.
            </div>
          )}
          <button
            className="am-btn am-btn-primary"
            onClick={(e) => { e.stopPropagation(); onConnect(); }}
            disabled={auth.loading}
          >
            {auth.loading
              ? <><span className="am-spin" />Connecting…</>
              : "Connect MetaMask"}
          </button>
        </>
      )}
    </div>
  );
}

// ─── Circle email card ─────────────────────────────────────────────────────────
function CircleCard({ auth, selected, onSelect, onConnect, onPinComplete }) {
  const [email, setEmail]   = useState("");
  const [role,  setRole]    = useState("sender");
  const [phase, setPhase]   = useState("form"); // form | pin | done
  const [challengeId, setChallengeId] = useState(null);
  const [encKey, setEncKey] = useState(null);

  const handleConnect = async () => {
    if (!email.trim()) return;
    const result = await onConnect(email.trim(), role);
    if (!result) return;

    if (result.needsPin) {
      // Recipient: need PIN setup
      setChallengeId(result.challengeId);
      setEncKey(result.encryptionKey);
      setPhase("pin");
    }
    // Sender: wallet ready immediately — done
  };

  const handlePin = async () => {
    if (!challengeId) return;
    await auth.initCirclePIN(challengeId, encKey, email.trim());
    setPhase("done");
    if (onPinComplete) onPinComplete();
  };

  return (
    <div
      className={`am-card ${selected ? "selected" : ""}`}
      onClick={onSelect}
    >
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div className="am-icon" style={{ background: "rgba(91,164,232,.1)", border: ".5px solid rgba(91,164,232,.3)" }}>
          ✉️
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div className="am-card-title">Use Email</div>
            <span className="am-badge badge-blue">No wallet needed</span>
          </div>
          <div className="am-card-desc">
            Circle Programmable Wallets. No MetaMask, no seed phrases.
            Senders are server-signed. Recipients use a 6-digit PIN.
          </div>
        </div>
      </div>

      {selected && (
        <>
          {phase === "form" && (
            <>
              <input
                className="am-input"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleConnect()}
                onClick={e => e.stopPropagation()}
              />
              <div className="am-role-row" onClick={e => e.stopPropagation()}>
                <button
                  className={`am-role ${role === "sender" ? "active" : ""}`}
                  onClick={() => setRole("sender")}
                >
                  Sender
                </button>
                <button
                  className={`am-role ${role === "recipient" ? "active" : ""}`}
                  onClick={() => setRole("recipient")}
                >
                  Recipient
                </button>
              </div>
              <div style={{ fontSize: 11, color: "#484858", marginTop: 8, lineHeight: 1.7 }}>
                {role === "sender"
                  ? "Server signs approve() and strike() for you — instant, no popups."
                  : "You set a 6-digit PIN to authorise collects. Gasless — no USDC needed."}
              </div>
              <button
                className="am-btn am-btn-primary"
                onClick={(e) => { e.stopPropagation(); handleConnect(); }}
                disabled={auth.loading || !email.trim()}
              >
                {auth.loading
                  ? <><span className="am-spin" />Setting up wallet…</>
                  : "Continue with Email"}
              </button>
            </>
          )}

          {phase === "pin" && (
            <div className="am-pin-box" onClick={e => e.stopPropagation()}>
              <div className="am-pin-icon">🔐</div>
              <div className="am-pin-title">Set Your PIN</div>
              <div className="am-pin-desc" style={{ marginBottom: 14 }}>
                Circle will show a secure PIN setup screen.
                Choose a 6-digit PIN — it's the only way to authorise collects.
                Circle never sees your PIN.
              </div>
              <button
                className="am-btn am-btn-primary"
                onClick={handlePin}
                disabled={auth.pinPending || auth.loading}
              >
                {auth.pinPending
                  ? <><span className="am-spin" />Waiting for PIN…</>
                  : "Set Up PIN →"}
              </button>
            </div>
          )}

          {phase === "done" && (
            <div style={{ textAlign: "center", padding: "1rem 0 .5rem" }}>
              <span className="am-check">✓</span>
              <span style={{ fontSize: 12, color: "#4ade80" }}>Wallet ready</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Readonly card ─────────────────────────────────────────────────────────────
function ReadonlyCard({ auth, selected, onSelect, onConnect }) {
  return (
    <div
      className={`am-card ${selected ? "selected" : ""}`}
      onClick={onSelect}
    >
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div className="am-icon" style={{ background: "rgba(100,100,110,.12)", border: ".5px solid rgba(200,200,220,.12)" }}>
          🔍
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div className="am-card-title">Look Up Only</div>
            <span className="am-badge badge-grey">No login</span>
          </div>
          <div className="am-card-desc">
            Paste a secret key to check split status. To collect,
            the gasless relayer will handle it — no gas required.
          </div>
        </div>
      </div>

      {selected && (
        <button
          className="am-btn am-btn-ghost"
          onClick={(e) => { e.stopPropagation(); onConnect(); }}
          disabled={auth.loading}
          style={{ border: ".5px solid rgba(200,200,220,.2)" }}
        >
          Continue without wallet
        </button>
      )}
    </div>
  );
}

// ─── Main AuthModal ────────────────────────────────────────────────────────────
export default function AuthModal({ auth, logoSrc }) {
  const [selected, setSelected] = useState(null); // "metamask" | "circle" | "readonly"

  const handleMetaMask = async () => {
    await auth.connect(AUTH_MODES.METAMASK);
  };

  const handleCircle = async (email, role) => {
    return await auth.connect(AUTH_MODES.CIRCLE, { userId: email, role });
  };

  const handleReadonly = async () => {
    await auth.connect(AUTH_MODES.READONLY);
  };

  return (
    <>
      <StyleInjector />
      <div className="am-overlay">
        <div className="am-box">

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: "1.5rem" }}>
            {logoSrc && <img className="am-logo" src={logoSrc} alt="StrikeSend" />}
            <div>
              <div className="am-title">STRIKESEND</div>
              <div className="am-sub">PRIVATE · SECURE · INSTANT</div>
            </div>
          </div>

          <div style={{ fontSize: 13, color: "#585868", marginBottom: "1.1rem", lineHeight: 1.7 }}>
            Choose how you want to connect. All options work with Arc Testnet — USDC &amp; EURC.
          </div>

          {/* Error banner */}
          {auth.error && (
            <div className="am-err">{auth.error}</div>
          )}

          {/* Option A — MetaMask */}
          <MetaMaskCard
            auth={auth}
            selected={selected === "metamask"}
            onSelect={() => setSelected("metamask")}
            onConnect={handleMetaMask}
          />

          {/* Option B — Circle email */}
          <CircleCard
            auth={auth}
            selected={selected === "circle"}
            onSelect={() => setSelected("circle")}
            onConnect={handleCircle}
            onPinComplete={() => {/* wallet state already set in useAuth */}}
          />

          {/* Option C — Readonly */}
          <ReadonlyCard
            auth={auth}
            selected={selected === "readonly"}
            onSelect={() => setSelected("readonly")}
            onConnect={handleReadonly}
          />

          {/* Footer */}
          <div style={{ marginTop: "1.25rem", textAlign: "center", fontSize: 11, color: "#383848", lineHeight: 1.8 }}>
            Arc Testnet · Chain 5042002 · USDC gas ·{" "}
            <a className="am-link" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
              Get test tokens ↗
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
