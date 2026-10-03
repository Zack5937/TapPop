import { createMerchantCode, createMerchantPayment, encodeMerchantCode, decodeMerchantCode, validateMerchantCode, resolveMerchantPayment } from '../src/merchantCode';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, decodeTransferCheckedInstruction } from '@solana/spl-token';
import { create as createQr } from 'qrcode/lib/core/qrcode';
import { devnetUsdc, MEMO_PROGRAM } from '../src/config';
import { createIntent, validateIntent, encodeRequest, decodeRequest, intentMemo, MAX_QR_LENGTH } from '../src/paymentIntent';
import { buildRequestTransaction, prepareRequestPayment, reviewSponsorship, signCheckoutTransaction, offerFromTransaction,
  inspectOffer, encodeOffer, decodeOffer, fullySignedPayment, findRequestPayment, findOfferPayment, offerExpired } from '../src/checkout';
import { decodeCheckoutRecord } from '../src/checkoutRecord';
import { checkSettlement, matchesPayment } from '../src/payments';
import { submitSignedPayment } from '../src/signing';

function fixture(policy: 'RECEIVER' | 'PAYER' = 'RECEIVER') {
  // Ephemeral unfunded test signers; never saved or used with a live network.
  const customer = Keypair.generate();
  const merchant = Keypair.generate();
  const intent = createIntent(merchant.publicKey, devnetUsdc, '5', policy);
  const latest = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200 };
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 100_000_000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  const tokenData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: devnetUsdc.mint, owner: customer.publicKey, amount: 10_000_000n,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, tokenData);
  const state = { customerSol: 0, merchantSol: 1_000_000_000, fee: 10_000, valid: true };
  const rpc = {
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getAccountInfo: async (key: PublicKey) => {
      const data = key.equals(devnetUsdc.mint) ? mintData
        : key.equals(getAssociatedTokenAddressSync(devnetUsdc.mint, customer.publicKey)) ? tokenData : null;
      return data ? { data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 } : null;
    },
    getBalance: async (key: PublicKey) => key.equals(merchant.publicKey) ? state.merchantSol : state.customerSol,
    getLatestBlockhash: async () => latest,
    getFeeForMessage: async () => ({ value: state.fee }),
    getMinimumBalanceForRentExemption: async () => 2_039_280,
    isBlockhashValid: async () => ({ context: { slot: 100 }, value: state.valid }),
    getBlockHeight: async () => 201,
    getSignaturesForAddress: async () => [],
  } as unknown as Connection;
  const tx = buildRequestTransaction(intent, customer.publicKey, latest);
  tx.partialSign(customer);
  const offer = offerFromTransaction(intent, customer.publicKey, tx, latest.lastValidBlockHeight);
  const wallet = (signer: typeof customer): Parameters<typeof signCheckoutTransaction>[0] => ({
    authorize: async () => ({ accounts: [{ address: signer.publicKey.toBuffer().toString('base64') }], auth_token: 'test', wallet_uri_base: 'https://wallet.example' }),
    signTransactions: async ({ transactions }) => {
      for (const transaction of transactions) {
        assert(transaction instanceof Transaction); transaction.partialSign(signer);
      }
      return transactions;
    },
  });
  return { customer, merchant, intent, latest, tx, offer, rpc, state, wallet };
}
function receipt(f: ReturnType<typeof fixture>) {
  const tx = inspectOffer(f.intent, f.offer);
  if (f.intent.networkFeePolicy === 'RECEIVER') tx.partialSign(f.merchant);
  const completed = offerFromTransaction(f.intent, f.customer.publicKey, tx, f.latest.lastValidBlockHeight);
  const signed = fullySignedPayment(f.intent, completed);
  const parsed = {
    meta: { err: null }, transaction: {
      signatures: tx.signatures.map((s) => bs58.encode(s.signature!)),
      message: { recentBlockhash: f.latest.blockhash,
        accountKeys: tx.compileMessage().accountKeys.map((pubkey, index) => ({ pubkey,
          signer: index < tx.compileMessage().header.numRequiredSignatures, writable: true })),
        instructions: [
          { programId: TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info: {
            mint: f.intent.settlementMint, authority: f.customer.publicKey.toBase58(),
            source: getAssociatedTokenAddressSync(devnetUsdc.mint, f.customer.publicKey).toBase58(),
            destination: getAssociatedTokenAddressSync(devnetUsdc.mint, f.merchant.publicKey).toBase58(),
            tokenAmount: { amount: '5000000', decimals: 6 },
          } } }, { programId: MEMO_PROGRAM, parsed: intentMemo(f.intent) },
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
  return { signed, completed, parsed };
}

test('receive requests default to merchant-paid gas and disclose the separate rent policy', () => {
  const f = fixture();
  assert.equal(f.intent.networkFeePolicy, 'RECEIVER');
  assert.equal(f.intent.accountRentPolicy, 'RECEIVER');
  assert.deepEqual(decodeRequest(encodeRequest(f.intent)), f.intent);
  assert(encodeRequest(f.intent).length < MAX_QR_LENGTH);
  assert(createQr(encodeRequest(f.intent), { errorCorrectionLevel: 'M' }).modules.size > 0);
  for (const changes of [{ version: 2 }, { chain: 'solana:mainnet' }, { networkFeePolicy: 'OTHER' },
    { accountRentPolicy: 'PAYER' }, { nonce: '' }, { expiresAt: f.intent.createdAt },
    { expiresAt: f.intent.createdAt + 601 }, { settlementAmount: '5.0' }, { settlementAmount: '-1' },
    { acceptedFundingAssets: ['another-token'] }, { settlementTokenProgram: PublicKey.default.toBase58() }]) {
    assert.throws(() => validateIntent({ ...f.intent, ...changes }));
  }
  assert.throws(() => decodeRequest('https://unknown.example'));
  assert.throws(() => decodeRequest('x'.repeat(MAX_QR_LENGTH + 1)));
  assert.throws(() => validateIntent(f.intent, false, f.intent.expiresAt));
  assert.doesNotThrow(() => validateIntent(f.intent, true, f.intent.expiresAt));
});

test('sponsored payment uses merchant for fees and ATA rent, customer for tokens, and binds the request', async () => {
  const f = fixture();
  const prepared = await prepareRequestPayment(f.intent, f.customer.publicKey, f.intent.settlementMint, f.rpc);
  assert.equal(prepared.costs.accountRent, 2_039_280);
  assert(prepared.transaction.feePayer!.equals(f.merchant.publicKey));
  assert(prepared.transaction.instructions[0]!.keys[0]!.pubkey.equals(f.merchant.publicKey));
  const transfer = decodeTransferCheckedInstruction(prepared.transaction.instructions[1]!);
  assert(transfer.keys.owner.pubkey.equals(f.customer.publicKey));
  assert.equal(transfer.data.amount, 5_000_000n);
  assert.equal(prepared.transaction.compileMessage().header.numRequiredSignatures, 2);
  assert.equal(prepared.transaction.instructions[2]!.data.toString(), intentMemo(f.intent));
  await assert.rejects(prepareRequestPayment(f.intent, f.customer.publicKey, 'other-token', f.rpc), /Cross-token/);
  f.state.merchantSol = 0;
  await assert.rejects(prepareRequestPayment(f.intent, f.customer.publicKey, f.intent.settlementMint, f.rpc), /Receiver needs/);
  f.state.merchantSol = 1_000_000_000; f.state.fee = 20_001;
  await assert.rejects(prepareRequestPayment(f.intent, f.customer.publicKey, f.intent.settlementMint, f.rpc), /cap/);
});

test('payer-paid request requires payer SOL and only one signature', async () => {
  const f = fixture('PAYER');
  await assert.rejects(prepareRequestPayment(f.intent, f.customer.publicKey, f.intent.settlementMint, f.rpc), /Payer needs/);
  f.state.customerSol = 1_000_000_000; f.state.merchantSol = 0;
  const prepared = await prepareRequestPayment(f.intent, f.customer.publicKey, f.intent.settlementMint, f.rpc);
  assert(prepared.transaction.feePayer!.equals(f.customer.publicKey));
  assert.equal(prepared.transaction.compileMessage().header.numRequiredSignatures, 1);
  const signed = fullySignedPayment(f.intent, f.offer);
  assert(signed.payment.feePayer === f.customer.publicKey.toBase58());
  await assert.rejects(reviewSponsorship(f.intent, f.offer, f.merchant.publicKey, f.rpc), /receiving wallet/);
});

test('payer authorization QR is partial, fits a QR and only the correct receiver can complete it', async () => {
  const f = fixture();
  assert.deepEqual(decodeOffer(encodeOffer(f.offer)), f.offer);
  assert(createQr(encodeOffer(f.offer), { errorCorrectionLevel: 'M' }).modules.size > 0);
  assert.throws(() => fullySignedPayment(f.intent, f.offer), /Signature verification/);
  await assert.rejects(reviewSponsorship(f.intent, f.offer, f.customer.publicKey, f.rpc), /receiving wallet/);
  const checked = await reviewSponsorship(f.intent, f.offer, f.merchant.publicKey, f.rpc);
  const signed = await signCheckoutTransaction(f.wallet(f.merchant), { address: f.merchant.publicKey, authToken: 'test' }, checked.transaction, () => {});
  const finalOffer = offerFromTransaction(f.intent, f.customer.publicKey, signed, f.latest.lastValidBlockHeight);
  assert(Transaction.from(fullySignedPayment(f.intent, finalOffer).raw).verifySignatures());
  f.state.valid = false;
  await assert.rejects(reviewSponsorship(f.intent, f.offer, f.merchant.publicKey, f.rpc), /expired/);
});

test('sponsor rejects arbitrary instructions, altered amount, reference, nonce, fee payer and invalid signatures', () => {
  const f = fixture();
  for (const changed of [{ ...f.intent, settlementAmount: '6' }, { ...f.intent, nonce: 'b'.repeat(32) },
    { ...f.intent, reference: Keypair.generate().publicKey.toBase58() },
    { ...f.intent, networkFeePolicy: 'PAYER' as const, accountRentPolicy: 'PAYER' as const }]) {
    assert.throws(() => inspectOffer(changed, f.offer));
  }
  const tx = Transaction.from(Buffer.from(f.offer.transaction, 'base64'));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999_999 }));
  tx.partialSign(f.customer);
  assert.throws(() => inspectOffer(f.intent, { ...f.offer, transaction: tx.serialize({ requireAllSignatures: false }).toString('base64') }), /does not match/);
  const invalid = Transaction.from(Buffer.from(f.offer.transaction, 'base64'));
  invalid.addSignature(f.customer.publicKey, Buffer.alloc(64, 9));
  assert.throws(() => inspectOffer(f.intent, { ...f.offer, transaction: invalid.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }), /signature/);
  assert.throws(() => inspectOffer(f.intent, { ...f.offer, transaction: f.offer.transaction + '\n' }), /encoding/);
  assert.throws(() => inspectOffer(f.intent, { ...f.offer, lastValidBlockHeight: 0 }));
});

