import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { Buffer } from 'buffer';
import { Keypair, PublicKey, Transaction, type AccountInfo, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, MintLayout, MINT_SIZE, ACCOUNT_SIZE } from '@solana/spl-token';
import { config, devnetUsdc, registerDemoMint } from '../src/config';
import { CLAIM_SIZE, PACKET_SIZE, ORACLE_REQUEST_SIZE, ORACLE_PROGRAM, UNDEPLOYED_PACKET_PROGRAM,
  decodePacket, decodeClaim, decodeOracle, decodeOracleConfig, requestSeed, packetProgram, packetLink, parsePacketLink } from '../src/redPacketCodec';
import { createPacketInstruction, claimPacketInstruction, reservePacketInstruction, settlePacketInstruction, refundPacketInstruction,
  validatePacketInput, verifyPacketProgram, preparePacket, type PacketView, type PreparedPacket } from '../src/redPacket';
import { checkPacketPending, packetPendingFromSigned, decodePacketPending, decodeSavedPacket, submitPacket } from '../src/redPacketPending';

// Generated from Anchor itself by programs/red-packet/examples/mobile_abi.rs.
const abi = JSON.parse(readFileSync(new NodeURL('./fixtures/red-packet-abi.json', import.meta.url), 'utf8'));
const program = new PublicKey(abi.program);
const address = new PublicKey(abi.packetAddress);
const actor = new PublicKey(abi.creator);
const claimant = new PublicKey(abi.claimant);
const asset = registerDemoMint(abi.mint);
function info(hex: string, owner = program): AccountInfo<Buffer> {
  return { data: Buffer.from(hex, 'hex'), owner, executable: false, lamports: 10_000_000, rentEpoch: 0 };
}
function fixtureView(): PacketView {
  return { packet: decodePacket(address, info(abi.packet), program),
    pending: decodeClaim(new PublicKey(abi.claimAddress), info(abi.claim), program, address),
    asset, ownClaim: null, fulfilled: true, now: 1_800_000_000 };
}
function matches(instruction: TransactionInstruction, expected: { data: string; keys: string[] }) {
  assert.equal(instruction.data.toString('hex'), expected.data);
  assert.deepEqual(instruction.keys.map((k) => `${k.pubkey}:${k.isWritable}:${k.isSigner}`), expected.keys);
}
test('mobile instruction encoding and all account roles match Anchor-generated fixtures', () => {
  const view = fixtureView();
  const create = createPacketInstruction(program, actor, Buffer.alloc(32, 7), { asset, mode: 1, amount: '1', count: 5, hours: 24 }, 1_900_000_000);
  assert(create.packet.equals(address));
  matches(create.instruction, abi.create);
  matches(claimPacketInstruction(program, claimant, view), abi.claimInstruction);
  matches(reservePacketInstruction(program, claimant, address, Buffer.alloc(32, 8), actor, 10_000_000n).instruction, abi.reserve);
  matches(settlePacketInstruction(program, actor, view), abi.settle);
  matches(refundPacketInstruction(program, actor, view), abi.refund);
  const refund = refundPacketInstruction(program, actor, { ...view, pending: null });
  assert(refund.keys[2]!.pubkey.equals(program) && !refund.keys[2]!.isWritable);
  assert(refund.keys[3]!.pubkey.equals(program));
});
test('mobile decoders read Rust account bytes, VRF seed and account rents without float amounts', () => {
  const view = fixtureView();
  assert.equal(Buffer.from(abi.packet, 'hex').length, PACKET_SIZE);
  assert.equal(Buffer.from(abi.claim, 'hex').length, CLAIM_SIZE);
  assert.equal(ORACLE_REQUEST_SIZE, abi.oracleRequestSize);
  assert.equal(view.packet.total, 500_000n);
  assert.equal(view.packet.remaining, 400_000n);
  assert(view.packet.tokenProgram.equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(requestSeed(address, claimant, Buffer.alloc(32, 8)).toString('hex'), abi.seed);
  assert(decodeOracle(new PublicKey(abi.oracleAddress), info(abi.oracle, ORACLE_PROGRAM), view.pending!));
  assert.deepEqual(decodeOracleConfig(info(abi.network, ORACLE_PROGRAM)), { treasury: actor, fee: 10_000_000n });
});
test('packet input conserves raw units for USDC and scaled tokens and rejects rounding/count/expiry errors', () => {
  assert.equal(validatePacketInput({ asset, mode: 0, amount: '1', count: 5, hours: 24 }), 500_000n);
  assert.equal(validatePacketInput({ asset: devnetUsdc, mode: 0, amount: '1', count: 5, hours: 24 }), 1_000_000n);
  for (const update of [{ count: 3 }, { count: 0 }, { count: 1001 }, { count: 1.1 }, { amount: '0' },
    { amount: '0.000001' }, { hours: 169 }, { hours: 0 }, { mode: 2 }]) {
    assert.throws(() => validatePacketInput({ asset, mode: 0, amount: '1', count: 5, hours: 24, ...update } as Parameters<typeof validatePacketInput>[0]));
  }
  assert.equal(validatePacketInput({ asset, mode: 1, amount: '1', count: 3, hours: 1 }), 500_000n);
});
test('QR cannot override program/network or smuggle amounts, duplicates or arbitrary URLs', () => {
  const link = packetLink(program, address);
  assert(parsePacketLink(link, program).equals(address));
  for (const text of [link + '&amount=100', link + '&packet=' + address, link.replace('devnet', 'mainnet'),
    link.replace('v=1', 'v=2'), link + '#ignored', 'https://example.com/' + address, link.replace(program.toBase58(), actor.toBase58())]) {
    assert.throws(() => parsePacketLink(text, program));
  }
  assert.throws(() => packetProgram(''));
  assert.throws(() => packetProgram(UNDEPLOYED_PACKET_PROGRAM));
});
test('chain account owner, PDA, discriminator, lengths and state invariants are mandatory', () => {
  assert.throws(() => decodePacket(address, info(abi.packet, actor), program));
  assert.throws(() => decodePacket(actor, info(abi.packet), program));
  for (const offset of [0, 136, 201, 202]) {
    const bad = info(abi.packet); bad.data[offset] = bad.data[offset]! ^ 255;
    assert.throws(() => decodePacket(address, bad, program));
  }
  const bad = info(abi.packet); bad.data.writeBigUInt64LE(500_001n, 145);
  assert.throws(() => decodePacket(address, bad, program));
  assert.throws(() => decodePacket(address, info(abi.packet.slice(2)), program));
  assert.throws(() => decodeClaim(new PublicKey(abi.claimAddress), info(abi.claim), program, actor));
  const claim = fixtureView().pending!;
  assert.throws(() => decodeOracle(new PublicKey(abi.oracleAddress), info(abi.oracle), claim));
  const random = info(abi.oracle, ORACLE_PROGRAM); random.data[9] = 7;
  assert.throws(() => decodeOracle(new PublicKey(abi.oracleAddress), random, claim));
});

function pendingFixture() {
  // Ephemeral, unfunded test-only signer. No key is stored or sent to an RPC.
  const signer = Keypair.generate();
  const deployed = Keypair.generate().publicKey;
  const built = createPacketInstruction(deployed, signer.publicKey, Buffer.alloc(32, 9),
    { asset: devnetUsdc, mode: 0, amount: '1', count: 5, hours: 24 }, 1_900_000_000);
  const transaction = new Transaction({ feePayer: signer.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })
    .add(built.instruction);
  const prepared = { program: deployed, packet: built.packet, actor: signer.publicKey, action: 'create', transaction,
    message: Buffer.from(transaction.serializeMessage()), lastValidBlockHeight: 100 } as PreparedPacket;
  transaction.partialSign(signer);
  const pending = packetPendingFromSigned(prepared, transaction);
  return { pending, signer, prepared, transaction, deployed };
}
test('signed transactions and local records bind packet, action, payer and exact reviewed message', () => {
  const f = pendingFixture();
  assert.deepEqual(decodePacketPending(f.pending), f.pending);
  for (const change of [{ packet: actor.toBase58() }, { actor: actor.toBase58() }, { action: 'claim' },
    { lastValidBlockHeight: -1 }, { signature: 'bad' }, { raw: f.pending.raw.slice(0, -5) }]) {
    assert.throws(() => decodePacketPending({ ...f.pending, ...change }));
  }
  f.transaction.instructions[0]!.data[40] = 1;
  f.transaction.partialSign(f.signer);
  assert.throws(() => packetPendingFromSigned(f.prepared, f.transaction), /changed/);
  const saved = { version: 1, link: packetLink(f.deployed, f.prepared.packet), pending: f.pending };
  assert.deepEqual(decodeSavedPacket(saved), saved);
  assert.throws(() => decodeSavedPacket({ ...saved, link: null }));
  assert.throws(() => decodeSavedPacket({ ...saved, link: packetLink(f.deployed, actor) }));
  assert.throws(() => decodeSavedPacket({ version: 1, link: null }));
});
test('storage failure prevents broadcast; RPC failure retains the signed transaction for recovery', async () => {
  const { pending } = pendingFixture();
  let broadcasts = 0; let saved = false;
  await assert.rejects(submitPacket(pending, async () => { throw new Error('disk full'); }, async () => { broadcasts++; return pending.signature; }), /disk full/);
  assert.equal(broadcasts, 0);
  await assert.rejects(submitPacket(pending, async () => { saved = true; }, async () => { assert(saved); broadcasts++; throw new Error('timeout'); }), /timeout/);
  assert(saved); assert.equal(broadcasts, 1);
  await assert.rejects(submitPacket(pending, async () => {}, async () => 'wrong'), /different signature/);
});
function recoveryRpc(f: ReturnType<typeof pendingFixture>, overrides: Partial<Connection> = {}): Connection {
  return {
    getGenesisHash: async () => config.genesisHash,
    getAccountInfo: async () => ({ executable: true, owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), data: Buffer.alloc(0), lamports: 1, rentEpoch: 0 }),
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null, slot: 1, confirmations: 1 }] }),
    getTransaction: async () => ({ meta: { err: null }, transaction: { signatures: [f.pending.signature], message: f.transaction.compileMessage() } }),
    ...overrides,
  } as unknown as Connection;
}
test('recovery confirms only exact onchain messages and never trusts program IDs from QR/storage', async () => {
  const f = pendingFixture(); process.env.EXPO_PUBLIC_RED_PACKET_PROGRAM_ID = f.deployed.toBase58();
  try {
    assert.equal(await checkPacketPending(f.pending, recoveryRpc(f)), 'confirmed');
    const other = pendingFixture();
    await assert.rejects(checkPacketPending(f.pending, recoveryRpc(f, { getTransaction: async () => ({
      meta: { err: null }, transaction: { signatures: [f.pending.signature], message: other.transaction.compileMessage() },
    }) as never })), /does not match/);
    await assert.rejects(verifyPacketProgram(f.deployed, recoveryRpc(f, { getGenesisHash: async () => 'wrong' })), /not Solana Devnet/);
    await assert.rejects(verifyPacketProgram(actor, recoveryRpc(f)), /Wrong red packet program/);
    await assert.rejects(verifyPacketProgram(f.deployed, recoveryRpc(f, { getAccountInfo: async () => null })), /not deployed/);
  } finally { delete process.env.EXPO_PUBLIC_RED_PACKET_PROGRAM_ID; }
});
test('an ambiguous signature remains pending; expiry requires finalized height, invalid blockhash and a history recheck', async () => {
  const f = pendingFixture(); process.env.EXPO_PUBLIC_RED_PACKET_PROGRAM_ID = f.deployed.toBase58();
  try {
    let reads = 0;
    const rpc = recoveryRpc(f, {
      getSignatureStatuses: async () => { reads++; return { context: { slot: 1 }, value: [null] }; },
      getBlockHeight: async () => 101,
      isBlockhashValid: async () => ({ context: { slot: 1 }, value: false }),
    });
    assert.equal(await checkPacketPending(f.pending, rpc), 'expired'); assert.equal(reads, 2);
    rpc.isBlockhashValid = async () => ({ context: { slot: 1 }, value: true });
    assert.equal(await checkPacketPending(f.pending, rpc), 'pending');
    rpc.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: 'processed', err: null, slot: 1, confirmations: 0 }] });
    assert.equal(await checkPacketPending(f.pending, rpc), 'pending');
  } finally { delete process.env.EXPO_PUBLIC_RED_PACKET_PROGRAM_ID; }
});

