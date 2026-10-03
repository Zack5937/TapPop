# ARCHITECTURE_CONTEXT.md

## Architecture Goal

Support:

```text
USDC
+
Token-2022 demo equity assets
+
stock red packets
+
asset-funded merchant payments
```

with the smallest possible architecture.

---

## High-Level Architecture

```text
                         Android App
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
      Wallet            Stock Red Packet       POS / NFC
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                       Payment Intent
                             │
                 ┌───────────┼───────────┐
                 │                       │
            Funding Asset           Settlement Asset
                 │                       │
           AAPLx-DEMO                   USDC
                 │                       ▲
                 └──── Demo Settlement ──┘
                             │
                           Solana
```

---

## Supported Token Programs

The architecture must support:

```text
SPL Token Program
Token-2022
```

### USDC

Use normal supported Devnet USDC token handling.

### AAPLx-DEMO

Create as:

```text
Token-2022
Scaled UI Amount enabled
```

Purpose:

```text
simulate the technical behavior relevant to xStocks
```

Do not represent it as real equity.

---

## Asset Model

Suggested model:

```text
Asset {
    mint
    symbol
    name
    decimals
    tokenProgram
    kind
    isDemo
}
```

Suggested kinds:

```text
STABLECOIN
TOKENIZED_EQUITY
OTHER
```

Do not scatter mint-specific logic throughout UI code.

---

## Display Amounts

Do not assume:

```text
display = raw / 10^decimals
```

Token-2022 assets may require extension-aware UI amount calculation.

Implement an amount formatting layer:

```text
AssetAmountFormatter
```

with support for Scaled UI Amount.

---

## Payment Intent

Suggested model:

```text
PaymentIntent {
    version
    intentId
    type
    merchant
    receiver
    settlementMint // selected by receiver; default USDC
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

Example:

```text
merchant: "Coffee Demo"
receiver: <merchant wallet>
settlementMint: USDC
settlementAmount: 5
acceptedFundingAssets:
  - USDC
  - AAPLx-DEMO
```

---

## Receive / Pay Transport and Fee Authorization

A reusable merchant code (`tappay://merchant`) carries receiver, mint/program,
codeId, expiry and explicit merchant-paid fee/rent policies, with no fixed amount.
Customer input creates a fresh amount-bound Payment Intent; merchantCodeId is bound
in its memo. The customer authorization QR carries the amount/reference/timestamps;
the merchant reconstructs the intent against its saved code and verifies the exact
signed transaction before co-signing. Successful checkout returns to the same code.
New merchant codes use version 2 with expiresAt: null and never expire; each payment
still lasts at most 10 minutes. Legacy version 1 codes retain their original expiry
and must be regenerated for permanent use.


The receiver creates an amount-bound Payment Intent and displays its QR code.
The payer scans or taps; QR, NFC and deep links call the same validator and handler.
The receiver chooses settlement token (USDC by default) and network fee bearer
(RECEIVER/merchant by default, optionally PAYER). The payer chooses funding token.

- Same asset: direct SPL Token / supported Token-2022 transfer.
- Different assets: require a supported quote and settlement route that preserves the receiver's requested token and amount.
- Unavailable route: block before signing; never reinterpret the receiver's request.
- Fee payer is a separate role from token-transfer authority. M3 separately validates the sponsor in transactions, receipt checks and saved payment records.
- RECEIVER mode: merchant wallet signs as transaction fee payer, customer wallet signs as token owner. Neither private key is held by the app.
- PAYER mode: customer wallet authorizes both payment and network fees.
- The intent must bind the network fee policy; reject mismatched fee-payer accounts, changed messages or missing required signatures.
- Two-party signing needs a transaction/signature exchange after intent discovery. A static QR or NFC payload alone cannot grant merchant fee authorization. The M3 implementation uses a customer partial-signature QR scanned by the merchant, followed by merchant wallet co-signing and onchain observation on both phones; see docs/MILESTONE_3.md. Device acceptance is pending. No mandatory centralized payment server is introduced.
- Persist and track the fully signed transaction identity before broadcast. Partial signatures are not settlement and must not enable a duplicate payment.
- Merchant review checks programs, accounts, exact transfer/quote, intent binding, expiry and fee cap. Fee insufficiency or rejection must not silently switch costs to the payer.
- Allocate and display account rent and conversion/service fees separately from network fees; their payer is not implied by networkFeePolicy.

