# CODEX_START.md

You are implementing a Solana Mobile Hackathon project.

Before changing code, read:

1. `AGENTS.md`
2. `PRODUCT_CONTEXT.md`
3. `ARCHITECTURE_CONTEXT.md`
4. `HACKATHON_SCOPE.md`

---

# Product Goal

The product explores:

> Tokenized equities as payment primitives.

Current Hackathon demos:

## Demo A

```text
AAPLx-DEMO
↓
Stock Red Packet
↓
Friend claims fractional stock-like token
```

## Demo B

```text
Coffee costs 5 USDC
↓
Customer taps / opens Payment Intent
↓
Customer chooses AAPLx-DEMO
↓
Demo settlement
↓
Merchant receives 5 Devnet USDC
↓
PAID
```

---

# Important Truthfulness Constraint

`AAPLx-DEMO` is:

```text
a Devnet Token-2022 demo asset
```

It is NOT:

```text
real Apple stock
real xStocks
official xStocks integration
```

UI and documentation must state this clearly.

Production roadmap may target:

```text
xStocks + xChange or compatible liquidity
```

but do not fake or simulate an official API integration.

---

# Current Network

```text
Solana Devnet
```

Devnet USDC:

```text
4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

Create the demo stock token as:

```text
Token-2022
Scaled UI Amount enabled
symbol: AAPLx-DEMO
```

---

# Architecture Constraints

```text
Android first
Non-custodial
No centralized payment server
Local-first
Support SPL Token + Token-2022
Do not hardcode USDC throughout the architecture
Do not assume amount = raw / 10^decimals for every asset
```

Use generic asset abstractions.

---

# Current Task — Milestone 3: Basic Receive / Pay

The user explicitly prioritized basic receive/pay over red packets and requested implementation on 2026-10-03.

Implemented in code:

```text
Receive amount + selectable settlement token (default USDC) + QR
Reusable merchant QR + customer-entered amount + customer Gas fee: 0 SOL
Native QR scanning / payment deep links + review
Same-token funding selection; unsupported conversion routes disabled
Receiver-selected network fee policy (merchant default, payer optional)
Customer partial-signature QR → merchant wallet co-sign → broadcast
Onchain settlement verification and local pending recovery
```

See `docs/MILESTONE_3.md` for the exact two-wallet protocol, tests and device acceptance.
No proprietary payment server or hidden merchant key is used.

M0 balance loading is user-verified; M0 transfers, M1 asset issuance/transfers and M3 two-device payments still await actual device acceptance. Do not claim these were verified onchain.

Do not expand this milestone into cross-token conversion, NFC, red packets or NFT.
The next highest-priority milestone is M4 demo AAPLx-DEMO → USDC settlement, on further user instruction.
M2 red packets still require creator-selected asset plus NORMAL_EQUAL and LUCKY modes; randomness design remains pending. M5 covers NFC hardware transport.

---

# Working Style

After completing the current milestone, report:

### Completed

### Files Changed

### How to Test

### Known Issues

### Next Milestone

Stop after the report and wait for the next instruction.
