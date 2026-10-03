# PRODUCT_CONTEXT.md

## Product Vision

Build a Solana-native payment layer where onchain assets become usable in everyday payment experiences.

The long-term thesis:

> Stablecoins are only the beginning.
> Tokenized assets can also become payment primitives.

The product is NOT primarily:

```text
a crypto wallet
a DEX
a stock brokerage
an NFT marketplace
```

It is:

> a mobile payment experience built on top of programmable onchain assets.

---

## Current Hero Concept

### Token Red Packet — Stock Asset Demo

Red packets support two modes: **普通红包（等额）** and **拼手气红包**.
The sender chooses which supported token to put in the packet. USDC and AAPLx-DEMO
are initial choices; stock-like assets are tokens using the same red packet feature.
The stock example below is the Hackathon story, not an asset restriction.


```text
AAPLx
↓
Create red packet
↓
Friends claim fractions
↓
Stock becomes social/payment-native
```

### Buy Coffee with Stock

```text
Coffee costs 5 USDC
↓
User owns AAPLx
↓
Tap
↓
Use AAPLx as funding asset
↓
Merchant still receives USDC
```

This separates:

```text
Funding Asset
```

from:

```text
Settlement Asset
```

That is a core product concept.

---

## Basic Receive and Pay

Merchant QR also supports customer-entered amounts. Merchant selects the receiving
token (default USDC); customers scan, enter an amount and see **Gas fee: 0 SOL**
with merchant sponsorship stated explicitly. Merchant authorizes actual network
fees and new receiving-account rent. New merchant codes are reusable without expiry;
individual payments remain separately signed and tracked.


These are the foundational flows, ahead of red packets in implementation priority.

**Receive:** select the token to receive (USDC by default), enter the amount, choose
who pays network fees (receiver/merchant by default), and show a payment QR code.

**Pay:** scan the QR code or tap via NFC, review the request, select a supported
funding asset, review any conversion and fee responsibility, and confirm in the wallet.

The receiver can choose RECEIVER or PAYER as the network fee bearer. The default is
RECEIVER, including a merchant receiving a customer payment.

## Funding vs Settlement

The receiver chooses the settlement asset and exact amount. USDC is the default,
not the only selectable settlement token. The payer chooses a supported funding asset,
which may be a regular token or a supported stock-like token.

Example: customer funds with AAPLx-DEMO; merchant requests and receives 5 USDC.
Another supported receive request may ask for AAPLx-DEMO itself.

A different funding token requires an actual supported conversion/settlement route.
The payer cannot replace the receiver's chosen token merely by selecting an asset.
Do not present unsupported conversions as payable.

The initial Devnet asset set remains USDC and AAPLx-DEMO. Real xStocks support is a
future integration target. Merchant-paid network fees require merchant authorization;
this is a required payment capability, not an already implemented feature.

---

## Why Tokenized Equities Matter

Tokenized equities turn traditional financial assets into programmable blockchain assets.

Once onchain, they can participate in experiences such as:

```text
send
receive
gift
red packet
batch distribution
pay
payroll bonus
merchant settlement
```

The project explores these payment-native use cases.

---

## Product Pillars

### Consumer

```text
Send
Receive
Stock Red Packet
QR
NFC payment
Asset selection
NFT skins
```

### Merchant

```text
USDC-denominated checkout
NFC POS
QR checkout
Settlement confirmation
```

### Business — Roadmap

```text
Batch Pay
Payroll
Equity bonus distribution
Employee local directory
```

---

## Long-Term Architecture

```text
                    Solana Asset Payment Layer
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
       Consumer            Merchant            Business
          │                   │                   │
   Send / Receive          NFC POS             Payroll
   Stock Red Packet        QR POS              Batch Pay
   Asset Selection         USDC Settle         Equity Bonus
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                        Payment Intent
                              │
                 ┌────────────┼────────────┐
                 │            │            │
               USDC      Tokenized Stock   NFT Layer
                               │
                        xStocks / Assets
```

---

## Hackathon vs Production

### Hackathon

Use:

```text
AAPLx-DEMO
Token-2022
Scaled UI Amount
Devnet
Demo settlement liquidity
```

### Production Vision

Target:

```text
real xStocks
xChange or compatible liquidity
Mainnet
real market quotes
production compliance controls
```

Never conflate these two.

---

## Revenue Model

Potential future monetization:

### Consumer

```text
NFT skins
premium themes
season drops
brand collaborations
```

### Merchant

```text
POS Pro
merchant themes
advanced settlement tools
```

### Business

```text
Payroll Pro
Batch Pay Pro
enterprise capabilities
```

### Asset ecosystem

Potential future integrations may create:

```text
routing revenue
partner revenue
premium settlement features
```

subject to applicable legal/compliance requirements.

---

## Product Messaging

Preferred:

> Pay with the assets you already own.

Preferred:

> Merchants receive stablecoins. Users choose the funding asset.

Preferred:

> From stock red packets to tap-to-pay.

Preferred:

> We make tokenized equities usable, not just tradable.

Avoid:

> We are an xStocks exchange.

Avoid:

> We provide real stock trading.

Avoid claiming official xStocks integration before one exists.

---

## Current Hackathon Positioning

The Hackathon prototype demonstrates:

```text
Tokenized-equity-like asset
+
social distribution
+
NFC payment
+
stablecoin merchant settlement
```

The core insight:

> Tokenized assets should not stop at trading screens.