test('wallet must preserve the customer signature and transaction message while adding merchant signature', async () => {
  const f = fixture();
  const session = { address: f.merchant.publicKey, authToken: 'test' };
  const wallet = f.wallet(f.merchant);
  wallet.signTransactions = async ({ transactions }) => {
    const tx = transactions[0] as Transaction;
    tx.signatures.find((s) => s.publicKey.equals(f.customer.publicKey))!.signature = null;
    tx.partialSign(f.merchant); return transactions;
  };
  await assert.rejects(signCheckoutTransaction(wallet, session, inspectOffer(f.intent, f.offer), () => {}), /missing payment signatures/);
  await assert.rejects(signCheckoutTransaction(f.wallet(f.customer), session, inspectOffer(f.intent, f.offer), () => {}), /account changed/);
});

test('both payment modes settle only with matching amount, fee payer, transfer authority, reference and memo', async () => {
  for (const policy of ['RECEIVER', 'PAYER'] as const) {
    const f = fixture(policy);
    const { signed, parsed } = receipt(f);
    assert(matchesPayment(parsed, signed.payment));
    assert(!matchesPayment(parsed, { ...signed.payment, feePayer: Keypair.generate().publicKey.toBase58() }));
    assert(!matchesPayment(parsed, { ...signed.payment, reference: Keypair.generate().publicKey.toBase58() }));
    assert(!matchesPayment(parsed, { ...signed.payment, memo: 'other request' }));
    f.rpc.getSignaturesForAddress = async () => [{ signature: signed.payment.signature, err: null, slot: 1, memo: null, blockTime: 1, confirmationStatus: 'confirmed' }];
    f.rpc.getParsedTransaction = async () => parsed;
    assert.equal((await findRequestPayment(f.intent, f.rpc))?.signature, signed.payment.signature);
    assert.equal((await findOfferPayment(f.intent, f.offer, f.rpc))?.signature, signed.payment.signature);
  }
});

