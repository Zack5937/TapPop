import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction, TransactionInstruction, VersionedTransaction,
  type AccountMeta, type Connection } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ACCOUNT_SIZE, ExtensionType, getAccountLen,
  getAssociatedTokenAddressSync, getMint, getAccount } from '@solana/spl-token';
import { getConfiguredAsset, validateAsset } from './config';
import type { Asset } from './assets';
import { parseAssetAmount, formatAssetAmount } from './amount';
import { connection, verifyNetwork } from './payments';
import { validateDemoMint } from './demoAsset';
import { CLAIM_SIZE, PACKET_SIZE, ORACLE_REQUEST_SIZE, ORACLE_PROGRAM, ORACLE_CONFIG,
  claimAddress, packetAddress, requestSeed, oracleAddress, discriminator, decodePacket, decodeClaim,
  decodeOracle, decodeOracleConfig, packetProgram, type Packet, type Claim } from './redPacketCodec';

export type PacketAction = 'create' | 'claim' | 'reserve_lucky' | 'settle_lucky' | 'refund';
export type PacketView = { packet: Packet; asset: Asset; ownClaim: Claim | null; pending: Claim | null; fulfilled: boolean; now: number };
export type CreatePacket = { asset: Asset; mode: 0 | 1; amount: string; count: number; hours: number };
export type PreparedPacket = { program: PublicKey; packet: PublicKey; action: PacketAction; actor: PublicKey;
  transaction: Transaction; message: Buffer; lastValidBlockHeight: number; preparedAt: number;
  title: string; description: string; asset: Asset; networkFee: bigint; rent: bigint; oracleFee: bigint };
export const packetAta = (owner: PublicKey, asset: Asset) => getAssociatedTokenAddressSync(asset.mint, owner, true, asset.tokenProgram);
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
const u64 = (value: bigint) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(value); return data; };
const u32 = (value: number) => { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data; };
const tail = (asset: Asset) => [meta(asset.tokenProgram), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId)];
function ix(program: PublicKey, action: PacketAction, keys: AccountMeta[], args = Buffer.alloc(0)) {
  return new TransactionInstruction({ programId: program, keys, data: Buffer.concat([discriminator('global', action), args]) });
}
export function validatePacketInput(input: CreatePacket): bigint {
  validateAsset(input.asset);
  const total = parseAssetAmount(input.amount, input.asset);
  if (![0, 1].includes(input.mode) || !Number.isInteger(input.count) || input.count < 1 || input.count > 1000
      || total < BigInt(input.count)) throw new Error('Choose 1–1000 shares, with at least one transferable unit each.');
  if (input.mode === 0 && total % BigInt(input.count) !== 0n) throw new Error('Equal packets must divide exactly into transferable token units.');
  if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 168) throw new Error('Expiry must be 1–168 hours.');
  return total;
}
export function createPacketInstruction(program: PublicKey, creator: PublicKey, nonce: Buffer, input: CreatePacket, expiresAt: number) {
  const total = validatePacketInput(input);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error('Invalid expiry.');
  const packet = packetAddress(program, creator, nonce)[0];
  return { packet, instruction: ix(program, 'create', [meta(creator, true, true), meta(packet, true), meta(input.asset.mint),
    meta(packetAta(creator, input.asset), true), meta(packetAta(packet, input.asset), true), ...tail(input.asset)],
  Buffer.concat([nonce, Buffer.from([input.mode]), u64(total), u32(input.count), u64(BigInt(expiresAt))])) };
}
export function claimPacketInstruction(program: PublicKey, actor: PublicKey, view: PacketView) {
  const { packet, asset } = view;
  return ix(program, 'claim', [meta(actor, true, true), meta(packet.address, true),
    meta(claimAddress(program, packet.address, actor)[0], true), meta(asset.mint),
    meta(packetAta(packet.address, asset), true), meta(packetAta(actor, asset), true), ...tail(asset)]);
}
export function reservePacketInstruction(program: PublicKey, actor: PublicKey, packet: PublicKey, nonce: Buffer, treasury: PublicKey, fee: bigint) {
  const random = oracleAddress(requestSeed(packet, actor, nonce));
  return { random, instruction: ix(program, 'reserve_lucky', [meta(actor, true, true), meta(packet, true),
    meta(claimAddress(program, packet, actor)[0], true), meta(random, true), meta(ORACLE_CONFIG, true),
    meta(treasury, true), meta(ORACLE_PROGRAM), meta(SystemProgram.programId)], Buffer.concat([nonce, u64(fee)])) };
}
export function settlePacketInstruction(program: PublicKey, actor: PublicKey, view: PacketView) {
  const { packet, asset, pending } = view;
  if (!pending) throw new Error('No pending claim.');
  return ix(program, 'settle_lucky', [meta(actor, true, true), meta(pending.claimant), meta(packet.address, true),
    meta(pending.address, true), meta(oracleAddress(pending.seed)), meta(asset.mint), meta(packetAta(packet.address, asset), true),
    meta(packetAta(pending.claimant, asset), true), ...tail(asset)]);
}
export function refundPacketInstruction(program: PublicKey, actor: PublicKey, view: PacketView) {
  const { packet, asset, pending } = view;
  // Anchor optional accounts are represented by the program ID sentinel.
  return ix(program, 'refund', [meta(actor, true, true), meta(packet.address, true),
    meta(pending?.address ?? program, !!pending), meta(pending ? oracleAddress(pending.seed) : program), meta(asset.mint),
    meta(packetAta(packet.address, asset), true), meta(packetAta(actor, asset), true), ...tail(asset)]);
}

