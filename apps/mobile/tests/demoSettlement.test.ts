import { phoneTapPayload } from '../src/phoneTapPayload';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram, type Connection, type TransactionResponse } from '@solana/web3.js';
import { AccountLayout, MintLayout, ScaledUiAmountConfigLayout, ExtensionType, getMintLen,
  getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction } from '@solana/spl-token';
import { create as createQr } from 'qrcode/lib/core/qrcode';
import { registerDemoMint, devnetUsdc } from '../src/config';
import { DemoQuoteProvider } from '../src/demoQuote';
import { createDemoRequest, validateDemoRequest, buildDemoExchange, prepareDemoExchange, inspectDemoExchange,
  exchangeFromTransaction, mergeDemoExchange, reviewDemoExchange, broadcastDemoExchange, observeDemoSettlement,
  encodeDemoRecord, decodeDemoText, decodeDemoRecord, type DemoExchange } from '../src/demoSettlement';
import { settlementFrames, SettlementCollector } from '../src/settlementTransport';
import { signCheckoutTransaction } from '../src/checkout';

function fixture() {
  // Unfunded ephemeral test signers; no live keys, RPC or wallet access.
  const merchant = Keypair.generate(), customer = Keypair.generate(), liquidity = Keypair.generate();
  const asset = registerDemoMint(Keypair.generate().publicKey.toBase58());
  const request = createDemoRequest(merchant.publicKey, liquidity.publicKey.toBase58(), asset.mint.toBase58(), '5');
  const latest = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200 };
  const accounts = new Map<string, { data: Buffer; owner: PublicKey; executable: boolean; lamports: number; rentEpoch: number }>();
  function mintData(scaled: boolean) {
    const data = Buffer.alloc(scaled ? getMintLen([ExtensionType.ScaledUiAmountConfig]) : MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 100_000_000n, decimals: 6,
      isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    if (scaled) {
      data[165] = 1; data.writeUInt16LE(ExtensionType.ScaledUiAmountConfig, 166); data.writeUInt16LE(ScaledUiAmountConfigLayout.span, 168);
      ScaledUiAmountConfigLayout.encode({ authority: PublicKey.default, multiplier: 2, newMultiplier: 2, newMultiplierEffectiveTimestamp: 0n }, data.subarray(170));
    }
    return data;
  }
  const info = (data: Buffer, owner: PublicKey) => ({ data, owner, executable: false, lamports: 2_000_000, rentEpoch: 0 });
  accounts.set(asset.mint.toBase58(), info(mintData(true), TOKEN_2022_PROGRAM_ID));
  accounts.set(devnetUsdc.mint.toBase58(), info(mintData(false), TOKEN_PROGRAM_ID));
  function token(owner: PublicKey, stock: boolean, amount: bigint, frozen = false) {
    const a = stock ? asset : devnetUsdc;
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({ mint: a.mint, owner, amount, delegateOption: 0, delegate: PublicKey.default,
      state: frozen ? 2 : 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    accounts.set(getAssociatedTokenAddressSync(a.mint, owner, false, a.tokenProgram).toBase58(), info(data, a.tokenProgram));
  }
  token(customer.publicKey, true, 1_000_000n); token(liquidity.publicKey, false, 50_000_000n);
  const state = { valid: true, fee: 15000, sol: 100_000_000 };
  const rpc = {
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null,
    getBalance: async (key: PublicKey) => key.equals(merchant.publicKey) ? state.sol : 0,
    getFeeForMessage: async () => ({ value: state.fee }), getMinimumBalanceForRentExemption: async () => 2_000_000,
    getLatestBlockhash: async () => latest, isBlockhashValid: async () => ({ context: { slot: 1 }, value: state.valid }),
    getBlockHeight: async () => 201, getSignaturesForAddress: async () => [],
  } as unknown as Connection;
  const tx = buildDemoExchange(request, customer.publicKey, latest);
  tx.partialSign(customer);
  const exchange = exchangeFromTransaction(request, customer.publicKey, tx, latest.lastValidBlockHeight);
  const full = () => {
    const signed = inspectDemoExchange(exchange); signed.partialSign(merchant, liquidity);
    return exchangeFromTransaction(request, customer.publicKey, signed, latest.lastValidBlockHeight);
  };
  function onchain(value: DemoExchange, failed = false) {
    const tx = inspectDemoExchange(value);
    const signature = bs58.encode(tx.signature!);
    rpc.getSignaturesForAddress = async () => [{ signature, err: failed ? { InstructionError: [3, 'InsufficientFunds'] } : null,
      slot: 1, memo: null, blockTime: 1, confirmationStatus: 'confirmed' }];
    rpc.getTransaction = async () => ({ slot: 1, meta: { err: failed ? { InstructionError: [3, 'InsufficientFunds'] } : null },
      transaction: { message: tx.compileMessage(), signatures: tx.signatures.map((s) => bs58.encode(s.signature!)) } }) as TransactionResponse;
    return signature;
  }
  return { merchant, customer, liquidity, asset, request, latest, accounts, token, state, rpc, exchange, full, onchain };
}

test('demo quote uses scaled raw units, fixed pricing and exact arithmetic without hidden rounding', () => {
  const f = fixture();
  const q = DemoQuoteProvider.quote(f.asset, '5');
  assert.equal(q.fundingAmount, '0.025'); assert.equal(q.fundingRaw, 12500n); assert.equal(q.settlementRaw, 5000000n);
  assert.equal(DemoQuoteProvider.quote(f.asset, '0.0004').fundingRaw, 1n);
  for (const amount of ['0', '-1', '0.000001', '1.000001', 'NaN']) assert.throws(() => DemoQuoteProvider.quote(f.asset, amount));
  assert.throws(() => DemoQuoteProvider.quote(devnetUsdc, '5'));
});

test('atomic exchange binds stock and USDC legs, separate liquidity wallet and merchant gas/rent', async () => {
  const f = fixture(); const p = await prepareDemoExchange(f.request, f.customer.publicKey, f.rpc);
  assert.equal(p.transaction.instructions.length, 5);
  const stock = decodeTransferCheckedInstruction(p.transaction.instructions[1]!, TOKEN_2022_PROGRAM_ID);
  const usdc = decodeTransferCheckedInstruction(p.transaction.instructions[3]!, TOKEN_PROGRAM_ID);
  assert.equal(stock.data.amount, 12500n); assert.equal(usdc.data.amount, 5000000n);
  assert(stock.keys.owner.pubkey.equals(f.customer.publicKey)); assert(usdc.keys.owner.pubkey.equals(f.liquidity.publicKey));
  assert(p.transaction.feePayer!.equals(f.merchant.publicKey));
  assert(p.transaction.instructions[0]!.keys[0]!.pubkey.equals(f.merchant.publicKey));
  assert(p.transaction.instructions[2]!.keys[0]!.pubkey.equals(f.merchant.publicKey));
  assert.equal(p.costs.accountRent, 4000000); assert.equal(p.costs.networkFee, 15000);
  assert.equal(p.transaction.compileMessage().header.numRequiredSignatures, 3);
  assert(inspectDemoExchange(f.full()).serialize().length <= 1232);
  assert.throws(() => createDemoRequest(f.merchant.publicKey, f.merchant.publicKey.toBase58(), f.asset.mint.toBase58(), '5'));
  assert.throws(() => buildDemoExchange(f.request, f.liquidity.publicKey, f.latest));
});

test('liquidity shortage, frozen accounts, unsupported mint and merchant fee shortage block authorization', async () => {
  const f = fixture();
  f.token(f.liquidity.publicKey, false, 0n);
  await assert.rejects(reviewDemoExchange(f.exchange, f.rpc), /liquidity wallet needs/);
  f.token(f.liquidity.publicKey, false, 50_000_000n, true);
  await assert.rejects(reviewDemoExchange(f.exchange, f.rpc), /frozen/);
  f.token(f.liquidity.publicKey, false, 50_000_000n); f.state.sol = 0;
  await assert.rejects(reviewDemoExchange(f.exchange, f.rpc), /Fee payer/);
  f.state.sol = 100_000_000; f.state.fee = 20001;
  await assert.rejects(reviewDemoExchange(f.exchange, f.rpc), /cap/);
  f.state.fee = 15000; f.state.valid = false;
  await assert.rejects(reviewDemoExchange(f.exchange, f.rpc), /expired/);
  f.state.valid = true; f.accounts.get(f.asset.mint.toBase58())!.data[44] = 9;
  await assert.rejects(reviewDemoExchange(f.exchange, f.rpc));
});

test('untrusted exchanges reject modified price, receiver, liquidity wallet, mint, nonce, fee payer and extra instructions', () => {
  const f = fixture();
  for (const changes of [{ settlementAmount: '6' }, { receiver: Keypair.generate().publicKey.toBase58() },
    { nonce: 'a'.repeat(32) }, { networkFeePolicy: 'PAYER' as const, accountRentPolicy: 'PAYER' as const }]) {
    assert.throws(() => inspectDemoExchange({ ...f.exchange, request: { ...f.request, intent: { ...f.request.intent, ...changes } } }));
  }
  for (const changes of [{ liquidity: Keypair.generate().publicKey.toBase58() }, { fundingMint: Keypair.generate().publicKey.toBase58() }]) {
    assert.throws(() => inspectDemoExchange({ ...f.exchange, request: { ...f.request, ...changes } }));
  }
  const tx = inspectDemoExchange(f.exchange); tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999999 })); tx.partialSign(f.customer);
  assert.throws(() => inspectDemoExchange({ ...f.exchange, transaction: tx.serialize({ requireAllSignatures: false }).toString('base64') }));
  assert.throws(() => validateDemoRequest({ ...f.request, intent: { ...f.request.intent, expiresAt: 0 } }));
});

