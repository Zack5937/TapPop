import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PhantomWallet, PHANTOM_APP_URL, type PhantomTransport } from '../src/phantomWallet';
import { signCheckoutTransaction } from '../src/checkout';
import { paymentLinkTarget } from '../src/paymentLinks';

const authorize = { chain: 'solana:devnet' as const, identity: { name: 'Tap Pay' } };

// Test-only wallets are freshly generated and never funded or persisted.
function harness(signer = Keypair.generate(), timeout = 1000) {
  const encryption = nacl.box.keyPair();
  let receive: ((url: string) => void) | undefined;
  let shared: Uint8Array;
  let redirect: URL;
  let token: string;
  let hook: ((request: URL) => void) | undefined;
  let mutate: ((transaction: Transaction) => Transaction) | undefined;
  let cluster = 'devnet';
  let corruptSession = false;
  const methods: string[] = [];
  const respond = (payload?: object) => {
    const callback = new URL(redirect);
    if (payload) {
      const nonce = nacl.randomBytes(24);
      callback.searchParams.set('nonce', bs58.encode(nonce));
      callback.searchParams.set('data', bs58.encode(nacl.box.after(Buffer.from(JSON.stringify(payload)), nonce, shared)));
      callback.searchParams.set('phantom_encryption_public_key', bs58.encode(encryption.publicKey));
    }
    receive?.(callback.toString());
    return callback.toString();
  };
  const transport: PhantomTransport = {
    subscribe: (listener) => { receive = listener; return () => { receive = undefined; }; },
    open: async (text) => {
      const request = new URL(text);
      assert.equal(request.origin, 'https://phantom.com');
      redirect = new URL(request.searchParams.get('redirect_link')!);
      assert.equal(paymentLinkTarget(redirect.toString()), null);
      methods.push(request.pathname);
      if (hook) { hook(request); return; }
      shared = nacl.box.before(bs58.decode(request.searchParams.get('dapp_encryption_public_key')!), encryption.secretKey);
      if (request.pathname.endsWith('/connect')) {
        assert.equal(request.searchParams.get('cluster'), 'devnet');
        assert.equal(request.searchParams.get('app_url'), PHANTOM_APP_URL);
        token = bs58.encode(nacl.sign(Buffer.from(JSON.stringify({ app_url: PHANTOM_APP_URL, chain: 'solana', cluster })), signer.secretKey));
        if (corruptSession) token = bs58.encode(nacl.randomBytes(100));
        respond({ public_key: signer.publicKey.toBase58(), session: token });
        return;
      }
      const decoded = nacl.box.open.after(bs58.decode(request.searchParams.get('payload')!), bs58.decode(request.searchParams.get('nonce')!), shared);
      assert.ok(decoded);
      const payload = JSON.parse(Buffer.from(decoded).toString('utf8'));
      assert.equal(payload.session, token);
      if (request.pathname.endsWith('/disconnect')) { respond(); return; }
      assert.equal(request.pathname, '/ul/v1/signTransaction');
      let transaction = Transaction.from(bs58.decode(payload.transaction));
      transaction.partialSign(signer);
      if (mutate) transaction = mutate(transaction);
      respond({ transaction: bs58.encode(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })) });
    },
  };
  return {
    wallet: new PhantomWallet(transport, timeout), signer, methods, respond,
    callback: () => new URL(redirect),
    receive: (url: string) => receive?.(url),
    subscribed: () => !!receive,
    setHook: (value: typeof hook) => { hook = value; },
    mutate: (value: typeof mutate) => { mutate = value; },
    cluster: (value: string) => { cluster = value; },
    corruptSession: () => { corruptSession = true; },
  };
}

function payment(sender: Keypair, merchant: Keypair) {
  return new Transaction({ feePayer: merchant.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: sender.publicKey, toPubkey: merchant.publicKey, lamports: 1 }));
}

test('Phantom Devnet connect verifies session, reuses it, and disconnect clears it', async () => {
  const h = harness();
  const auth = await h.wallet.authorize(authorize);
  assert.equal(auth.accounts[0]!.address, h.signer.publicKey.toBuffer().toString('base64'));
  assert.deepEqual(await h.wallet.authorize({ ...authorize, auth_token: auth.auth_token }), auth);
  assert.equal(h.methods.length, 1);
  await h.wallet.deauthorize({ auth_token: auth.auth_token });
  assert.equal(h.subscribed(), false);
  await assert.rejects(h.wallet.authorize({ ...authorize, auth_token: auth.auth_token }), /session ended/);
});

test('Phantom rejects wrong chain, mainnet sessions and forged session signatures', async () => {
  const h = harness();
  await assert.rejects(h.wallet.authorize({ ...authorize, chain: 'solana:mainnet' }), /Devnet/);
  assert.equal(h.methods.length, 0);
  h.cluster('mainnet-beta');
  await assert.rejects(h.wallet.authorize(authorize), /Devnet/);
  h.cluster('devnet'); h.corruptSession();
  await assert.rejects(h.wallet.authorize(authorize), /signature/);
});