export async function verifyPacketProgram(program: PublicKey, rpc: Connection = connection) {
  if (!program.equals(packetProgram())) throw new Error('Wrong red packet program.');
  await verifyNetwork(rpc);
  const info = await rpc.getAccountInfo(program, 'confirmed');
  const loaders = ['BPFLoaderUpgradeab1e11111111111111111111111', 'BPFLoader2111111111111111111111111111111111'];
  if (!info?.executable || !loaders.includes(info.owner.toBase58())) throw new Error('Configured red packet program is not deployed on Devnet.');
}
async function chainTime(rpc: Connection): Promise<number> {
  const info = await rpc.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (!info || info.data.length !== 40) throw new Error('Cannot read Solana clock.');
  const now = Number(info.data.readBigInt64LE(32));
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid Solana clock.');
  return now;
}
async function checkMint(asset: Asset, rpc: Connection) {
  validateAsset(asset);
  const mint = await getMint(rpc, asset.mint, 'confirmed', asset.tokenProgram);
  if (!mint.isInitialized || mint.decimals !== asset.decimals) throw new Error('Token mint does not match the configured asset.');
  if (asset.display.kind === 'scaled') validateDemoMint(mint);
}
export async function readPacket(address: PublicKey, actor?: PublicKey, rpc: Connection = connection): Promise<PacketView> {
  const program = packetProgram();
  await verifyPacketProgram(program, rpc);
  const result = await rpc.getAccountInfoAndContext(address, 'confirmed');
  if (!result.value) throw new Error('Red packet not found on Devnet.');
  const packet = decodePacket(address, result.value, program);
  const asset = getConfiguredAsset(packet.mint.toBase58(), packet.tokenProgram.toBase58());
  await checkMint(asset, rpc);
  const readClaim = async (key: PublicKey, required: boolean) => {
    const info = await rpc.getAccountInfo(key, { commitment: 'confirmed', minContextSlot: result.context.slot });
    if (!info && required) throw new Error('Pending claim is unavailable. Refresh before proceeding.');
    return info ? decodeClaim(key, info, program, address) : null;
  };
  const [ownClaim, pending, vault, now] = await Promise.all([
    actor ? readClaim(claimAddress(program, address, actor)[0], false) : null,
    packet.pendingClaim.equals(PublicKey.default) ? null : readClaim(packet.pendingClaim, true),
    getAccount(rpc, packetAta(address, asset), 'confirmed', asset.tokenProgram), chainTime(rpc),
  ]);
  if (!vault.owner.equals(address) || !vault.mint.equals(asset.mint) || vault.amount < packet.remaining || !vault.isInitialized) {
    throw new Error('Escrow account does not match the red packet.');
  }
  let fulfilled = false;
  if (pending) {
    if (pending.status !== 0) throw new Error('Claim changed while refreshing. Refresh again.');
    const key = oracleAddress(pending.seed);
    const info = await rpc.getAccountInfo(key, { commitment: 'confirmed', minContextSlot: result.context.slot });
    if (!info) throw new Error('VRF request not found.');
    fulfilled = decodeOracle(key, info, pending);
  }
  return { packet, asset, ownClaim, pending, fulfilled, now };
}