test('three wallets preserve partial signatures and changed messages cannot merge', async () => {
  const f = fixture();
  const wallet: Parameters<typeof signCheckoutTransaction>[0] = { authorize: async () => ({ accounts: [{ address: f.merchant.publicKey.toBuffer().toString('base64') }], auth_token: 'test', wallet_uri_base: 'https://wallet.example' }),
    signTransactions: async ({ transactions }) => { assert(transactions[0] instanceof Transaction); transactions[0].partialSign(f.merchant); return transactions; } };
  const tx = await signCheckoutTransaction(wallet as Parameters<typeof signCheckoutTransaction>[0], { address: f.merchant.publicKey, authToken: 'test' }, inspectDemoExchange(f.exchange), () => {});
  const merchantSigned = exchangeFromTransaction(f.request, f.customer.publicKey, tx, f.latest.lastValidBlockHeight);
  const other = inspectDemoExchange(f.exchange); other.partialSign(f.liquidity);
  const merged = mergeDemoExchange(merchantSigned, exchangeFromTransaction(f.request, f.customer.publicKey, other, f.latest.lastValidBlockHeight));
  assert(inspectDemoExchange(merged).verifySignatures());
  const changed = buildDemoExchange(f.request, f.customer.publicKey, { ...f.latest, blockhash: Keypair.generate().publicKey.toBase58() }); changed.partialSign(f.customer);
  assert.throws(() => mergeDemoExchange(merchantSigned, exchangeFromTransaction(f.request, f.customer.publicKey, changed, f.latest.lastValidBlockHeight)));
});

