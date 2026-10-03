import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import type { Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { config } from '../src/config';
import { transferInstructions, type PendingPayment, type prepareTransfer } from '../src/payments';
import { authorizedAddress, signAssetTransfer, submitSignedPayment, type WalletSession } from '../src/signing';
import { initialPaymentState, paymentReducer } from '../src/paymentState';
import { paymentErrorMessage } from '../src/errors';

function fixture() {
  // Ephemeral test-only signers, never funded, stored, logged or used by the app.
  const signer = Keypair.generate();
  const receiver = Keypair.generate().publicKey.toBase58();
  const session: WalletSession = { address: signer.publicKey, authToken: 'test-session' };
  const latest = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };
  const events: string[] = [];
  const prepare: typeof prepareTransfer = async () => {
    events.push('prepare');
    return {
      latest,
      transaction: new Transaction({ feePayer: signer.publicKey, ...latest })
        .add(...transferInstructions(signer.publicKey, new PublicKey(receiver), 1_000_000n)),
    };
  };
  const wallet: Pick<Web3MobileWallet, 'authorize' | 'signTransactions'> = {
    authorize: async (request) => {
      events.push('authorize');
      assert('chain' in request);
      assert.equal(request.chain, config.chain);
      return { accounts: [{ address: signer.publicKey.toBuffer().toString('base64') }], auth_token: 'renewed-test-session', wallet_uri_base: 'https://wallet.example' };
    },
    signTransactions: async ({ transactions }) => {
      events.push('sign');
      for (const tx of transactions) {
        assert(tx instanceof Transaction);
        tx.partialSign(signer);
      }
      return transactions;
    },
  };
  return { signer, receiver, session, wallet, prepare, events };
}

test('only the reviewed transaction is signed; renewed authorization is returned', async () => {
  const f = fixture();
  let renewed: WalletSession | undefined;
  const signed = await signAssetTransfer(f.wallet, f.session, f.receiver, '1.000000', (s) => { renewed = s; }, f.prepare);
  assert.deepEqual(f.events, ['authorize', 'prepare', 'sign']);
  assert.equal(renewed?.authToken, 'renewed-test-session');
  assert.equal(signed.payment.amount, '1');
  assert.equal(signed.payment.receiver, f.receiver);
  assert(Transaction.from(signed.raw).verifySignatures());
});

test('changed wallet account blocks signing and transaction preparation', async () => {
  const f = fixture();
  f.wallet.authorize = async () => ({ accounts: [{ address: Keypair.generate().publicKey.toBuffer().toString('base64') }], auth_token: 'test', wallet_uri_base: 'https://wallet.example' });
  await assert.rejects(signAssetTransfer(f.wallet, f.session, f.receiver, '1', () => {}, f.prepare), /account changed/);
  assert.deepEqual(f.events, []);
});

test('invalid amounts are rejected before opening wallet authorization', async () => {
  const f = fixture();
  await assert.rejects(signAssetTransfer(f.wallet, f.session, f.receiver, '0.0000001', () => {}, f.prepare));
  assert.deepEqual(f.events, []);
});

test('wallet cancellation never produces a transaction to submit', async () => {
  const f = fixture();
  f.wallet.signTransactions = async () => { throw new Error('User declined'); };
  await assert.rejects(signAssetTransfer(f.wallet, f.session, f.receiver, '1', () => {}, f.prepare), /User declined/);
});

test('wallet mutation of the original transaction is rejected even with a valid signature', async () => {
  const f = fixture();
  f.wallet.signTransactions = async ({ transactions }) => {
    for (const tx of transactions) {
      assert(tx instanceof Transaction);
      tx.instructions[1]!.data[1] = tx.instructions[1]!.data[1]! ^ 1;
      tx.partialSign(f.signer);
    }
    return transactions;
  };
  await assert.rejects(signAssetTransfer(f.wallet, f.session, f.receiver, '1', () => {}, f.prepare), /unexpected transaction/);
});

