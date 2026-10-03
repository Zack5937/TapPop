import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { devnetUsdc } from '../src/config';
import { createMerchantCode, encodeMerchantCode } from '../src/merchantCode';
import { createIntent, encodeRequest } from '../src/paymentIntent';
import { buildRequestTransaction, offerFromTransaction, encodeOffer, decodeOffer, inspectOffer } from '../src/checkout';
import { phoneTapPayload } from '../src/phoneTapPayload';
const require = createRequire(import.meta.url);
const { configurePhoneTap, registerPhoneTap } = require('../plugins/withPhoneTap.cjs');

test('phone tap carries the unchanged permanent merchant or fixed-amount request', () => {
  const merchant = Keypair.generate();
  const code = encodeMerchantCode(createMerchantCode(merchant.publicKey, devnetUsdc));
  assert.equal(phoneTapPayload(code), code);
  const request = createIntent(merchant.publicKey, devnetUsdc, '5');
  assert.equal(phoneTapPayload(encodeRequest(request)), encodeRequest(request));
  assert.throws(() => phoneTapPayload(encodeRequest({ ...request, createdAt: 100, expiresAt: 700 })), /expired/);
});

test('phone tap hands over an existing customer signature without changing or completing it', () => {
  const customer = Keypair.generate(), merchant = Keypair.generate();
  const request = createIntent(merchant.publicKey, devnetUsdc, '5');
  const tx = buildRequestTransaction(request, customer.publicKey, { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 });
  tx.partialSign(customer);
  const offer = offerFromTransaction(request, customer.publicKey, tx, 100);
  const text = encodeOffer(offer);
  assert.equal(phoneTapPayload(text), text);
  const received = inspectOffer(request, decodeOffer(phoneTapPayload(text)));
  assert(received.verifySignatures(false)); assert(!received.verifySignatures());
  assert.throws(() => inspectOffer({ ...request, settlementAmount: '6' }, decodeOffer(phoneTapPayload(text))));
});

test('phone transport rejects foreign data, QR fragments and malformed authorization envelopes', () => {
  for (const text of ['https://example.com', 'tappay://settle-part?id=x', 'tappay://authorize?offer=null',
    'tappay://authorize?offer={}', 'tappay://merchant?code=' + 'x'.repeat(7000)]) assert.throws(() => phoneTapPayload(text));
});

test('prebuild installs an optional system-bound HCE service and registers the bridge only once', () => {
  const manifest = { application: [{}] };
  const result = configurePhoneTap(manifest);
  const first = JSON.stringify(result);
  assert.equal(JSON.stringify(configurePhoneTap(result)), first);
  const service = result.application[0].service[0];
  assert.equal(service.$['android:permission'], 'android.permission.BIND_NFC_SERVICE');
  assert.equal(service.$['android:exported'], 'true');
  assert.equal(result['uses-feature'][0].$['android:required'], 'false');
  const source = 'PackageList(this).packages.apply {\n}';
  const registered = registerPhoneTap(source);
  assert.equal(registerPhoneTap(registered), registered);
  assert(registered.includes('add(com.onchainpayments.devnet.nfc.PhoneTapPackage())'));
  assert.throws(() => registerPhoneTap('missing application marker'));
  const xml = readFileSync(new URL('../native/phone-tap/phone_tap_service.xml', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../native/phone-tap/PhoneTapProtocol.kt', import.meta.url), 'utf8');
  const aid = /const val AID = "([A-F0-9]+)"/.exec(protocol)![1];
  assert(xml.includes(`android:name="${aid}"`));
  assert(xml.includes('android:category="other"')); assert(xml.includes('android:requireDeviceUnlock="true"'));
});
