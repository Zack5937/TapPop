import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  AccountLayout, MintLayout, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { parseAssetAmount, formatAssetAmount, formatUnits } from '../src/amount';
import { devnetUsdc, getConfiguredAsset } from '../src/config';
import { checkSettlement, matchesPayment, prepareTransfer, readBalances, recipientKey, transferInstructions, verifyNetwork, type PendingPayment } from '../src/payments';
import { decodePending } from '../src/pending';
import type { Asset } from '../src/assets';

const parseAmount = (value: string) => parseAssetAmount(value, devnetUsdc);

// Captured from https://api.devnet.solana.com getGenesisHash. Keep independent
// of application configuration so an incorrect network pin cannot pass tests.
const devnetGenesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// Public addresses only; no signing keys are used by these tests.
const sender = devnetUsdc.mint;
const receiver = new PublicKey('So11111111111111111111111111111111111111112');
const payment: PendingPayment = {
  mint: devnetUsdc.mint.toBase58(), tokenProgram: devnetUsdc.tokenProgram.toBase58(),
  signature: bs58.encode(new Uint8Array(64).fill(7)),
  sender: sender.toBase58(), receiver: receiver.toBase58(), amount: '1',
  blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100,
};

function fakeRpc(options: {
  sol?: number; usdc?: bigint; missing?: boolean; decimals?: number; network?: string;
  sourceState?: 0 | 1 | 2;
  destination?: { state?: 0 | 1 | 2; owner?: PublicKey; mint?: PublicKey; program?: PublicKey };
} = {}) {
  const tokenData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint: devnetUsdc.mint, owner: sender, amount: options.usdc ?? 5_000_000n,
    delegateOption: 0, delegate: PublicKey.default, state: options.sourceState ?? 1,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, tokenData);
  const destinationData = Buffer.from(tokenData);
  AccountLayout.encode({
    ...AccountLayout.decode(tokenData),
    owner: options.destination?.owner ?? receiver,
    mint: options.destination?.mint ?? devnetUsdc.mint,
    state: options.destination?.state ?? 1,
    amount: 0n,
  }, destinationData);
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 100_000_000n,
    decimals: options.decimals ?? 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
  }, mintData);
  return {
    getGenesisHash: async () => options.network ?? devnetGenesisHash,
    getBalance: async () => options.sol ?? 1_000_000_000,
    getAccountInfo: async (key: PublicKey) => {
      if (options.destination && key.equals(getAssociatedTokenAddressSync(devnetUsdc.mint, receiver))) {
        return { data: destinationData, owner: options.destination.program ?? TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 };
      }
      const data = key.equals(devnetUsdc.mint) ? mintData
        : key.equals(getAssociatedTokenAddressSync(devnetUsdc.mint, sender)) && !options.missing ? tokenData : null;
      return data ? { data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 } : null;
    },
    getLatestBlockhash: async () => ({ blockhash: payment.blockhash, lastValidBlockHeight: 100 }),
    getFeeForMessage: async () => ({ value: 5000 }),
    getMinimumBalanceForRentExemption: async () => 2_039_280,
  } as unknown as Connection;
}

function parsedTx(): ParsedTransactionWithMeta {
  return {
    meta: { err: null },
    transaction: {
      signatures: [payment.signature],
      message: {
        accountKeys: [{ pubkey: sender, signer: true, writable: true }],
        instructions: [{ programId: TOKEN_PROGRAM_ID, program: 'spl-token', parsed: {
          type: 'transferChecked', info: {
            mint: devnetUsdc.mint.toBase58(), authority: payment.sender,
            source: getAssociatedTokenAddressSync(devnetUsdc.mint, sender).toBase58(),
            destination: getAssociatedTokenAddressSync(devnetUsdc.mint, receiver).toBase58(),
            tokenAmount: { amount: '1000000', decimals: 6 },
          },
        } }],
      },
    },
  } as ParsedTransactionWithMeta;
}

test('USDC conversion is exact at six decimals and u64 boundaries', () => {
  assert.equal(parseAmount('0.000001'), 1n);
  assert.equal(parseAmount('1.100001'), 1_100_001n);
  assert.equal(parseAmount('18446744073709.551615'), (1n << 64n) - 1n);
  assert.equal(formatUnits(parseAmount('5.120000'), 6), '5.12');
  for (const input of ['0', '-1', '1e3', '1.0000001', 'NaN', 'Infinity', ' 1', '01', '1,2', '', '18446744073709.551616']) {
    assert.throws(() => parseAmount(input), Error, input);
  }
});