test('saved partial checkout restores and mismatched intent/payment data fails closed', () => {
  const f = fixture();
  const restored = decodeCheckoutRecord(JSON.stringify({ role: 'pay', intent: f.intent, offer: f.offer }));
  assert.equal(restored.role, 'pay');
  assert.throws(() => decodeCheckoutRecord(''));
  assert.throws(() => decodeCheckoutRecord(JSON.stringify({ ...restored, intent: { ...f.intent, settlementAmount: '6' } })));
  const { signed } = receipt(f);
  assert.doesNotThrow(() => decodeCheckoutRecord(JSON.stringify({ ...restored, pending: signed.payment })));
  assert.throws(() => decodeCheckoutRecord(JSON.stringify({ ...restored, pending: { ...signed.payment, feePayer: f.customer.publicKey.toBase58() } })));
});

test('sponsored broadcast waits for durable storage and a timeout retains its actual fee-payer signature', async () => {
  const f = fixture();
  const { signed } = receipt(f);
  let saved = false;
  await assert.rejects(submitSignedPayment(signed, async () => { throw new Error('disk full'); }, async () => {
    assert.fail('must not broadcast');
  }), /disk full/);
  await assert.rejects(submitSignedPayment(signed, async () => { saved = true; }, async () => {
    assert(saved); throw new Error('timeout');
  }), /timeout/);
});

