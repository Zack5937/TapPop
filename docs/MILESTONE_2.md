# M2 — Token Red Packet: contract and Android integration

2026-10-03. Contract and Android client code are implemented. **The Devnet red
packet demo is not yet accepted**: deployment, actual ORAO fulfillment and device
payments remain pending. No deployment or wallet transaction was performed.

## Implemented

One Anchor program accepts a creator-selected mint and token program. Ordinary
equal packets and lucky packets share the same escrow and claim record model.
Standard SPL Token is supported. Token-2022 is restricted to the existing immutable
Scaled UI Amount ×2 profile, six decimals, no mint/freeze/scaling authority and no
other mint extensions. No transfer hooks, transfer fees or mutable multiplier are
silently accepted. The future Android selector must use the existing USDC and
AAPLx-DEMO registry and display demo-asset disclosures.

- `create(nonce, mode, total, count, expires_at)`: wallet-authorized checked transfer
  into the packet's associated token account. `mode = 0` is equal, `1` is lucky.
  Amounts are integer raw units; equal totals must divide exactly. Count is 1–1000,
  each share has at least one raw unit, lifetime is at most seven days.
- `claim()`: equal allocation, or the last lucky share's exact remainder. A permanent
  ClaimRecord PDA prevents a wallet from claiming again.
- `reserve_lucky(nonce, max_oracle_fee)`: creates a permanent claim reservation and
  requests a **fresh** ORAO Classic VRF v2 result by CPI. At most one reservation per
  packet is pending. A reviewed SOL oracle-fee cap is enforced before CPI.
- `settle_lucky()`: anyone can pay to complete a fulfilled reservation, even after
  expiry. The reserved claimant and their token ATA cannot be changed. Amount is
  allocated from verified oracle output; the caller supplies no award.
- `refund()`: creator only, after expiry. A fulfilled pending claim must settle
  first. An unfulfilled one has an additional one-hour grace period, after which
  refund permanently closes the packet and cancels the reservation.

See [randomness design and threat review](RED_PACKET_RANDOMNESS.md). This is an
engineering review, not an external audit. Lucky mode depends on ORAO availability,
configuration and upgrade trust. It prevents per-wallet rerolls, not Sybil wallets
or transaction ordering. Lucky allocations may coincide.

## Accounts and financial rules

Program ID is supplied through `RED_PACKET_PROGRAM_ID` at build time. The default
`EH8Um52SbBNGdchqXURwAXrjxYTygRGsw37un2UmmeMx` is an **undeployed local-test ID**;
do not configure it as a live Android deployment. The compiler's generated local
keypair is ignored build output and is unrelated to this default ID. Deployment
requires deliberately matching the program identity and rebuilding.

- Packet PDA: `["packet", creator, nonce32]`, owned by this program.
- Vault: canonical ATA for packet PDA, mint and token program.
- ClaimRecord PDA: `["claim", packet, claimant]`, permanently retained.
- ORAO request: canonical ORAO PDA with a domain-separated seed bound to packet,
  claimant and nonce. Validate owner, discriminator, PDA, seed, client and fulfillment.
- Packet statuses: 0 active, 1 exhausted, 2 refunded. Claim statuses: 0 reserved,
  1 paid, 2 cancelled by whole-packet refund.
- Creation and withdrawal use token `transfer_checked`. Only the program's PDA
  controls escrow; user wallet signatures authorize creation/claim/refund. A
  permissionless settler may only deliver to an already-authorized claimant.

Packet, claim records and vaults are not closed in this stage, so account rent is
retained. Unsolicited token donations to a vault are not part of the packet balance
and cannot be recovered by the current refund instruction. Do not send tokens
directly to a vault. Neither rent recovery nor donation sweeping is implemented.

## Reproduce local verification

Run from the repository root. Rust 1.90.0 is pinned in `rust-toolchain.toml`;
`Cargo.lock` pins dependencies. If a project-local toolchain exists, scripts use
`.tools/cargo` and `.tools/rustup`; otherwise they use the normal Rust installation.

```sh
sh scripts/test-red-packet.sh
```

This runs four host tests (including the generated program identity test). It
explicitly **skips** the seven VM tests until a compiled SBF binary is available.

Install the official SBF builder in the same Cargo environment, if absent:

```sh
if [ -x .tools/cargo/bin/cargo ]; then
  export CARGO_HOME="$PWD/.tools/cargo"
  export RUSTUP_HOME="$PWD/.tools/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
cargo install cargo-build-sbf --version 4.4.0 --locked
sh scripts/test-red-packet-vm.sh
```

The VM script rebuilds the program with platform-tools v1.57 and runs all seven
integration tests against the compiled SBF and actual SPL programs. It uses SBPFv0
for the pinned LiteSVM/Agave 2.3 test environment. Platform tools use the official
Solana cache under the user's home directory. No RPC or wallet is used in VM tests.
Test wallets are ephemeral in memory. Build outputs and toolchains are ignored.

Verified locally:

- Host tests: 4 passed.
- SBFv0 build: passed; `target/deploy/tap_pay_red_packet.so`.
- VM tests: 7 passed, including equal transfers for both token programs, double
  claims, invalid totals/recipients, atomic rollback, expiry/refund, pending lucky
  claim blocking, oracle owner/client mismatch, permissionless fixed-recipient
  settlement, all-share conservation and last-share remainder, mutable scaled
  mint rejection, oracle-fee cap and preexisting-entropy rejection before CPI.
- Lucky tests inject clearly marked pending/fulfilled oracle fixtures. They do
  **not** prove ORAO request CPI or real fulfillment. Those require Devnet testing.