test('amount conversion uses the asset precision, including zero decimals', () => {
  const integerAsset: Asset = { ...devnetUsdc, decimals: 0 };
  assert.equal(parseAssetAmount('12', integerAsset), 12n);
  assert.equal(formatAssetAmount(12n, integerAsset), '12');
  assert.throws(() => parseAssetAmount('1.1', integerAsset));
  const preciseAsset: Asset = { ...devnetUsdc, decimals: 9 };
  assert.equal(parseAssetAmount('1.000000001', preciseAsset), 1_000_000_001n);
  assert.equal(formatAssetAmount(1_000_000_001n, preciseAsset), '1.000000001');
});

test('unknown display extensions cannot silently use decimal formatting', () => {
  const unsupported = { ...devnetUsdc, display: { kind: 'unsupported-extension' } } as unknown as Asset;
  assert.throws(() => parseAssetAmount('1', unsupported), /unsupported amount display/);
  assert.throws(() => formatAssetAmount(1_000_000n, unsupported), /unsupported amount display/);
});

test('unconfigured mints, token programs and asset metadata are rejected', async () => {
  assert.throws(() => getConfiguredAsset(receiver.toBase58(), devnetUsdc.tokenProgram.toBase58()), /Unsupported asset/);
  assert.throws(() => transferInstructions(sender, receiver, 1n, { ...devnetUsdc, tokenProgram: PublicKey.default }), /Unsupported asset/);
  assert.throws(() => transferInstructions(sender, receiver, 1n, { ...devnetUsdc, decimals: 9 }), /metadata/);
  await assert.rejects(readBalances(sender, fakeRpc(), { ...devnetUsdc, mint: receiver }), /Unsupported asset/);
});

test('legacy USDC pending records migrate, while partial or unknown asset data fails closed', () => {
  const { mint, tokenProgram, ...legacy } = payment;
  assert.deepEqual(decodePending(JSON.stringify(legacy)), payment);
  assert.throws(() => decodePending(JSON.stringify({ ...legacy, mint })), /Invalid saved payment asset/);
  assert.throws(() => decodePending(JSON.stringify({ ...payment, tokenProgram: receiver.toBase58() })), /Unsupported asset/);
  assert.throws(() => decodePending(JSON.stringify({ ...payment, mint: receiver.toBase58(), tokenProgram })), /Unsupported asset/);
});

test('recipient rejects malformed, self, system and off-curve addresses', () => {
  assert.equal(recipientKey(receiver.toBase58(), sender).toBase58(), receiver.toBase58());
  assert.throws(() => recipientKey('bad'));
  assert.throws(() => recipientKey(sender.toBase58(), sender));
  assert.throws(() => recipientKey(PublicKey.default.toBase58()));
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('test')], TOKEN_PROGRAM_ID);
  assert.throws(() => recipientKey(pda.toBase58()));
});

