# StrikeSend

> Private · Secure · Instant

A privacy layer for USDC and EURC transfers on Arc Testnet. Breaks the on-chain link between sender and recipient using a time-delayed, sender-defined split escrow.

## How it works

1. **Sender strikes** — deposits USDC/EURC with a split schedule (1–7 splits, custom delays)
2. **Secret shared off-chain** — raw secret sent to recipient via Signal or encrypted message
3. **Recipient collects** — presents secret to claim each split as it unlocks

No on-chain link between sender and recipient is ever created.

## Auth modes

| Mode | Who | How |
|---|---|---|
| MetaMask | Existing wallet users | Browser wallet, pays USDC gas |
| Circle email + PIN | New users | No wallet needed, gasless collect |
| Read-only | Anyone | Paste secret key, use relayer |

## Network

- **Chain:** Arc Testnet (Chain ID 5042002)
- **RPC:** https://rpc.testnet.arc.network
- **Explorer:** https://testnet.arcscan.app
- **Gas token:** USDC (native on Arc)
- **Tokens:** USDC · EURC

## Files

| File | Purpose |
|---|---|
| `index.html` | Frontend — open directly or deploy to Vercel |
| `StrikeSend.sol` | Smart contract — deploy on Remix |
| `relayer.js` | Gasless relayer server (port 3001) |
| `circle-wallets-server.js` | Circle Programmable Wallets server (port 3002) |
| `useAuth.js` | Unified auth hook (MetaMask + Circle + readonly) |
| `useStrikeSend.js` | MetaMask hook |
| `useCircleWallets.js` | Circle hook |
| `AuthModal.jsx` | Login screen component |
| `bot.js` | Multi-wallet test bot |

## Setup

### 1. Deploy the contract
Open Remix → paste `StrikeSend.sol` → compile 0.8.20 → deploy on Arc Testnet with:
```
_owner: 0xYourWalletAddress
_usdc:  0x3600000000000000000000000000000000000000
_eurc:  0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
```

### 2. Configure environment
Copy `.env.example` to `.env` and fill in your values. Never commit `.env`.

### 3. Install dependencies
```bash
npm install
```

### 4. Start servers
```bash
node relayer.js                # port 3001
node circle-wallets-server.js  # port 3002
```

### 5. Get test tokens
Visit [faucet.circle.com](https://faucet.circle.com) → select Arc Testnet → request USDC and EURC.

### 6. Run test bot
```bash
node bot.js
```

## Environment variables

See `.env.example` for the full list. Key variables:

```env
CONTRACT_ADDRESS=0x...
CIRCLE_API_KEY=TEST_API_KEY:id:secret
CIRCLE_ENTITY_SECRET=32bytehex
RPC_URL=https://rpc.testnet.arc.network
```

## Security

This is a **testnet experiment**. Do not use with real funds on mainnet without:
- Switching to a private RPC (secret revealed on-chain at collect time)
- Adding ZK proofs to hide the secret reveal
- Auditing the contract

## Links

- [Arc Testnet Explorer](https://testnet.arcscan.app)
- [Circle Faucet](https://faucet.circle.com)
- [Circle Console](https://console.circle.com)
- [Arc Docs](https://docs.arc.io)
