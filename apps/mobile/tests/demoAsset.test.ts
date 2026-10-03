import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey, SystemInstruction, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  AccountLayout, MintLayout, ExtensionType, ScaledUiAmountConfigLayout, getMintLen,
  getAccountLen, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction, decodeMintToCheckedInstruction, decodeSetAuthorityInstruction,
  initializeScaledUiAmountConfigInstructionData, getMint,
} from '@solana/spl-token';
import { prepareDemoCreation, readDemoMint, validateDemoMint, DEMO_RAW_SUPPLY } from '../src/demoAsset';
import { registerDemoMint } from '../src/config';
import { formatAssetAmount, parseAssetAmount } from '../src/amount';
import { readBalances, prepareTransfer, matchesPayment, type PendingPayment } from '../src/payments';
import { decodePending } from '../src/pending';
import { signDemoCreation } from '../src/signing';
import bs58 from 'bs58';

const owner = Keypair.generate(); // Test only; never funded or persisted.
const receiver = Keypair.generate().publicKey;
const asset = registerDemoMint(Keypair.generate().publicKey.toBase58());
function fixture() {
  const tlv = Buffer.alloc(4 + ScaledUiAmountConfigLayout.span);
  tlv.writeUInt16LE(ExtensionType.ScaledUiAmountConfig, 0);
  tlv.writeUInt16LE(ScaledUiAmountConfigLayout.span, 2);
  ScaledUiAmountConfigLayout.encode({ authority: PublicKey.default, multiplier: 2,
    newMultiplier: 2, newMultiplierEffectiveTimestamp: 0n }, tlv.subarray(4));
  const mintData = Buffer.alloc(getMintLen([ExtensionType.ScaledUiAmountConfig]));
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: DEMO_RAW_SUPPLY,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  mintData[165] = 1;
  tlv.copy(mintData, 166);
  const tokenData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: asset.mint, owner: owner.publicKey, amount: DEMO_RAW_SUPPLY,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, tokenData);
  const info = (data: Buffer) => ({ data, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1_000_000, rentEpoch: 0 });
  const rpc = {
    getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getAccountInfo: async (key: PublicKey) => key.equals(asset.mint) ? info(mintData)
      : key.equals(getAssociatedTokenAddressSync(asset.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID)) ? info(tokenData) : null,
    getBalance: async () => 1_000_000_000,
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }),
    getMinimumBalanceForRentExemption: async () => 2_000_000,
    getFeeForMessage: async () => ({ value: 5000 }),
  } as unknown as Connection;
  return { rpc, mintData, tokenData };
}

test('scaled display and transfer use raw units, rejecting rounding and unsupported multipliers', () => {
  assert.equal(formatAssetAmount(500_000n, asset), '1');
  assert.equal(parseAssetAmount('1', asset), 500_000n);
  assert.equal(formatAssetAmount(1n, asset), '0.000002');
  assert.equal(formatAssetAmount(DEMO_RAW_SUPPLY, asset), '1000');
  assert.throws(() => parseAssetAmount('0.000001', asset), /transferable/);
  assert.throws(() => parseAssetAmount('1.000001', asset), /transferable/);
  assert.throws(() => parseAssetAmount('0', asset), /range/);
  assert.throws(() => parseAssetAmount('1e3', asset));
  assert.throws(() => formatAssetAmount(1n, { ...asset, display: { kind: 'scaled', multiplier: 3 } } as unknown as typeof asset));
});