test('invalid or missing signatures are rejected before broadcast', async () => {
  const f = fixture();
  f.wallet.signTransactions = async ({ transactions }) => transactions;
  await assert.rejects(signAssetTransfer(f.wallet, f.session, f.receiver, '1', () => {}, f.prepare), /unexpected transaction/);
  f.wallet.signTransactions = async ({ transactions }) => {
    for (const tx of transactions) {
      assert(tx instanceof Transaction);
      tx.addSignature(f.signer.publicKey, Buffer.alloc(64, 7));
    }
    return transactions;
  };
  await assert.rejects(signAssetTransfer(f.wallet, f.session, f.receiver, '1', () => {}, f.prepare), /Signature verification failed/);
});

test('broadcast occurs only after persistence and preserves the exact signed bytes', async () => {
  const f = fixture();
  const signed = await signAssetTransfer(f.wallet, f.session, f.receiver, '1', () => {}, f.prepare);
  let saved: PendingPayment | undefined;
  await submitSignedPayment(signed, async (payment) => { saved = payment; }, async (raw, options) => {
    assert.equal(saved?.signature, signed.payment.signature);
    assert.deepEqual(raw, signed.raw);
    assert.equal(options?.skipPreflight, false);
    return signed.payment.signature;
  });
  let broadcasts = 0;
  await assert.rejects(submitSignedPayment(signed, async () => { throw new Error('Disk full'); }, async () => {
    broadcasts++; return signed.payment.signature;
  }), /Disk full/);
  assert.equal(broadcasts, 0);
});

test('timeout or mismatched RPC signature retains the original pending payment', async () => {
  const f = fixture();
  const signed = await signAssetTransfer(f.wallet, f.session, f.receiver, '1', () => {}, f.prepare);
  let saved: PendingPayment | undefined;
  const persist = async (payment: PendingPayment) => { saved = payment; };
  await assert.rejects(submitSignedPayment(signed, persist, async () => { throw new Error('Network timeout'); }), /Network timeout/);
  assert.equal(saved?.signature, signed.payment.signature);
  await assert.rejects(submitSignedPayment(signed, persist, async () => 'unexpected'), /different signature/);
  assert.equal(saved?.signature, signed.payment.signature);
});

test('wallet address must be canonical base64 encoding of a regular 32-byte public key', () => {
  const f = fixture();
  const valid = f.signer.publicKey.toBuffer().toString('base64');
  assert(authorizedAddress(valid).equals(f.signer.publicKey));
  for (const invalid of ['', 'garbage', valid + '!', Buffer.alloc(31).toString('base64')]) {
    assert.throws(() => authorizedAddress(invalid));
  }
});

test('native wallet errors give actionable messages without claiming payment success', () => {
  assert.match(paymentErrorMessage({ code: 'ERROR_WALLET_NOT_FOUND' }), /Install a Mobile Wallet Adapter wallet/);
  assert.match(paymentErrorMessage({ code: -3 }), /cancelled/);
  assert.match(paymentErrorMessage({ code: 'Session not established: Local association cancelled by user' }), /cancelled/);
  assert.match(paymentErrorMessage({ code: -1 }), /Reconnect/);
  assert.match(paymentErrorMessage({ code: 'ERROR_SESSION_TIMEOUT' }), /pending/);
  assert.equal(paymentErrorMessage(new Error('Not enough Devnet USDC.')), 'Not enough Devnet USDC.');
  assert.match(paymentErrorMessage(null), /Could not complete/);
});

test('late queries cannot downgrade a terminal state, or mutate a different payment', async () => {
  const f = fixture();
  const { payment } = await signAssetTransfer(f.wallet, f.session, f.receiver, '1', () => {}, f.prepare);
  const pending = paymentReducer(initialPaymentState, { type: 'save', payment });
  assert.equal(paymentReducer(pending, { type: 'clear', signature: payment.signature }), pending);
  const confirmed = paymentReducer(pending, { type: 'status', signature: payment.signature, settlement: 'confirmed' });
  assert.equal(paymentReducer(confirmed, { type: 'status', signature: payment.signature, settlement: 'pending' }), confirmed);
  assert.equal(paymentReducer(pending, { type: 'status', signature: 'old-signature', settlement: 'confirmed' }), pending);
  const cleared = paymentReducer(confirmed, { type: 'clear', signature: payment.signature });
  assert.equal(cleared.payment, null);
  assert.equal(paymentReducer(cleared, { type: 'status', signature: payment.signature, settlement: 'confirmed' }), cleared);
  assert.equal(paymentReducer(initialPaymentState, { type: 'restore', payment }).settlement, 'pending');
});