test('multi-part QR survives out-of-order duplicate scans, rejects mixing and round-trips signed bytes', () => {
  const f = fixture(); const record = { request: f.request, exchange: f.full() };
  const text = encodeDemoRecord(record); const frames = settlementFrames(text);
  assert.equal(phoneTapPayload(text), text);
  assert(frames.length > 1 && frames.length <= 7);
  for (const frame of frames) assert(createQr(frame, { errorCorrectionLevel: 'M' }).modules.size > 0);
  const collector = new SettlementCollector();
  collector.accept(frames[0]!); collector.accept(frames[0]!);
  assert.throws(() => collector.accept(settlementFrames(text)[1]!), /another exchange/);
  let assembled: string | undefined;
  for (const frame of frames.slice(1).reverse()) assembled = collector.accept(frame).text;
  assert.equal(assembled, text); assert.deepEqual(decodeDemoText(assembled!), record);
  assert.throws(() => decodeDemoRecord({ ...record, request: { ...record.request, liquidity: Keypair.generate().publicKey.toBase58() } }));
  assert.throws(() => collector.accept('x'.repeat(7001)));
});

test('broadcast requires every signature and durable save; timeout preserves the exact transaction identity', async () => {
  const f = fixture(); let saved = false, sent = false;
  f.rpc.sendRawTransaction = async (raw) => { sent = true; assert(saved); return bs58.encode(Transaction.from(raw).signature!); };
  await assert.rejects(broadcastDemoExchange(f.exchange, async () => {}, f.rpc)); assert(!sent);
  await assert.rejects(broadcastDemoExchange(f.full(), async () => { throw new Error('disk full'); }, f.rpc), /disk full/); assert(!sent);
  const signature = await broadcastDemoExchange(f.full(), async () => { saved = true; }, f.rpc); assert(sent && signature);
  f.rpc.sendRawTransaction = async () => { assert(saved); throw new Error('timeout'); };
  await assert.rejects(broadcastDemoExchange(f.full(), async (record) => { assert(record.exchange); saved = true; }, f.rpc), /timeout/);
});

