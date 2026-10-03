# AGENTS.md

## Project Mission

Build a mobile-first Solana payment application that makes onchain assets usable like everyday money.

Current Hackathon concept:

> Stock Red Packet + Tap-to-Pay with tokenized equities.

Core product experience:

```text
Send assets
Receive assets
Share stock red packets
Tap phone
Confirm
Merchant receives USDC
```

Long-term product direction includes:

- USDC payments
- xStocks / tokenized equities
- Send / Receive
- Red Packet
- QR Payment
- NFC POS Payment
- Split Bill / AA
- Batch Pay
- Payroll
- NFT Skins
- Merchant payments
- Asset-backed payment settlement

Always read before implementing:

- `PRODUCT_CONTEXT.md`
- `ARCHITECTURE_CONTEXT.md`
- `HACKATHON_SCOPE.md`
- `CODEX_START.md`

---

## Current Hackathon Story

The current Hackathon story is NOT:

> "We built NFC payments on Solana."

The current story is:

> "We make tokenized equities usable as payment assets."

Primary demos:

### Demo A — Stock Red Packet

```text
Creator owns AAPLx-DEMO
↓
Creates stock red packet
↓
Another wallet claims
↓
Recipient receives AAPLx-DEMO
```

### Demo B — Buy Coffee with Stock

```text
Merchant requests 5 USDC
↓
Customer taps Android device via NFC
↓
Customer chooses AAPLx-DEMO as funding asset
↓
Wallet confirms
↓
Demo settlement swaps/settles AAPLx-DEMO
↓
Merchant receives 5 Devnet USDC
↓
PAID
```

Production vision:

```text
AAPLx / TSLAx / NVDAx
↓
xStocks / xChange / liquidity
↓
USDC
↓
Merchant
```

Hackathon implementation MUST clearly label the stock asset and settlement liquidity as demo/devnet infrastructure.

---

## Critical Truthfulness Rule

Never represent demo assets as real xStocks.

Use names such as:

```text
AAPLx-DEMO
TSLAx-DEMO
```

UI must clearly indicate:

```text
Devnet demo asset
Not backed by real equity
```

Do not claim that the Hackathon implementation is an official xStocks integration.

Production target may be described as:

> Future integration target: xStocks + xChange or compatible liquidity infrastructure.

---

## Current Network

```text
Solana Devnet
```

USDC Devnet Mint:

```text
4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

Stock demo assets should use:

```text
Token-2022
Scaled UI Amount
```

Do not switch to Mainnet without explicit instruction.

---

## Non-Custodial

Never store or manage user private keys.

Allowed:

```text
construct transaction
request wallet signature
read balances
read token accounts
read program state
```

Forbidden:

```text
store seed phrase
store private key
sign user payments silently
custody user assets
```

Every user fund movement requires wallet authorization.

---

## Local-First

Sensitive local metadata should remain on device where practical.

Examples:

```text
contacts
merchant labels
payment notes
local activity labels
preferences
employee metadata in future
```

Do not create cloud databases merely for convenience.

---

## No Centralized Payment Server

Core payment settlement must not require a proprietary centralized payment server.

Allowed infrastructure:

```text
Solana RPC
wallet infrastructure
static hosting
optional asset hosting
GitHub
```

Core settlement source of truth:

```text
Solana
```

Do not create:

```text
central payment ledger
custodial wallet server
mandatory payment database
mandatory merchant order database
```

for the Hackathon MVP.

---

## Asset Architecture

Do not build business logic around `USDCTransferService`.

Use generic asset abstractions.

Prefer concepts such as:

```text
Asset
AssetAmount
AssetTransferService
AssetMetadata
TokenProgram
```

An asset should minimally describe:

```text
mint
symbol
decimals
tokenProgram
display rules
```

Hackathon supported assets:

```text
USDC
AAPLx-DEMO
```

Future:

```text
real xStocks assets
other Token-2022 assets
```

---

## Token Support

Support both:

```text
SPL Token
Token-2022
```

Do not assume:

```text
uiAmount = rawAmount / 10^decimals
```

For Token-2022 assets using Scaled UI Amount, use the correct multiplier/display logic.

This is critical for future xStocks compatibility.

---

## Basic Receive / Pay Requirements — 2026-10-03

Receive and Pay are foundational product flows and take priority over red packets.

Receive:

```text
Choose settlement token (default USDC)
Enter the amount to receive
Choose who pays network fees (default RECEIVER / merchant; optional PAYER)
Display a payment QR code
Observe onchain settlement
```

Pay:

```text
Scan the QR code or tap via NFC
Validate the same Payment Intent
Show recipient, requested amount/token and fee responsibility
Choose a supported funding token (including supported stock-like tokens)
Review the funding amount and any conversion quote
Wallet authorization → submit → verify settlement
```

The receiver chooses what token and amount arrive. The payer's funding token does
not change the receiver's requested settlement. Same-token payments use a direct
transfer. Different-token payments require an available settlement route and an
explicit quote; asset selection alone is not conversion. Unsupported routes must
be unavailable or rejected before signing.

Initial implementation remains Devnet USDC and AAPLx-DEMO. Real xStocks are a
production asset category, not an implemented official integration.

Network fee policy is part of the Payment Intent: RECEIVER by default, PAYER if
chosen by the receiver. Resolve and validate the actual fee-payer address from that
policy. When the merchant pays, the merchant wallet must authorize its fee-payer
signature and the customer wallet must separately authorize spending its tokens.
Neither QR nor NFC grants either authorization. Do not use hidden merchant keys,
silently charge the customer, or claim a static receive QR authorizes fee sponsorship.

The merchant-paid flow requires transport for exchanging the final transaction and
its signatures, in addition to discovering the intent. Define that exchange without
a mandatory proprietary payment server; mark it pending until implemented.
Both wallets must sign exactly the same reviewed transaction. Any change requires
fresh signatures. Verify the actual fee payer independently from token-transfer authority.

Network fees are distinct from token-account rent, conversion costs and service
fees. Display and explicitly allocate any additional costs before signing; the user's
default merchant-gas requirement must not be silently extended to or used to hide them.
Merchant sponsorship must validate intent binding, expiry, recipients, programs,
amounts and an explicit fee cap before authorizing a transaction. Never sponsor an
arbitrary transaction received over QR/NFC.

---

## Payment Intent

Payment Intent is a core abstraction.

Suggested shape:

```text
PaymentIntent {
  version
  intentId
  type
  merchant
  receiver
  settlementMint // receiver-selected; default USDC
  settlementTokenProgram
  settlementAmount
  networkFeePolicy // RECEIVER (default) or PAYER
  acceptedFundingAssets
  reference
  memo
  nonce
  expiresAt
}
```

For Hackathon coffee demo:

```text
settlementMint = Devnet USDC
settlementAmount = 5 USDC