test('instructions create receiver ATA idempotently and transfer only configured USDC', () => {
  const instructions = transferInstructions(sender, receiver, 1_000_000n);
  assert.equal(instructions.length, 2);
  assert(instructions[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.equal(instructions[0]!.data[0], 1);
  const decoded = decodeTransferCheckedInstruction(instructions[1]!);
  assert(decoded.programId.equals(TOKEN_PROGRAM_ID));
  assert(decoded.keys.mint.pubkey.equals(devnetUsdc.mint));
  assert(decoded.keys.owner.pubkey.equals(sender));
  assert(decoded.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(devnetUsdc.mint, receiver)));
  assert.equal(decoded.data.amount, 1_000_000n);
  assert.equal(decoded.data.decimals, 6);
});

test('balances support missing ATA without masking RPC errors', async () => {
  assert.deepEqual(await readBalances(sender, fakeRpc()), { sol: 1_000_000_000n, token: 5_000_000n });
  assert.equal((await readBalances(sender, fakeRpc({ missing: true }))).token, 0n);
  const rpc = fakeRpc();
  rpc.getAccountInfo = async () => { throw new Error('RPC offline'); };
  await assert.rejects(readBalances(sender, rpc), /RPC offline/);
});

test('full Devnet genesis hash is accepted and truncated or other networks are rejected', async () => {
  await verifyNetwork(fakeRpc());
  for (const network of [
    'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    '',
  ]) {
    await assert.rejects(verifyNetwork(fakeRpc({ network })), /not Solana Devnet/);
  }
});

test('wrong network is rejected before constructing a transfer', async () => {
  await assert.rejects(verifyNetwork(fakeRpc({ network: 'mainnet' })), /not Solana Devnet/);
  await assert.rejects(prepareTransfer(sender, payment.receiver, '1', fakeRpc({ network: 'mainnet' })), /not Solana Devnet/);
});

test('transaction preflight checks USDC, SOL rent and mint precision', async () => {
  const result = await prepareTransfer(sender, payment.receiver, '1', fakeRpc());
  assert(result.transaction.feePayer?.equals(sender));
  assert.equal(result.transaction.instructions.length, 2);
  assert.equal(result.transaction.recentBlockhash, payment.blockhash);
  assert(result.transaction.serialize({ requireAllSignatures: false }).length < 1232);
  await assert.rejects(prepareTransfer(sender, payment.receiver, '6', fakeRpc()), /Not enough Devnet USDC/);
  await assert.rejects(prepareTransfer(sender, payment.receiver, '1', fakeRpc({ sol: 5000 })), /Not enough Devnet SOL/);
  await assert.rejects(prepareTransfer(sender, payment.receiver, '1', fakeRpc({ decimals: 9 })), /mint configuration/);
});

test('frozen source and destination accounts fail before requesting a signing blockhash', async () => {
  for (const options of [{ sourceState: 2 as const }, { destination: { state: 2 as const } }]) {
    const rpc = fakeRpc(options);
    rpc.getLatestBlockhash = async () => { assert.fail('must not build a frozen-account payment'); };
    await assert.rejects(prepareTransfer(sender, payment.receiver, '1', rpc), /account is frozen/);
  }
  // A frozen balance is still readable; only sending is blocked.
  assert.equal((await readBalances(sender, fakeRpc({ sourceState: 2 }))).token, 5_000_000n);
});

test('malformed destination identity or program never reaches wallet signing', async () => {
  for (const destination of [{ owner: sender }, { mint: receiver }, { state: 0 as const }, { program: PublicKey.default }]) {
    const rpc = fakeRpc({ destination });
    let blockhashRequests = 0;
    rpc.getLatestBlockhash = async () => {
      blockhashRequests++;
      return { blockhash: payment.blockhash, lastValidBlockHeight: 100 };
    };
    await assert.rejects(prepareTransfer(sender, payment.receiver, '1', rpc), /token account/);
    assert.equal(blockhashRequests, 0);
  }
  await assert.rejects(readBalances(sender, fakeRpc({ sourceState: 0 })), /uninitialized/);
});

test('an existing receiving account requires only the fee, not additional account rent', async () => {
  const rpc = fakeRpc({ sol: 5000, destination: {} });
  rpc.getMinimumBalanceForRentExemption = async () => { assert.fail('existing ATA does not require rent'); };
  const result = await prepareTransfer(sender, payment.receiver, '1', rpc);
  assert.equal(result.transaction.instructions.length, 2);
});

test('saved payment is validated as untrusted data', () => {
  assert.deepEqual(decodePending(JSON.stringify(payment)), payment);
  for (const bad of [null, {}, { ...payment, signature: 'bad' }, { ...payment, amount: '-1' }, { ...payment, lastValidBlockHeight: '100' }]) {
    assert.throws(() => decodePending(JSON.stringify(bad)));
  }
});

test('onchain receipt must match sender, recipient, mint and amount', () => {
  assert(matchesPayment(parsedTx(), payment));
  assert(!matchesPayment(parsedTx(), { ...payment, amount: '2' }));
  assert(!matchesPayment(parsedTx(), { ...payment, receiver: sender.toBase58() }));
  const tx = parsedTx();
  tx.transaction.message.instructions[0]!.programId = PublicKey.default;
  assert(!matchesPayment(tx, payment));
});

test('submitted or processed is not Paid; confirmed success requires a matching receipt', async () => {
  const rpc = fakeRpc();
  rpc.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'processed' }] });
  assert.equal(await checkSettlement(payment, rpc), 'pending');
  rpc.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
  rpc.getParsedTransaction = async () => null;
  assert.equal(await checkSettlement(payment, rpc), 'pending');
  rpc.getParsedTransaction = async () => parsedTx();
  assert.equal(await checkSettlement(payment, rpc), 'confirmed');
  await assert.rejects(checkSettlement({ ...payment, amount: '2' }, rpc), /does not match/);
  rpc.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: { InstructionError: [1, 'InsufficientFunds'] }, confirmationStatus: 'confirmed' }] });
  assert.equal(await checkSettlement(payment, rpc), 'failed');
});

test('unknown transfer remains blocked until finalized expiry and history recheck', async () => {
  const rpc = fakeRpc();
  let reads = 0;
  rpc.getSignatureStatuses = async () => { reads++; return { context: { slot: 1 }, value: [null] }; };
  rpc.isBlockhashValid = async () => ({ context: { slot: 1 }, value: false });
  rpc.getBlockHeight = async () => 100;
  assert.equal(await checkSettlement(payment, rpc), 'pending');
  rpc.getBlockHeight = async (commitment) => { assert.equal(commitment, 'finalized'); return 101; };
  assert.equal(await checkSettlement(payment, rpc), 'expired');
  assert.equal(reads, 3);
  rpc.getSignatureStatuses = async () => { throw new Error('timeout'); };
  await assert.rejects(checkSettlement(payment, rpc), /timeout/);
});