test('merchant and both signers confirm only the exact complete two-leg transaction', async () => {
  const f = fixture(); const full = f.full(); const signature = f.onchain(full);
  assert.deepEqual(await observeDemoSettlement({ request: f.request }, f.rpc), { state: 'confirmed', signature });
  assert.deepEqual(await observeDemoSettlement({ request: f.request, exchange: f.exchange }, f.rpc), { state: 'confirmed', signature });
  await assert.rejects(prepareDemoExchange(f.request, f.customer.publicKey, f.rpc), /already paid/);
  const changed = inspectDemoExchange(full); changed.instructions.splice(1, 1); changed.signatures = []; changed.partialSign(f.merchant, f.liquidity);
  f.rpc.getTransaction = async () => ({ slot: 1, meta: { err: null }, transaction: { message: changed.compileMessage(), signatures: changed.signatures.map((s) => bs58.encode(s.signature!)) } }) as TransactionResponse;
  assert.equal((await observeDemoSettlement({ request: f.request }, f.rpc)).state, 'pending');
});

test('chain failure is never Paid and signed recovery requires finalized expiry plus complete history', async () => {
  const f = fixture(); const full = f.full(); f.onchain(full, true);
  assert.equal((await observeDemoSettlement({ request: f.request, exchange: f.exchange }, f.rpc)).state, 'failed');
  assert.equal((await observeDemoSettlement({ request: f.request }, f.rpc)).state, 'pending');
  f.rpc.getTransaction = async () => null;
  await assert.rejects(observeDemoSettlement({ request: f.request, exchange: f.exchange }, f.rpc), /incomplete/);
  f.rpc.getSignaturesForAddress = async () => [];
  assert.equal((await observeDemoSettlement({ request: f.request, exchange: f.exchange }, f.rpc)).state, 'pending');
  f.state.valid = false;
  assert.equal((await observeDemoSettlement({ request: f.request, exchange: f.exchange }, f.rpc)).state, 'expired');
});
