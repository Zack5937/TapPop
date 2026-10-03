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

# Current Task — Milestone 2: Token Red Packet

The user's continuation after M5 starts M2 only. The contract stage is implemented:
equal/lucky packets, SPL Token and the M1 Token-2022 profile, escrow, permanent
claim PDAs, fresh ORAO VRF reservations, permissionless settlement and expiry/refund.
Read `docs/MILESTONE_2.md` and `docs/RED_PACKET_RANDOMNESS.md` before continuing.

Local host tests and compiled SBFv0 VM tests pass. SBPFv3 also compiles, but its
execution is not verified by the pinned Agave 2.3 VM. Real ORAO request/fulfillment
and deployment remain unverified. The default program ID is deliberately an
undeployed test identity; never silently enable it in the app.

Android integration is now implemented: asset/mode selection, create/claim/refund
review, QR sharing, separate oracle/network/rent costs, durable signed-transaction
recovery and chain-state refresh. Typecheck, 95 JS tests, Rust/mobile ABI comparison
and Android APK build pass. The APK disables red packet operations when no real
Devnet program ID is configured; the local-test default is explicitly rejected.

Next work remains **within M2**: deployment identity/target compatibility, actual
ORAO request/fulfillment and two-wallet Devnet verification. No live program or
device acceptance is claimed. Do not start a new major milestone.

## Previous M5 status

User explicitly requested phone-to-phone NFC on 2026-10-03. The extension now has
an Android HCE sender and Reader Mode / ISO-DEP receiver, in addition to static tags.

```text
Sender opens Send to nearby phone (foreground, unlocked, one-minute session)
Receiver opens Read nearby phone → SELECT + bounded chunks + digest verification
Same M3/M4 validators → request review or existing signature handoff
Explicit wallet authorization → existing settlement verification
```

See `docs/MILESTONE_5_PHONE_TAP.md` for implementation, tests, APK and two-device
acceptance. The sender must support HCE; both phones must open the updated app.
No new signature or payment is triggered by a tap. Static tags/QR/text remain
available. No tag writer, payment server or background payment is implemented.

M3 permanent merchant codes and M4's dedicated three-wallet atomic stock-to-USDC
checkout remain implemented. Generic merchant codes still use same-token payments.

M0 balances are user-verified. M0 transfers, M1 issuance/transfers, M3/M4 payments
and M5 real NFC hardware still await device acceptance. Tests are not onchain or
radio acceptance. No wallets were operated for this implementation.

Both equal and lucky modes remain required in M2. Do not start NFT or other
milestones in parallel. Keep M3/M4/M5 recovery and explicit wallet authorization intact.

---

# Working Style

After completing the current milestone, report:

### Completed

### Files Changed

### How to Test

### Known Issues

### Next Milestone

Stop after the report and wait for the next instruction.