test('only immutable ×2 mints without additional extensions or authorities pass', async () => {
  const { rpc } = fixture();
  const mint = await getMint(rpc, asset.mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  validateDemoMint(mint);
  for (const changed of [{ decimals: 9 }, { mintAuthority: owner.publicKey }, { freezeAuthority: owner.publicKey }, { tlvData: Buffer.alloc(0) }]) {
    assert.throws(() => validateDemoMint({ ...mint, ...changed }));
  }
  for (const changed of [{ multiplier: 1 }, { newMultiplier: 3 }, { authority: owner.publicKey }]) {
    const tlvData = Buffer.from(mint.tlvData);
    ScaledUiAmountConfigLayout.encode({ authority: PublicKey.default, multiplier: 2,
      newMultiplier: 2, newMultiplierEffectiveTimestamp: 0n, ...changed }, tlvData.subarray(4));
    assert.throws(() => validateDemoMint({ ...mint, tlvData }));
  }
  const extra = Buffer.alloc(4);
  extra.writeUInt16LE(ExtensionType.NonTransferable);
  assert.throws(() => validateDemoMint({ ...mint, tlvData: Buffer.concat([mint.tlvData, extra]) }));
});

test('Token-2022 balances, ATA rent and transfer instructions retain correct program and raw amount', async () => {
  const { rpc } = fixture();
  assert.equal((await readBalances(owner.publicKey, rpc, asset)).token, DEMO_RAW_SUPPLY);
  rpc.getMinimumBalanceForRentExemption = async (space) => {
    assert.equal(space, getAccountLen([ExtensionType.ImmutableOwner])); return 2_000_000;
  };
  const { transaction } = await prepareTransfer(owner.publicKey, receiver.toBase58(), '1', rpc, asset);
  const transfer = decodeTransferCheckedInstruction(transaction.instructions[1]!, TOKEN_2022_PROGRAM_ID);
  assert.equal(transfer.data.amount, 500_000n);
  assert(transfer.keys.mint.pubkey.equals(asset.mint));
  const payment: PendingPayment = { mint: asset.mint.toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    signature: bs58.encode(Buffer.alloc(64, 7)), sender: owner.publicKey.toBase58(), receiver: receiver.toBase58(),
    amount: '1', blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 };
  assert.deepEqual(decodePending(JSON.stringify(payment)), payment);
  const tx = { meta: { err: null }, transaction: { signatures: [payment.signature], message: {
    accountKeys: [{ pubkey: owner.publicKey, signer: true, writable: true }], instructions: [{
      programId: TOKEN_2022_PROGRAM_ID, parsed: { type: 'transferChecked', info: {
        mint: payment.mint, authority: payment.sender, source: transfer.keys.source.pubkey.toBase58(),
        destination: transfer.keys.destination.pubkey.toBase58(), tokenAmount: { amount: '500000', decimals: 6 },
      } },
    }],
  } } } as unknown as ParsedTransactionWithMeta;
  assert(matchesPayment(tx, payment));
  assert(!matchesPayment(tx, { ...payment, amount: '2' }));
  tx.transaction.message.instructions[0]!.programId = TOKEN_PROGRAM_ID;
  assert(!matchesPayment(tx, payment));
});

test('creation atomically initializes scaling, mints fixed supply and revokes mint authority with wallet as sole signer', async () => {
  const { rpc } = fixture();
  const first = await prepareDemoCreation(owner.publicKey, rpc);
  const second = await prepareDemoCreation(owner.publicKey, rpc);
  assert(first.mint.equals(second.mint));
  const tx = first.transaction!;
  assert.equal(tx.instructions.length, 6);
  const create = SystemInstruction.decodeCreateWithSeed(tx.instructions[0]!);
  assert(create.basePubkey.equals(owner.publicKey));
  assert(create.programId.equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(create.space, getMintLen([ExtensionType.ScaledUiAmountConfig]));
  const scaled = initializeScaledUiAmountConfigInstructionData.decode(tx.instructions[1]!.data);
  assert.equal(scaled.multiplier, 2);
  assert(scaled.authority!.equals(PublicKey.default));
  assert.equal(decodeMintToCheckedInstruction(tx.instructions[4]!, TOKEN_2022_PROGRAM_ID).data.amount, DEMO_RAW_SUPPLY);
  assert.equal(decodeSetAuthorityInstruction(tx.instructions[5]!, TOKEN_2022_PROGRAM_ID).data.newAuthority, null);
  assert.equal(tx.compileMessage().header.numRequiredSignatures, 1);
  tx.partialSign(owner);
  assert(tx.serialize().length <= 1232);
  rpc.getBalance = async () => 0;
  await assert.rejects(prepareDemoCreation(owner.publicKey, rpc), /Not enough Devnet SOL/);
});

test('existing deterministic demo mint is recovered without creating another supply', async () => {
  const { rpc, mintData } = fixture();
  rpc.getAccountInfo = async () => ({ data: mintData, owner: TOKEN_2022_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 });
  assert.equal((await prepareDemoCreation(owner.publicKey, rpc)).transaction, null);
});

test('demo creation rejects changed wallet accounts and signed transaction mutation', async () => {
  const { rpc } = fixture();
  const session = { address: owner.publicKey, authToken: 'test' };
  const wallet = {
    authorize: async () => ({ accounts: [{ address: owner.publicKey.toBuffer().toString('base64') }], auth_token: 'test', wallet_uri_base: 'https://wallet.example' }),
    signTransactions: async ({ transactions }: { transactions: import('@solana/web3.js').Transaction[] }) => {
      transactions[0]!.partialSign(owner); return transactions;
    },
  };
  const tx = (await prepareDemoCreation(owner.publicKey, rpc)).transaction!;
  // Use the SDK wallet signature type; this test wallet only handles legacy transactions.
  const typedWallet = wallet as Parameters<typeof signDemoCreation>[0];
  assert((await signDemoCreation(typedWallet, session, tx, () => {})).length > 0);
  wallet.signTransactions = async ({ transactions }) => {
    transactions[0]!.instructions.pop(); transactions[0]!.partialSign(owner); return transactions;
  };
  await assert.rejects(signDemoCreation(typedWallet, session, (await prepareDemoCreation(owner.publicKey, rpc)).transaction!, () => {}), /changed the demo/);
  wallet.authorize = async () => ({ accounts: [{ address: receiver.toBuffer().toString('base64') }], auth_token: 'test', wallet_uri_base: 'https://wallet.example' });
  await assert.rejects(signDemoCreation(typedWallet, session, tx, () => {}), /account changed/);
});


test('unconfirmed or wrong-program demo mints show an actionable error and RPC errors propagate', async () => {
  const { rpc, mintData } = fixture();
  rpc.getAccountInfo = async () => null;
  await assert.rejects(readDemoMint(asset.mint, rpc), /wait for confirmation/);
  rpc.getAccountInfo = async () => ({ data: mintData, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 });
  await assert.rejects(readDemoMint(asset.mint, rpc), /valid Token-2022 mint/);
  rpc.getAccountInfo = async () => { throw new Error('RPC timed out'); };
  await assert.rejects(readDemoMint(asset.mint, rpc), /RPC timed out/);
});

test('scaled Token-2022 receive requests sponsor the fee without changing raw transfer units', async () => {
  const { createIntent } = await import('../src/paymentIntent');
  const { prepareRequestPayment } = await import('../src/checkout');
  const { rpc } = fixture();
  rpc.getSignaturesForAddress = async () => [];
  const intent = createIntent(receiver, asset, '1');
  const result = await prepareRequestPayment(intent, owner.publicKey, asset.mint.toBase58(), rpc);
  assert(result.transaction.feePayer!.equals(receiver));
  const transfer = decodeTransferCheckedInstruction(result.transaction.instructions[1]!, TOKEN_2022_PROGRAM_ID);
  assert.equal(transfer.data.amount, 500_000n);
  assert(transfer.keys.owner.pubkey.equals(owner.publicKey));
});