acceptedFundingAssets:
- USDC
- AAPLx-DEMO
```

The Payment Intent states what the merchant receives.

The user's funding asset may differ.

---

## NFC Rules

NFC is transport/discovery only.

Never use NFC as payment authorization.

Correct flow:

```text
NFC
↓
Payment Intent
↓
Validate
↓
Show merchant + amount
↓
Choose funding asset
↓
Wallet confirmation
↓
Transaction
```

All NFC paths should ultimately call the same Payment Intent handler used by:

```text
QR
Deep Link
```

During emulator development, Deep Link may substitute for NFC transport.

---

## Token Red Packet

Product clarification from the user (2026-10-03): red packets are a generic token feature.
Stock-like tokens are one asset category, not a separate red packet type.

The creator selects:

```text
Supported token
Mode: NORMAL_EQUAL (普通红包 / 等额) or LUCKY (拼手气红包)
Total amount
Number of recipients
```

Both modes are required in Milestone 2. The earlier equal-only restriction is superseded.
Initial selectable assets remain USDC and AAPLx-DEMO; do not add unrelated tokens or arbitrary-mint support merely because the red packet model is generic.

Required:

```text
Create
Claim
ClaimRecord PDA
Double-claim prevention
Onchain enforcement of allocation and conservation
Expire/refund if time allows
```

Store mint, token_program and allocation_mode in program state. Never hardcode USDC,
AAPLx-DEMO, or a stock-specific eligibility rule into red packet logic.

Equal mode distributes the same raw token amount per claim; reject totals that cannot
be divided exactly into the requested number of claims.
Lucky mode distributes varying positive raw token amounts, reserves at least one raw
unit for every remaining claim, and gives the final claimant the remaining amount.
No claim may exceed the remaining escrow balance.

The client must not choose claim amounts or supply authoritative randomness. Before
implementing lucky allocation, document its randomness source and resistance to creator,
claimant and transaction-order manipulation. Predictable timestamps, public hashes or
client-generated random numbers must not be presented as secure random allocation.

Amounts in escrow, allocation and transfers use integer raw units. Asset display rules
(including Scaled UI Amount) belong to the client display/conversion layer.

---

## Coffee Settlement Demo

The Hackathon may use a demo settlement mechanism.

Target behavior:

```text
Customer pays AAPLx-DEMO
↓
Demo settlement vault/program receives it
↓
Merchant receives Devnet USDC
```

This should be atomic where practical.

If the exchange rate is demo/static:

- mark it clearly as demo pricing
- isolate pricing behind a provider interface
- never imply it is a live xStocks market quote

Suggested abstraction:

```text
QuoteProvider
```

Hackathon implementation:

```text
DemoQuoteProvider
```

Future:

```text
xChangeQuoteProvider
```

Do not implement a fake production integration.

---

## Prefer Native Solana Primitives

Use direct token transfers when sufficient.

Examples:

```text
USDC send            → token transfer
AAPLx-DEMO transfer  → Token-2022 transfer
Stock red packet     → custom program
Coffee settlement    → custom/demo settlement flow
```

Avoid unnecessary program surface.

---

## Do Not Over-Engineer

Do not build:

```text
microservices
cloud payment backend
plugin platform
generic workflow engine
multi-chain abstraction
full DEX
order book
market maker
full merchant SaaS
```

before submission.

---

## Required Engineering Workflow

For each milestone:

1. Inspect repository.
2. Read project docs.
3. Build/test existing code.
4. Implement one milestone.
5. Compile immediately.
6. Test immediately.
7. Fix root causes.
8. Report changed files.
9. Report exact test steps.
10. Stop before starting the next milestone unless instructed.

---

## Required Completion Format

### Completed

### Files Changed

### How to Test

### Known Issues

### Next Milestone

Only one next milestone.

---

## Security

Never commit:

```text
private keys
seed phrases
mainnet secrets
real signing keys
production API secrets
```

Validate:

```text
receiver
mint
token program
amount
nonce
expiry
program ID
transaction confirmation
```

Treat as untrusted:

```text
NFC payload
QR payload
deep link
local storage
displayed quote
```

---

## Hackathon Definition of Done

The Hackathon MVP is done when:

```text
Android APK installs
Wallet connects on Devnet
SOL balance loads
USDC balance loads
AAPLx-DEMO balance loads
AAPLx-DEMO uses Token-2022
Scaled UI Amount is handled correctly
Stock red packet can be created
Second wallet can claim stock token
Double claim is blocked
Merchant can create 5 USDC Payment Intent
NFC or Deep Link opens payment flow
Customer can choose AAPLx-DEMO
Customer confirms wallet transaction
Merchant receives 5 Devnet USDC
POS displays PAID
README reproduces setup
No secrets committed
Demo clearly identifies mock stock asset
```

Anything beyond this is bonus until submission.

## Merchant Open-Amount QR (user update, 2026-10-03)

Support a reusable merchant receive QR in M3: merchant selects the receiving token
(default USDC), customer scans and enters a positive amount. Show customer gas as
0 SOL with explicit merchant sponsorship. The merchant wallet must still authorize
each transaction and its network fees; QR discovery never grants that authority.
New merchant codes have no expiry; each payment has its own nonce, reference and expiry.
Retain fixed-amount receive requests and their selectable fee policy.

## Phone-to-Phone NFC — User Update 2026-10-03

Phone-to-phone transfer is explicitly required within M5. Use foreground HCE
sending and NFC Reader Mode receiving, with bounded/cancellable sessions and
complete-payload validation. Requests and existing signature handoffs may be
transported; receiving data must never create a new signature or authorize a
payment. Keep QR/static tags as fallbacks and report hardware acceptance honestly.