Reference: [Solana transaction fees](https://solana.com/docs/core/fees/fee-structure).

---

## Funding Asset Flow

### Pay with USDC

```text
Customer USDC
↓
Merchant USDC
```

### Pay with AAPLx-DEMO

```text
Customer AAPLx-DEMO
↓
Demo Settlement
↓
Merchant USDC
```

The merchant-facing payment stays USDC-denominated.

---

## Quote Layer

Do not hardcode pricing logic inside UI.

Use:

```text
QuoteProvider
```

Example interface:

```text
quote(
  fundingAsset,
  settlementAsset,
  settlementAmount
)
```

Hackathon:

```text
DemoQuoteProvider
```

Example:

```text
AAPLx-DEMO price = 200 USDC
Coffee = 5 USDC
Funding amount = 0.025 AAPLx-DEMO
```

Production future:

```text
xChangeQuoteProvider
```

or another real liquidity provider.

---

## Settlement Layer

Suggested abstraction:

```text
SettlementService
```

Hackathon implementation:

```text
DemoSettlementService
```

Goal:

```text
Customer transfers AAPLx-DEMO
Merchant receives USDC
```

Where possible, make settlement atomic.

A simple demo program/vault is acceptable.

Do not build:

```text
order book
AMM
market maker
real DEX
```

---

## M4 Implemented Demo Settlement

M4 uses native token transfers in one transaction with three wallet signatures:
customer transfers AAPLx-DEMO to an independently selected liquidity wallet; that
wallet transfers USDC to the merchant; merchant signs as fee payer. All funds are
wallet-controlled and each spend is explicitly approved. DemoQuoteProvider fixes
the demo rate at 200 USDC per displayed AAPLx-DEMO; exact integer conversion rejects
rounding. Full transaction-message verification determines settlement, with durable
partial signatures and split QR transport. No custom program is required for this
manual demo route. See docs/MILESTONE_4.md.

Generic M3 merchant codes remain same-token only; M4 is a dedicated checkout.

## Possible Future Demo Settlement Program

Possible conceptual state:

```text
SettlementConfig {
    authority
    treasury
    supportedFundingMint
    settlementMint
    demoRate
}
```

Possible flow:

```text
settle(
  customer,
  merchant,
  fundingAmount,
  settlementAmount
)
```

Transfers:

```text
AAPLx-DEMO:
customer → demo vault

USDC:
demo vault → merchant
```

All parameters must be validated.

This is a Hackathon demo liquidity mechanism only.

---

## Token Red Packet Program

State:

```text
RedPacket {
    creator
    mint
    tokenProgram
    allocationMode // NORMAL_EQUAL or LUCKY
    totalAmount
    remainingAmount
    amountPerClaim // equal mode only
    maxClaims
    claimedCount
    expireAt
    status
}
```

Claim PDA:

```text
seeds = ["claim", redPacket, claimant]
```

Required instructions:

```text
create
claim
reserve_lucky
settle_lucky
refund
```

The creator chooses a supported token and the allocation mode. USDC and AAPLx-DEMO
use the same program; a stock token is not a special red packet implementation.

- NORMAL_EQUAL: validate raw total is exactly divisible by maxClaims; every claim gets the same raw amount.
- LUCKY: onchain allocation of a positive raw amount; reserve at least one raw unit per remaining claim; the final claim receives the remainder.
- Both modes: escrow balance conservation, mint/program validation, ClaimRecord PDA and atomic double-claim prevention.
- Reject zero recipients, zero amounts, or a total smaller than the minimum needed for all claims.
- The client cannot set the awarded amount or act as the randomness authority. M2's contract uses a fresh ORAO Classic VRF v2 request, a permanent reservation and permissionless fixed-recipient settlement. See docs/RED_PACKET_RANDOMNESS.md for the implementation-stage threat review. Local SBF tests pass. Android create/claim/refund/recovery code is implemented, with an explicit deployed-program gate; real ORAO CPI/fulfillment, deployment and device acceptance remain pending (docs/MILESTONE_2.md).
- Keep token quantities in integer raw units, applying Scaled UI Amount only for user input/display.

Do not hardcode USDC or AAPLx-DEMO. Initial selectable assets are the existing supported assets; generic program state does not imply support for every Token-2022 extension.

---

## NFC Architecture

User-authorized phone-to-phone extension: Kotlin HCE service (CATEGORY_OTHER,
BIND_NFC_SERVICE, foreground-only in-memory offer) + ISO-DEP Reader Mode bridge.
A one-minute session transfers up to 7,000 UTF-8 bytes in 220-byte APDU reads;
length/digest/snapshot checks reject mixed or incomplete transfers. Native lifecycle
cleanup stops sharing and reads on background/cancel/timeout. Both request discovery
and existing signed handoffs reuse original M3/M4 validation and confirmation.
Details and pending hardware checks: docs/MILESTONE_5_PHONE_TAP.md.

M5 implementation: Android NDEF URI dispatch → React Native Linking (cold/warm)
→ paymentLinkTarget → existing M3/M4 validation and review. Expo prebuild plugin
preserves three narrow tappay hosts (pay/merchant/settle) and optional NFC hardware.
Tag-link preparation exports unsigned requests only; external tools write tags.
Discovery never invokes signing. Static merchant tags have no expiry; fixed-amount
and M4 requests retain their original expiry. See docs/MILESTONE_5.md.

```text
Merchant POS
↓
Payment Intent
↓
NFC / QR / Deep Link
↓
Customer App
↓
Validate
↓
Choose Funding Asset
↓
Quote
↓
Wallet Confirm
↓
Settlement
↓
Merchant sees PAID
```

NFC is transport only.

During emulator development:

```text
Deep Link
```

may trigger the same `PaymentIntentHandler`.

---

## POS Confirmation

Merchant side verifies:

```text
receiver
settlement asset
settlement amount
reference / intent id
confirmed transaction
```

Then:

```text
WAITING
→ CONFIRMING
→ PAID
```

No centralized payment DB required.

---

## Repository Direction

```text
apps/
├── mobile/
│   ├── features/
│   │   ├── wallet/
│   │   ├── assets/
│   │   ├── send/
│   │   ├── receive/
│   │   ├── red-packet/
│   │   ├── payment-intent/
│   │   ├── asset-pay/
│   │   └── nft-skin/
│   ├── solana/
│   ├── nfc/
│   ├── storage/
│   └── config/
│
└── pos-demo/

programs/
├── red-packet/
└── demo-settlement/

docs/
```

Avoid microservices.

---

## Future Production Direction

Not part of Hackathon implementation:

```text
real xStocks asset registry
real xChange integration
market quote verification
production treasury design
compliance / geo controls
gas sponsorship
Mainnet
program audit
```

The Hackathon architecture should leave clean interfaces for these additions without implementing them now.
