# iOS QR payments — local development

Status: iOS configuration, Phantom sign-only adapter, generated native project,
Hermes bundle and automated tests are implemented. Native compilation, simulator
launch and iPhone/Phantom/onchain acceptance are **not verified**. This development
Mac currently has Command Line Tools but no full Xcode installation.

## Scope

- iOS uses Phantom mobile deep links; Android keeps Mobile Wallet Adapter.
- Existing asset amounts, payment-intent validation, QR scanning, customer signing,
  merchant co-signing, durable submission and settlement verification are shared.
- Solana Devnet only. USDC and the existing AAPLx-DEMO Token-2022 profile only.
- AAPLx-DEMO is a devnet demo asset, not backed by real equity or an official xStocks integration.
- NFC tag and phone-to-phone controls are hidden on iOS. Use QR to exchange the
  payment request and partial signatures. No iOS HCE/NFC support is claimed.
- A simulator can exercise app UI and link routing; actual wallet and camera
  payment acceptance requires physical devices.

## Build and install with a free Apple Account

1. Install full Xcode from the Mac App Store, launch it, accept its license and
   install iOS platform support and a simulator runtime. In Xcode Settings →
   Locations, select the installed Xcode for Command Line Tools. Verify
   `xcodebuild -version` succeeds.
2. Add your own Apple Account in Xcode Settings → Apple Accounts. A paid Developer
   Program membership is not required for personal on-device development. Do not
   share the account password or signing credentials with the app or this repo.
3. From the repository root:

   ```sh
   npm ci
   npm run typecheck
   npm test
   npm run prebuild:ios
   npx pod-install apps/mobile/ios
   open apps/mobile/ios/TapPayDevnet.xcworkspace
   ```

4. In the `TapPayDevnet` app target's Signing & Capabilities, enable automatic
   signing and choose your **Personal Team**. If Apple reports the bundle ID is
   unavailable, set a unique `expo.ios.bundleIdentifier` in
   `apps/mobile/app.json`, regenerate the iOS project and select the team again.
   Do not modify the Android package ID.
5. Connect and trust your iPhone on the Mac. Enable Developer Mode on the iPhone
   when prompted, select it as the Xcode run destination and press Run. Trust the
   developer profile in iPhone Settings if prompted. For a Debug build, start
   Metro with `npm start` and allow local-network access.
6. After signing is configured, CLI alternatives are:

   ```sh
   npm run ios          # simulator
   npm run ios:device   # connected iPhone, development build
   ```

   For a phone build with bundled JavaScript that does not need Metro:

   ```sh
   cd apps/mobile
   npx expo run:ios --device --configuration Release
   ```

Free Personal Team provisioning expires after **7 days**; rebuild/reinstall when
it expires. This is personal device testing, not TestFlight/App Store distribution.
Do not distribute an unsigned `.ipa` as an installable app. Native projects are
generated and ignored by Git; Xcode signing choices may need reapplying after
regeneration. No development-team ID or signing secret is committed.

## iPhone acceptance steps

1. Install Phantom on the iPhone and enable its Solana Devnet testnet mode. Connect
   from Tap Pay, approve in Phantom and verify the displayed wallet address.
   Fund with Devnet SOL and the configured Devnet USDC, not mainnet assets.
2. Connect the second device with a different wallet. On the receiving device,
   create a fixed USDC request with RECEIVER fees, or a reusable merchant QR.
3. Scan with the customer iPhone, review token, amount and merchant sponsorship,
   then confirm the signature in Phantom. The app must show a customer
   authorization QR rather than PAID.
4. Merchant scans that authorization QR, reviews fees/rent and approves its own
   wallet signature. Confirm actual onchain settlement before either device shows
   PAID. Verify the merchant was the transaction fee payer.
5. Repeat with a PAYER-fee fixed request, then a supported AAPLx-DEMO same-token
   request using the same verified demo mint on both devices.
6. Reject Phantom signing, manually return without signing, switch wallet account,
   wait for the two-minute request timeout, and restart the app during wallet
   handoff. None may submit an unreviewed transaction or show success. Reconnect
   after restart; recover any previously persisted submitted payment before retry.
7. For the separate M4 stock-funded checkout, additionally verify all three
   wallets preserve the exact transaction and prior signatures. Phantom support
   for these real-device partial-signing flows remains an acceptance requirement.

## Signing boundary and recovery

`walletTransport.ios.ts` is selected by Metro only on iOS. `walletTransport.ts`
adapts Android MWA to the same narrow `WalletClient`. The Phantom adapter requests
`connect` with `cluster=devnet`, verifies the signed session's wallet, app URL,
chain and cluster, then calls **signTransaction**, never sign-and-send.

Every response must match the exact `tappay://wallet/phantom` route and a random
256-bit per-request state. Encrypted data is authenticated with NaCl box. Signing
responses must preserve the reviewed message and prior signatures and contain a
valid signature from the connected wallet. Existing payment validators still run.
Rejected, stale, malformed and unsolicited callbacks do not broadcast anything.

X25519 transport encryption secrets and Phantom session tokens stay in memory;
they are not Solana signing keys. They are discarded on disconnect/restart. The
app never obtains user private keys or seed phrases. Cold-start wallet callbacks
are deliberately not resumed: they cannot auto-submit a payment, and the user
must reconnect and review. Previously submitted payments retain existing durable
onchain recovery. No backend, cloud database or mainnet integration was added.

## Validation

```sh
npm run typecheck
npm test
npm run prebuild:ios
npm run bundle:ios
npm run bundle:android
```

The bundle commands validate JavaScript/Hermes exports, not an Xcode native build.
New tests simulate encrypted Phantom responses and verify Devnet/session binding,
rejection, callback correlation/replay, duplicate fields, corrupt encryption,
timeout/concurrency, cold restart and customer/merchant signature preservation.

References:
- [Apple free account limits](https://developer.apple.com/support/compare-memberships/)
- [Phantom connect](https://docs.phantom.com/phantom-deeplinks/provider-methods/connect)
- [Phantom signTransaction](https://docs.phantom.com/phantom-deeplinks/provider-methods/signtransaction)
- [Phantom session validation](https://docs.phantom.com/phantom-deeplinks/handling-sessions)
- [Phantom encryption](https://docs.phantom.com/phantom-deeplinks/encryption)
