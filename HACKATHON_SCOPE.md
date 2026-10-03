# HACKATHON_SCOPE.md

## Deadline

```text
2026-10-08
```

Optimize for a convincing, working prototype.

---

# Hackathon Thesis

Demonstrate that tokenized equities can become payment primitives, not just trading assets.

Two required stories:

```text
Stock Red Packet
```

and:

```text
Tap-to-Pay for Coffee using a stock-like token
```

---

## Demo Asset

Use:

```text
AAPLx-DEMO
```

Requirements:

```text
Solana Devnet
Token-2022
Scaled UI Amount
clearly marked as demo
not backed by real stock
```

Do not claim official xStocks integration.

---

# Hero Demo 1 — Stock Red Packet

```text
Wallet A owns AAPLx-DEMO
↓
Creates 1 AAPLx-DEMO red packet
↓
5 equal claims
↓
Wallet B claims
↓
Wallet B receives 0.2 AAPLx-DEMO
↓
Second claim by Wallet B is rejected
```

Required:

```text
Create
Claim
ClaimRecord PDA
Double-claim prevention
Token-2022 support
Human-readable UI
```

Refund/expiry if time allows.

---

# Hero Demo 2 — Buy Coffee with Stock

Merchant creates:

```text
Coffee Demo
5 USDC
```

Customer:

```text
Tap / Deep Link
↓
Payment screen opens
↓
Choose AAPLx-DEMO
↓
Demo quote:
0.025 AAPLx-DEMO = 5 USDC
↓
Wallet confirm
↓
AAPLx-DEMO leaves customer
↓
Merchant receives 5 Devnet USDC
↓
POS shows PAID
```

This should be the primary video demo.

---

## In Scope

### Environment

```text
Android
React Native / Expo
Solana Devnet
Mobile Wallet Adapter
Fake Wallet on emulator
```

### Wallet / Assets

```text
Wallet connect
SOL balance
USDC balance
AAPLx-DEMO balance
SPL Token support
Token-2022 support
Scaled UI Amount handling
```

### Payment

```text
Receive: input amount, select settlement token (default USDC), display QR
Pay: scan QR or tap NFC through the same Payment Intent
NFC transport if physical device available
Payer selects supported funding asset
Receiver selects network fee payer: RECEIVER default / PAYER optional
Merchant wallet fee authorization + customer wallet payment authorization
Supported cross-asset quote and settlement
Onchain settlement confirmation
```

### Token Red Packet

```text
Creator selects supported token: USDC or AAPLx-DEMO
Ordinary/equal mode (NORMAL_EQUAL)
Lucky mode (LUCKY)
SPL Token + supported Token-2022 profile
Create
Claim
Double-claim prevention
Onchain allocation and conservation
```

User clarification (2026-10-03) supersedes the earlier equal-only scope. A stock
red packet is a demo using one token category, not a separate product or program.

### Delivery

```text
Android APK
GitHub repository
README
Demo video
Pitch deck
Architecture diagram
```

---

## Explicitly Out of Scope

Do NOT implement before submission:

```text
official xStocks integration
real xChange integration
Mainnet
real securities trading
Jupiter multi-asset swap
live market pricing
full DEX
order book
AMM
Payroll
Batch Pay
Split Bill
iOS
Fiat
Bridge
NFT Marketplace
merchant SaaS
cloud account system
generic production sponsorship service (merchant-paid Devnet payment flow is explicitly in scope)
loyalty system
```

---

## Milestone 0 — Base Mobile Chain

Required first:

```text
Android emulator works
Fake Wallet connects
SOL balance loads
Devnet USDC balance loads
basic token transfer works
```

Acceptance:

```text
Wallet A → Devnet USDC → Wallet B
```

---

## Milestone 1 — Demo Equity Asset

Create:

```text
AAPLx-DEMO
```

using:

```text
Token-2022
Scaled UI Amount
```

Required:

```text
mint devnet demo supply
display balance correctly
transfer AAPLx-DEMO
```

Acceptance:

```text
Wallet A → 1 AAPLx-DEMO → Wallet B
```

and UI displays the correct amount.

---

## Milestone 2 — Token Red Packet

Build one generic token red packet program with creator-selected asset and mode.
Both 普通红包（等额）and 拼手气红包 are required.

Acceptance:

```text
Creator selects USDC or AAPLx-DEMO
Creator selects NORMAL_EQUAL or LUCKY
Equal example: 1 AAPLx-DEMO / 5 claims → 0.2 per claim
Lucky example: positive allocations within the remaining balance
Final lucky claim receives the remaining amount
Every remaining claim retains at least one raw unit
Total allocated raw units equals the funded raw units after all claims
Wallet B cannot claim twice in either mode
```