test('expiry requires an invalid finalized blockhash and incomplete reference history blocks recovery', async () => {
  const f = fixture();
  assert.equal(await offerExpired(f.offer, f.rpc), false);
  f.state.valid = false;
  assert.equal(await offerExpired(f.offer, f.rpc), true);
  f.rpc.getSignaturesForAddress = async () => [{ signature: 'unknown', err: null, slot: 1, memo: null, blockTime: 1, confirmationStatus: 'confirmed' }];
  f.rpc.getParsedTransaction = async () => null;
  await assert.rejects(findOfferPayment(f.intent, f.offer, f.rpc), /history is incomplete/);
  const { signed } = receipt(f);
  f.rpc.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [null] });
  f.state.valid = true;
  assert.equal(await checkSettlement(signed.payment, f.rpc), 'pending');
  f.state.valid = false;
  assert.equal(await checkSettlement(signed.payment, f.rpc), 'expired');
});

test('a settled receive request cannot be prepared again, and another signature cannot settle a saved offer', async () => {
  const f = fixture();
  const { signed, parsed } = receipt(f);
  f.rpc.getSignaturesForAddress = async () => [{ signature: signed.payment.signature, err: null, slot: 1, memo: null, blockTime: 1, confirmationStatus: 'confirmed' }];
  f.rpc.getParsedTransaction = async () => parsed;
  await assert.rejects(prepareRequestPayment(f.intent, f.customer.publicKey, f.intent.settlementMint, f.rpc), /already been paid/);
  parsed.transaction.signatures[1] = bs58.encode(Buffer.alloc(64, 8));
  assert.equal(await findOfferPayment(f.intent, f.offer, f.rpc), null);
});

test('customer signs a fresh sponsored transaction without merchant authorization or SOL payment', async () => {
  const f = fixture();
  const prepared = await prepareRequestPayment(f.intent, f.customer.publicKey, f.intent.settlementMint, f.rpc);
  const tx = await signCheckoutTransaction(f.wallet(f.customer), { address: f.customer.publicKey, authToken: 'test' }, prepared.transaction, () => {});
  assert(tx.signatures.find((s) => s.publicKey.equals(f.customer.publicKey))?.signature);
  assert.equal(tx.signatures.find((s) => s.publicKey.equals(f.merchant.publicKey))?.signature, null);
  assert(tx.verifySignatures(false));
  assert(!tx.verifySignatures());
  const wallet = f.wallet(f.customer);
  wallet.signTransactions = async () => { throw new Error('User declined'); };
  await assert.rejects(signCheckoutTransaction(wallet, { address: f.customer.publicKey, authToken: 'test' }, prepared.transaction, () => {}), /User declined/);
});

