import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import { devnetUsdc, registerDemoMint } from '../src/config';
import { createIntent, encodeRequest, OFFER_PREFIX } from '../src/paymentIntent';
import { createMerchantCode, encodeMerchantCode } from '../src/merchantCode';
import { createDemoRequest, encodeDemoRecord, buildDemoExchange, exchangeFromTransaction } from '../src/demoSettlement';
import { SETTLEMENT_PART_PREFIX } from '../src/settlementTransport';
import { paymentLinkTarget, prepareNfcRequest } from '../src/paymentLinks';

const require = createRequire(import.meta.url);
const { configurePaymentNfc } = require('../plugins/withPaymentNfc.cjs');

test('NFC merchant payload preserves the same permanent receive link and reports full NDEF size', () => {
  const code = createMerchantCode(Keypair.generate().publicKey, devnetUsdc);
  const uri = encodeMerchantCode(code);
  const prepared = prepareNfcRequest(uri);
  assert.equal(prepared.uri, uri);
  assert.equal(prepared.permanent, true);
  assert.equal(prepared.ndefBytes, Buffer.byteLength(uri, 'utf8') + 8);
  assert.equal(paymentLinkTarget(uri), 'checkout');
});

test('NFC fixed-amount requests preserve receiver, amount, fees and original expiry', () => {
  const intent = createIntent(Keypair.generate().publicKey, devnetUsdc, '5');
  const uri = encodeRequest(intent);
  assert.equal(prepareNfcRequest(uri).uri, uri);
  assert.equal(prepareNfcRequest(uri).permanent, false);
  assert.throws(() => prepareNfcRequest(encodeRequest({ ...intent, createdAt: 100, expiresAt: 700 })), /expired/);
  assert.throws(() => prepareNfcRequest('tappay://pay?request=%GG'));
  assert.throws(() => prepareNfcRequest('tappay://merchant?code=%7B%7D'));
});

test('NFC demo discovery accepts an unsigned request but never exports a signed authorization', () => {
  const merchant = Keypair.generate(), liquidity = Keypair.generate(), customer = Keypair.generate();
  const asset = registerDemoMint(Keypair.generate().publicKey.toBase58());
  const request = createDemoRequest(merchant.publicKey, liquidity.publicKey.toBase58(), asset.mint.toBase58(), '5');
  const uri = encodeDemoRecord({ request });
  assert.equal(prepareNfcRequest(uri).uri, uri);
  assert.equal(prepareNfcRequest(uri).permanent, false);
  assert.equal(paymentLinkTarget(uri), 'demo');
  const tx = buildDemoExchange(request, customer.publicKey, { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 });
  tx.partialSign(customer);
  const exchange = exchangeFromTransaction(request, customer.publicKey, tx, 100);
  assert.throws(() => prepareNfcRequest(encodeDemoRecord({ request, exchange })), /not signed payment/);
  assert.throws(() => prepareNfcRequest(OFFER_PREFIX + '{}'));
  assert.throws(() => prepareNfcRequest(SETTLEMENT_PART_PREFIX + 'id=abc'));
});

test('link routing separates payment flows and rejects foreign hosts, schemes and oversized payloads', () => {
  assert.equal(paymentLinkTarget('tappay://authorize?offer=x'), 'checkout');
  assert.equal(paymentLinkTarget('tappay://settle-part?id=x'), 'demo');
  for (const uri of ['https://merchant.example', 'javascript:alert(1)', 'tappay://pay.evil?request=x',
    'tappay://settlement?data=x', 'tappay://merchant/other?code=x', 'tappay://pay?request=' + 'x'.repeat(7000)]) {
    assert.equal(paymentLinkTarget(uri), null);
  }
  // Routing is deliberately not validation: a matching host still needs its
  // existing handler, which rejects malformed or expired payloads.
  assert.equal(paymentLinkTarget('tappay://pay?request=invalid'), 'checkout');
  assert.throws(() => prepareNfcRequest('tappay://pay?request=invalid'));
});

test('Expo prebuild NFC configuration is optional, narrow and idempotent, preserving VIEW and launcher filters', () => {
  const launcher = { action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }] };
  const view = { action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }], data: [{ $: { 'android:scheme': 'tappay' } }] };
  const manifest = { application: [{ activity: [{ $: { 'android:name': '.MainActivity' }, 'intent-filter': [launcher, view] }] }] };
  const once = JSON.stringify(configurePaymentNfc(manifest));
  assert.equal(JSON.stringify(configurePaymentNfc(manifest)), once);
  const result = JSON.parse(once);
  assert.equal(result['uses-feature'][0].$['android:required'], 'false');
  assert.equal(result['uses-permission'][0].$['android:name'], 'android.permission.NFC');
  const filters = result.application[0].activity[0]['intent-filter'];
  assert.deepEqual(filters.slice(0, 2), [launcher, view]);
  assert.deepEqual(filters.slice(2).map((f: { data: { $: Record<string, string> }[] }) => f.data[0]!.$['android:host']), ['pay', 'merchant', 'settle']);
  assert(filters.slice(2).every((f: { action: { $: Record<string, string> }[] }) => f.action[0]!.$['android:name'] === 'android.nfc.action.NDEF_DISCOVERED'));
  assert.throws(() => configurePaymentNfc({}), /MainActivity/);
});