SBPFv3 compilation also passed with the command below, but the pinned LiteSVM/
Agave 2.3 environment rejects this binary at loading (`InvalidAccountData`). Thus
the passing execution tests above cover v0 only. Do not mistake either build for
a successful deployment. Follow current [official SBF tooling guidance](https://github.com/anza-xyz/cargo-build-sbf)
and verify the target cluster's supported architecture before deployment.

```sh
cargo build-sbf --manifest-path programs/red-packet/Cargo.toml \
  --arch v3 --tools-version v1.57 --sbf-out-dir target/deploy-v3 --jobs 4
```

## Android integration

The app now includes a **Token red packets** card with asset selection, ordinary
equal/lucky modes, total, share count and expiry. It supports create review,
packet QR/paste/deep-link opening, chain-state refresh, claims, VRF reservation,
permissionless completion and creator refunds.

`EXPO_PUBLIC_RED_PACKET_PROGRAM_ID` in `apps/mobile/.env` must be the actual deployed
Devnet program public address, matching `RED_PACKET_PROGRAM_ID` used to compile
that deployment. An empty value or the known undeployed test ID disables red packet
operations with a visible explanation. Program account executability/loader and
Devnet genesis are checked before preparing any transaction. Deployment operators
must independently verify the program's bytecode and upgrade authority; checking
an executable address alone is not bytecode verification.

QR format: `tappay://packet?v=1&network=devnet&program=<configured ID>&packet=<PDA>`.
Only canonical links for the configured program are accepted. QR carries no token
amount or transaction. Packet/claim account owner, discriminator, size, canonical
PDA and financial invariants are checked before displaying state. The asset must
already be in the supported registry, and its mint/profile and escrow are checked
onchain. On a second device, load the same AAPLx-DEMO mint through the existing
setup card first. Stock-like assets remain explicitly labelled as demos.

Every operation is simulated and reviewed before opening the wallet. Network fee,
new account rent and VRF fee cap are separate. Review expires after 60 seconds.
Lucky reservation explicitly requires later completion and potentially additional
fees; a confirmed reservation is not displayed as receipt of tokens. The same wallet
must sign the exact reviewed message. Only a validated onchain ClaimRecord displays
the received token amount. Completing someone else's reservation shows their fixed
recipient address and the acting wallet's fees.

Signed transaction bytes/signature and the current packet link are written locally
**before broadcast**. Reopening the app queries that signature and compares the full
onchain message before confirmation. RPC timeout does not create a replacement.
Finalized blockheight, invalid blockhash and a second absent-history query are required
to mark an unseen transaction expired. Pending operations lock other payment flows;
storage corruption fails closed and offers recovery retry. Wallet credentials are
not persisted by this feature. Only one current packet link is saved; retain the
share link before closing or replacing the view. A packet history/list is not implemented.

Files: `redPacketCodec.ts` (ABI/address validation), `redPacket.ts` (chain reads,
instruction preparation and costs), `redPacketPending.ts` / `redPacketStorage.ts`
(signed-transaction recovery), `components/RedPacket.tsx` and `App.tsx` (UI/locks).
The small ABI client uses fixtures generated by the actual Rust account/instruction
types, rather than depending on an unverified hand-written IDL.

Client checks passed:

```sh
npm run typecheck
npm test
sh scripts/check-red-packet-abi.sh
```

95 JavaScript tests pass, including ten new red packet tests: Rust/mobile ABI,
scaled amount divisibility, QR/program/network rejection, invalid account/PDA
rejection, message-bound signing, persistence-before-broadcast, ambiguous recovery,
and preflight cost/failure checks. Four Rust host tests pass. Existing seven local
SBF VM tests were not rerun for this client-only integration; the contract logic is
unchanged. ABI generation is checked against the committed deterministic fixture.

Android release build passed (`npm run apk:android` with Java 17 / Android SDK).
APK: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` (arm64-v8a).
Size: 34,905,198 bytes. SHA-256:
`f7c80b750888f9fa0ad223685a49b9ba7fa4f158c671c3a618fa734766df5eff`.
It has not been installed or tested on a device in this step. Without a deployed
program configuration, the APK correctly leaves red packet operations disabled.

## Remaining M2 work / device acceptance

1. Prepare the actual public program ID, build for the Devnet-supported SBF target,
   deploy using the owner's chosen wallet/tooling and verify deployed bytecode.
   No deployment has been performed here.
2. Set the deployed public program ID in `apps/mobile/.env`, rebuild with
   `npm run apk:android`, and install with
   `adb install --no-streaming -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.
   Finish/close existing payment reviews before using the red packet card. Connect
   wallet A, select AAPLx-DEMO, equal mode, total 1, five shares and 24 hours; review
   fees, confirm in the wallet and wait for chain confirmation. Keep the share link.
3. On wallet B, load the same mint, choose **Scan red packet**, open A's QR and review
   the claim. Wallet B receives
   0.2 displayed tokens (100,000 raw units); second claim must fail. Repeat for USDC.
4. For lucky mode, reserve and observe a real ORAO request; wait for fulfillment,
   settle from either wallet, verify the fixed recipient, remainder and no reroll.
   Exercise expiry, fulfilled-before-refund and unfulfilled grace-period behavior.

5. Cancel wallet signing: no broadcast should occur. Interrupt the network after
   signing, restart, reconnect and check the original signature; do not create a
   second packet. Test a changed program/network link, an unloaded demo mint and an
   unfunded wallet; all must fail before signing. Confirm a failed/expired transaction
   can be acknowledged and that a successful VRF reservation proceeds to completion.

Continue M2 with deployment/Devnet integration next; do not start NFT, new assets,
Mainnet or another milestone.
