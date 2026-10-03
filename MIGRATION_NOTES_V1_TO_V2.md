# MIGRATION_NOTES_V1_TO_V2.md

## Major Change

v1 Hackathon story:

```text
USDC Tap-to-Pay
+
USDC Red Packet
+
NFT Skin
```

v2 Hackathon story:

```text
Stock Red Packet
+
Tokenized-Equity-Funded Tap-to-Pay
+
USDC Merchant Settlement
```

---

## New Core Asset

```text
AAPLx-DEMO
```

Properties:

```text
Devnet only
Token-2022
Scaled UI Amount
Not backed by real equity
```

---

## New Core Architecture Principle

Separate:

```text
Funding Asset
```

from:

```text
Settlement Asset
```

Example:

```text
Funding:
AAPLx-DEMO

Settlement:
USDC
```

---

## Deferred from v1

The following are no longer core Hackathon priorities:

```text
NFT Skin
general Red Packet animation polish
full QR polish
```

They are optional if time remains.

---

## Production Roadmap

```text
AAPLx-DEMO
↓
real xStocks
↓
xChange / compatible liquidity
↓
Mainnet merchant settlement
```

Do not implement production integrations before the Hackathon submission.