Equal totals must be exactly divisible in raw units. Lucky claims need not be equal;
random results may occasionally coincide. Do not require unequal outputs as a test of randomness.

Before lucky-mode implementation, specify and review the randomness source and
creator/claimant/ordering manipulation risks. Do not use client-selected awards or
present predictable public inputs as secure randomness. This design is still pending.

This scope change does not add new currencies, arbitrary mint support, mainnet,
stock trading, or a centralized payment server.

---

## Milestone 3 — Basic Receive / Pay + Payment Intent

User priority update (2026-10-03): after the current asset milestone, implement this
basic payment flow before Milestone 2 red packets. Keep milestone IDs for reference;
this is an explicit execution-order change, not parallel milestone implementation.

Required:

```text
Receive: choose settlement token (default USDC), enter amount, display QR
Merchant QR: reusable code, customer enters amount, customer sees 0 SOL gas (merchant-paid)
Receive: choose network fee policy (default RECEIVER / merchant, optional PAYER)
Pay: scan QR and validate Payment Intent
Display receiver, amount, settlement token and fee responsibility
Choose a supported funding asset
Same-token payment with correct wallet signature(s) and fee payer
Merchant observes actual settlement and shows PAID
```

Payment Intent must include receiver, settlement mint/program/amount, accepted
funding assets, network fee policy, intentId, reference, nonce and expiry.

QR is required, not replaced by manual deep links. Deep links are useful during
emulator development. NFC uses the same intent flow and remains subject to physical
hardware availability in Milestone 5.

Acceptance: default merchant-paid same-token request settles to the correct recipient;
optional payer-paid request charges the designated payer; rejected or unavailable
merchant signature does not silently charge the customer. Receiver-selected token
and fixed-request amount cannot be overridden by the payer. Merchant open-amount codes
permit customer amount entry, with a fresh intent/reference for every payment. Cross-token options require Milestone 4
routes and remain unavailable until those routes work.

M3 implements the two-wallet exchange through a customer authorization QR and
merchant wallet co-signing, with no mandatory proprietary payment server. See
docs/MILESTONE_3.md; actual device acceptance is pending. Static QR discovery alone
does not authorize merchant fees. Account rent and conversion/service fees must be visible
and separately assigned rather than silently included in the gas policy.

---

## Milestone 4 — Demo Asset Settlement

Receiver may select supported settlement tokens; the route matrix is explicit.
Only enable funding/settlement pairs with implemented liquidity and quote validation.
The first cross-asset route remains the coffee demo below.

Implement:

```text
AAPLx-DEMO → demo settlement
USDC → merchant
```

Use:

```text
DemoQuoteProvider
```

Acceptance:

```text
5 USDC coffee
price = 200 USDC / AAPLx-DEMO
customer pays 0.025 AAPLx-DEMO
merchant receives 5 Devnet USDC
```

POS confirms onchain receipt.

---

## Milestone 5 — NFC

If real Android NFC device is available:

```text
NFC → Payment Intent → same payment handler
```

If no physical device is available before code freeze:

- keep Deep Link demo working
- do not destabilize settlement logic
- NFC integration may remain a thin transport layer

---

# Scope Cut Order

If behind schedule, cut:

```text
1. NFT skin
2. refund UI
3. QR polish
4. animations
5. extra assets
6. extra wallet compatibility
```

Never cut:

```text
Android APK
Wallet connect
AAPLx-DEMO Token-2022
Stock Red Packet
5 USDC coffee intent
AAPLx-DEMO funding
merchant USDC settlement
POS PAID
Demo video
```

---

# Definition of Done

```text
✓ Android APK installs
✓ Devnet wallet connects
✓ SOL balance loads
✓ USDC balance loads
✓ AAPLx-DEMO balance loads
✓ AAPLx-DEMO is Token-2022
✓ Scaled UI Amount handled
✓ Stock token transfer works
✓ Token Red Packet asset selection works
✓ Equal mode create/claim works
✓ Lucky mode create/claim and conservation work
✓ Double claim rejected
✓ Receiver inputs amount and selects settlement token (default USDC)
✓ Receive QR displays and Pay scans it
✓ Receiver-selected network fee policy works (default merchant-paid)
✓ Merchant creates 5 USDC intent
✓ Customer payment screen opens
✓ Customer selects AAPLx-DEMO
✓ Demo quote works
✓ Wallet signs
✓ Merchant receives 5 Devnet USDC
✓ POS displays PAID
✓ Demo assets labeled honestly
✓ README reproduces setup
✓ No secrets committed
```

Anything beyond this is bonus.