test('creation review uses chain time, separates rents/fees and blocks failed simulations or insufficient SOL', async () => {
  const f = pendingFixture(); process.env.EXPO_PUBLIC_RED_PACKET_PROGRAM_ID = f.deployed.toBase58();
  const mintData = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  const clockData = Buffer.alloc(40); clockData.writeBigInt64LE(1_800_000_000n, 32);
  const rpc = recoveryRpc(f, {
    getAccountInfo: async (key) => {
      if (key.equals(f.deployed)) return { ...info(''), executable: true, owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111') };
      if (key.equals(devnetUsdc.mint)) return { ...info(''), data: mintData, owner: TOKEN_PROGRAM_ID };
      if (key.toBase58() === 'SysvarC1ock11111111111111111111111111111111') return { ...info(''), data: clockData };
      return null;
    },
    getLatestBlockhash: async () => ({ blockhash: f.transaction.recentBlockhash!, lastValidBlockHeight: 100 }),
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: 5000 }),
    getMinimumBalanceForRentExemption: async (size) => size * 100,
    getBalance: async () => 1_000_000_000,
    simulateTransaction: (async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } })) as Connection['simulateTransaction'],
  });
  const create = { asset: devnetUsdc, mode: 0 as const, amount: '1', count: 5, hours: 24 };
  try {
    const result = await preparePacket(f.signer.publicKey, { create }, rpc);
    assert.equal(result.networkFee, 5000n);
    assert.equal(result.rent, BigInt(PACKET_SIZE + ACCOUNT_SIZE) * 100n);
    assert.equal(result.oracleFee, 0n);
    assert.equal(result.transaction.instructions[0]!.data.readBigInt64LE(53), 1_800_086_400n);
    assert(result.message.equals(result.transaction.serializeMessage()));
    rpc.getBalance = async () => 1;
    await assert.rejects(preparePacket(f.signer.publicKey, { create }, rpc), /Not enough Devnet SOL/);
    rpc.getBalance = async () => 1_000_000_000;
    rpc.simulateTransaction = (async () => ({ context: { slot: 1 }, value: { err: 'InvalidAccountData', logs: [] } })) as unknown as Connection['simulateTransaction'];
    await assert.rejects(preparePacket(f.signer.publicKey, { create }, rpc), /preflight failed/);
  } finally { delete process.env.EXPO_PUBLIC_RED_PACKET_PROGRAM_ID; }
});