test('reusable merchant QR creates independent customer-entered amounts with merchant-paid fees', () => {
  const f = fixture();
  const code = createMerchantCode(f.merchant.publicKey, devnetUsdc);
  assert.deepEqual(decodeMerchantCode(encodeMerchantCode(code)), code);
  assert(createQr(encodeMerchantCode(code), { errorCorrectionLevel: 'M' }).modules.size > 0);
  const first = createMerchantPayment(code, '2.75');
  const second = createMerchantPayment(code, '8');
  assert.equal(first.settlementAmount, '2.75');
  assert.equal(first.networkFeePolicy, 'RECEIVER');
  assert.equal(first.accountRentPolicy, 'RECEIVER');
  assert.equal(first.merchantCodeId, code.codeId);
  assert.notEqual(first.intentId, second.intentId);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.reference, second.reference);
  for (const amount of ['', '0', '-1', '1.0000001', 'NaN']) assert.throws(() => createMerchantPayment(code, amount));
  for (const changes of [{ networkFeePolicy: 'PAYER' }, { accountRentPolicy: 'PAYER' }, { codeId: '' },
    { expiresAt: code.createdAt + 86401 }, { settlementMint: PublicKey.default.toBase58() }]) {
    assert.throws(() => validateMerchantCode({ ...code, ...changes }));
  }
  assert.equal(code.version, 2);
  assert.equal(code.expiresAt, null);
  assert.doesNotThrow(() => validateMerchantCode(code, false, code.createdAt + 10 * 365 * 86400));
  assert.throws(() => validateIntent(first, false, first.expiresAt));
  assert.equal(first.expiresAt - first.createdAt, 600);
  const legacy = { ...code, version: 1, expiresAt: code.createdAt + 86400 };
  assert.doesNotThrow(() => validateMerchantCode(legacy));
  assert.throws(() => validateMerchantCode(legacy, false, legacy.expiresAt));
  assert.doesNotThrow(() => validateMerchantCode(legacy, true, legacy.expiresAt));
  assert.throws(() => validateMerchantCode({ ...code, version: 1 }));
  assert.throws(() => validateMerchantCode({ ...legacy, version: 2 }));
  assert.deepEqual(decodeCheckoutRecord(JSON.stringify({ role: 'merchant', code })), { role: 'merchant', code });
});

test('merchant customer amount survives QR exchange, merchant cosign and saved checkout recovery', async () => {
  const f = fixture();
  const code = createMerchantCode(f.merchant.publicKey, devnetUsdc);
  const intent = createMerchantPayment(code, '5');
  const prepared = await prepareRequestPayment(intent, f.customer.publicKey, intent.settlementMint, f.rpc);
  assert.equal(f.state.customerSol, 0);
  prepared.transaction.partialSign(f.customer);
  const offer = offerFromTransaction(intent, f.customer.publicKey, prepared.transaction, f.latest.lastValidBlockHeight);
  const text = encodeOffer(offer);
  assert(text.length <= MAX_QR_LENGTH, `authorization length ${text.length}`);
  assert(createQr(text, { errorCorrectionLevel: 'M' }).modules.size > 0);
  const recovered = resolveMerchantPayment(code, decodeOffer(text));
  assert.deepEqual(recovered, intent);
  const checked = await reviewSponsorship(recovered, decodeOffer(text), f.merchant.publicKey, f.rpc);
  checked.transaction.partialSign(f.merchant);
  const signed = fullySignedPayment(intent, offerFromTransaction(intent, f.customer.publicKey, checked.transaction, f.latest.lastValidBlockHeight));
  assert(Transaction.from(signed.raw).verifySignatures());
  assert.equal(signed.payment.feePayer, code.receiver);
  for (const record of [{ role: 'merchant', code }, { role: 'pay', intent, offer },
    { role: 'receive', intent, merchantCode: code, pending: signed.payment }]) {
    const restored = decodeCheckoutRecord(JSON.stringify(record));
    assert.equal(restored.role, record.role);
  }
  assert.throws(() => decodeCheckoutRecord(JSON.stringify({ role: 'receive', intent, merchantCode: { ...code, codeId: 'a'.repeat(32) } })));
});

test('merchant sponsorship rejects customer amount, code identity and reference tampering', () => {
  const f = fixture();
  const code = createMerchantCode(f.merchant.publicKey, devnetUsdc);
  const intent = createMerchantPayment(code, '5');
  const tx = buildRequestTransaction(intent, f.customer.publicKey, f.latest);
  tx.partialSign(f.customer);
  const offer = offerFromTransaction(intent, f.customer.publicKey, tx, f.latest.lastValidBlockHeight);
  for (const changes of [{ amount: '6' }, { reference: Keypair.generate().publicKey.toBase58() }, { codeId: 'a'.repeat(32) }]) {
    const changed = { ...offer, merchantPayment: { ...offer.merchantPayment!, ...changes } };
    assert.throws(() => inspectOffer(resolveMerchantPayment(code, changed), changed));
  }
  assert.throws(() => resolveMerchantPayment(createMerchantCode(f.merchant.publicKey, devnetUsdc), offer));
  assert.throws(() => resolveMerchantPayment(code, { ...offer, merchantPayment: undefined }));
  assert.throws(() => inspectOffer({ ...intent, merchantCodeId: undefined }, offer));
});