test('customer then merchant can sign the same payment through the existing checkout validator', async () => {
  const customer = harness(); const merchant = harness();
  const customerAuth = await customer.wallet.authorize(authorize);
  const merchantAuth = await merchant.wallet.authorize(authorize);
  const transaction = payment(customer.signer, merchant.signer);
  const partial = await signCheckoutTransaction(customer.wallet,
    { address: customer.signer.publicKey, authToken: customerAuth.auth_token }, transaction, () => {});
  assert.equal(partial.verifySignatures(true), false);
  const signed = await signCheckoutTransaction(merchant.wallet,
    { address: merchant.signer.publicKey, authToken: merchantAuth.auth_token }, partial, () => {});
  assert.equal(signed.verifySignatures(true), true);
  assert.ok(signed.feePayer!.equals(merchant.signer.publicKey));
  assert.deepEqual(signed.serializeMessage(), transaction.serializeMessage());
  assert.equal(customer.methods.some((method) => method.includes('signAndSend')), false);
});

test('changed message, stripped cosigner signature and missing wallet signature are rejected', async () => {
  const h = harness(); const sender = Keypair.generate();
  await h.wallet.authorize(authorize);
  const original = payment(sender, h.signer); original.partialSign(sender);
  h.mutate((tx) => { tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); tx.partialSign(h.signer); return tx; });
  await assert.rejects(h.wallet.signTransactions({ transactions: [original] }), /changed the transaction/);
  h.mutate((tx) => { tx.signatures.find((s) => s.publicKey.equals(sender.publicKey))!.signature = null; return tx; });
  await assert.rejects(h.wallet.signTransactions({ transactions: [original] }), /invalid signatures/);
  h.mutate((tx) => { tx.signatures.find((s) => s.publicKey.equals(h.signer.publicKey))!.signature = null; return tx; });
  await assert.rejects(h.wallet.signTransactions({ transactions: [original] }), /invalid signatures/);
  h.mutate((tx) => { tx.signatures.find((s) => s.publicKey.equals(h.signer.publicKey))!.signature!.fill(1); return tx; });
  await assert.rejects(h.wallet.signTransactions({ transactions: [original] }), /invalid signatures/);
});

test('callbacks require exact route and per-request state; replay cannot complete a later request', async () => {
  const h = harness(undefined, 30);
  await h.wallet.authorize(authorize);
  const stale = h.callback();
  h.setHook(() => {
    const callback = h.callback();
    h.receive(stale.toString());
    callback.hostname = 'merchant'; h.receive(callback.toString());
    callback.hostname = 'wallet'; callback.searchParams.set('state', 'forged'); h.receive(callback.toString());
  });
  await assert.rejects(h.wallet.signTransactions({ transactions: [payment(h.signer, Keypair.generate())] }), /timed out/);
  assert.equal(h.subscribed(), false);
});

test('rejection, corrupt encryption, duplicate fields and open failures never return a signed transaction', async () => {
  const h = harness(); await h.wallet.authorize(authorize);
  const tx = payment(h.signer, Keypair.generate());
  h.setHook(() => { const callback = h.callback(); callback.searchParams.set('errorCode', '4001'); h.receive(callback.toString()); });
  await assert.rejects(h.wallet.signTransactions({ transactions: [tx] }), /rejected/);
  h.setHook(() => {
    const callback = h.callback();
    callback.searchParams.set('nonce', bs58.encode(nacl.randomBytes(24)));
    callback.searchParams.set('data', bs58.encode(nacl.randomBytes(100)));
    h.receive(callback.toString());
  });
  await assert.rejects(h.wallet.signTransactions({ transactions: [tx] }), /authenticate/);
  h.setHook(() => { const callback = h.callback(); callback.searchParams.append('data', 'a'); callback.searchParams.append('data', 'b'); h.receive(callback.toString()); });
  await assert.rejects(h.wallet.signTransactions({ transactions: [tx] }), /Duplicate/);
  h.setHook(() => { throw new Error('Phantom not installed'); });
  await assert.rejects(h.wallet.signTransactions({ transactions: [tx] }), /not installed/);
  assert.equal(h.subscribed(), false);
});

test('an outstanding request blocks another; cold restart requires reconnecting', async () => {
  const h = harness(undefined, 30); h.setHook(() => {});
  const pending = h.wallet.authorize(authorize);
  await assert.rejects(h.wallet.authorize(authorize), /already open/);
  await assert.rejects(pending, /timed out/);
  h.setHook(undefined);
  const auth = await h.wallet.authorize(authorize);
  const restarted = harness();
  await assert.rejects(restarted.wallet.authorize({ ...authorize, auth_token: auth.auth_token }), /session ended/);
  await assert.rejects(restarted.wallet.signTransactions({ transactions: [payment(h.signer, Keypair.generate())] }), /Connect Phantom/);
});