export async function preparePacket(actor: PublicKey, request: { create: CreatePacket } | { address: PublicKey; action: Exclude<PacketAction, 'create'> }, rpc: Connection = connection): Promise<PreparedPacket> {
  const program = packetProgram();
  await verifyPacketProgram(program, rpc);
  if (!PublicKey.isOnCurve(actor.toBytes())) throw new Error('Connect a wallet first.');
  let packet: PublicKey; let instruction: TransactionInstruction; let asset: Asset;
  let title: string; let description: string; let action: PacketAction; let oracleFee = 0n;
  const rentSizes: number[] = [];
  let newAta: PublicKey | null = null;
  if ('create' in request) {
    const input = request.create;
    const total = validatePacketInput(input);
    asset = input.asset; action = 'create';
    await checkMint(asset, rpc);
    const nonce = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = await chainTime(rpc) + input.hours * 3600;
    ({ packet, instruction } = createPacketInstruction(program, actor, nonce, input, expiresAt));
    rentSizes.push(PACKET_SIZE); newAta = packetAta(packet, asset);
    title = `Create ${input.mode === 0 ? 'equal' : 'lucky'} red packet`;
    description = `${formatAssetAmount(total, asset)} ${asset.symbol} · ${input.count} shares · expires ${new Date(expiresAt * 1000).toLocaleString()}`;
    if (input.mode === 0) description += `\nEach share: ${formatAssetAmount(total / BigInt(input.count), asset)} ${asset.symbol}`;
  } else {
    const view = await readPacket(request.address, actor, rpc);
    const p = view.packet;
    packet = p.address; asset = view.asset; action = request.action;
    if (p.status !== 0) throw new Error('This red packet is closed.');
    if (action === 'claim' || action === 'reserve_lucky') {
      if (view.now >= p.expiresAt) throw new Error('This red packet has expired.');
      if (view.ownClaim) throw new Error('This wallet already claimed or reserved this packet.');
      if (view.pending) throw new Error('Complete the pending lucky claim first.');
      rentSizes.push(CLAIM_SIZE);
      if (action === 'claim') {
        if (p.mode !== 0 && p.maxClaims - p.claimedCount !== 1) throw new Error('Reserve a VRF claim first.');
        instruction = claimPacketInstruction(program, actor, view); newAta = packetAta(actor, asset);
        title = 'Claim red packet';
        description = `Receive ${formatAssetAmount(p.mode === 0 ? p.total / BigInt(p.maxClaims) : p.remaining, asset)} ${asset.symbol}`;
      } else {
        if (p.mode !== 1 || p.maxClaims - p.claimedCount < 2) throw new Error('This share does not need VRF.');
        const info = await rpc.getAccountInfo(ORACLE_CONFIG, 'confirmed');
        const oracleProgram = await rpc.getAccountInfo(ORACLE_PROGRAM, 'confirmed');
        if (!info || !oracleProgram?.executable) throw new Error('VRF is unavailable on Devnet.');
        const oracle = decodeOracleConfig(info); oracleFee = oracle.fee;
        const nonce = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)));
        const reserved = reservePacketInstruction(program, actor, packet, nonce, oracle.treasury, oracle.fee);
        if (await rpc.getAccountInfo(reserved.random, 'confirmed')) throw new Error('VRF request already exists. Review a fresh request.');
        instruction = reserved.instruction; rentSizes.push(ORACLE_REQUEST_SIZE);
        title = 'Reserve lucky claim';
        description = 'Amount is determined after VRF fulfillment. This permanently locks your claim; no reroll. A second wallet confirmation is needed to settle. Settlement may require additional network fees and token-account rent.';
      }
    } else if (action === 'settle_lucky') {
      if (!view.pending || !view.fulfilled) throw new Error('Waiting for VRF fulfillment. Refresh later.');
      instruction = settlePacketInstruction(program, actor, view); newAta = packetAta(view.pending.claimant, asset);
      title = 'Complete lucky claim'; description = `Deliver ${asset.symbol} to the reserved wallet:\n${view.pending.claimant.toBase58()}\nYou pay this settlement's fees. The contract calculates the allocation.`;
    } else {
      if (!p.creator.equals(actor)) throw new Error('Only the creator can refund this packet.');
      if (view.now < p.expiresAt) throw new Error('Refund is available after expiry.');
      if (view.pending && (view.fulfilled || view.now < p.expiresAt + 3600)) throw new Error('Settle fulfilled claims first, or wait until the unfulfilled claim grace period ends.');
      instruction = refundPacketInstruction(program, actor, view); newAta = packetAta(actor, asset);
      title = 'Refund remaining packet'; description = `Return up to ${formatAssetAmount(p.remaining, asset)} ${asset.symbol} to the creator and permanently close the packet. Account rent is retained.`;
    }
  }
  if (newAta && !await rpc.getAccountInfo(newAta, 'confirmed')) rentSizes.push(asset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? getAccountLen([ExtensionType.ImmutableOwner]) : ACCOUNT_SIZE);
  const latest = await rpc.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: actor, ...latest }).add(instruction);
  const [fee, rents, balance, simulated] = await Promise.all([
    rpc.getFeeForMessage(transaction.compileMessage(), 'confirmed'),
    Promise.all(rentSizes.map((size) => rpc.getMinimumBalanceForRentExemption(size))),
    rpc.getBalance(actor, 'confirmed'),
    rpc.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), { commitment: 'confirmed', sigVerify: false }),
  ]);
  if (fee.value === null) throw new Error('Cannot estimate the network fee.');
  const networkFee = BigInt(fee.value); const rent = rents.reduce((sum, value) => sum + BigInt(value), 0n);
  if (BigInt(balance) < networkFee + rent + oracleFee) throw new Error('Not enough Devnet SOL for the listed fees and rent.');
  if (simulated.value.err) throw new Error(`Red packet preflight failed: ${JSON.stringify(simulated.value.err)}. Refresh the packet and check your token/SOL balances.`);
  return { program, packet, action, actor, transaction, message: Buffer.from(transaction.serializeMessage()),
    lastValidBlockHeight: latest.lastValidBlockHeight, preparedAt: Date.now(), title, description, asset, networkFee, rent, oracleFee };
}
