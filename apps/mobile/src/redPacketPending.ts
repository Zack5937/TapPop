import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import { connection } from './rpc';
import { discriminator, publicKey, parsePacketLink } from './redPacketCodec';
import { verifyPacketProgram, type PacketAction, type PreparedPacket } from './redPacket';

export type PacketPending = { version: 1; program: string; packet: string; actor: string; action: PacketAction;
  raw: string; signature: string; lastValidBlockHeight: number };
export type PacketOutcome = 'pending' | 'confirmed' | 'failed' | 'expired';
const layouts: Record<PacketAction, { accounts: number; bytes: number; packetIndex: number }> = {
  create: { accounts: 8, bytes: 61, packetIndex: 1 }, claim: { accounts: 9, bytes: 8, packetIndex: 1 },
  reserve_lucky: { accounts: 8, bytes: 48, packetIndex: 1 }, settle_lucky: { accounts: 11, bytes: 8, packetIndex: 2 },
  refund: { accounts: 10, bytes: 8, packetIndex: 1 },
};
export function decodePacketPending(value: unknown): PacketPending {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved red packet transaction.');
  const p = value as PacketPending;
  if (p.version !== 1 || !Object.hasOwn(layouts, p.action) || typeof p.raw !== 'string' || p.raw.length > 4000
      || typeof p.signature !== 'string' || !Number.isSafeInteger(p.lastValidBlockHeight) || p.lastValidBlockHeight < 1) {
    throw new Error('Invalid saved red packet transaction.');
  }
  const program = publicKey(p.program); const packet = publicKey(p.packet); const actor = publicKey(p.actor);
  const raw = Buffer.from(p.raw, 'base64');
  const tx = Transaction.from(raw);
  const instruction = tx.instructions[0]; const layout = layouts[p.action];
  if (raw.toString('base64') !== p.raw || !tx.serialize().equals(raw) || !tx.verifySignatures()
      || tx.signatures.length !== 1 || !tx.feePayer?.equals(actor) || !tx.signature || bs58.encode(tx.signature) !== p.signature
      || tx.instructions.length !== 1 || !instruction || !instruction.programId.equals(program)
      || instruction.data.length !== layout.bytes || !instruction.data.subarray(0, 8).equals(discriminator('global', p.action))
      || instruction.keys.length !== layout.accounts || !instruction.keys[layout.packetIndex]?.pubkey.equals(packet)
      || !instruction.keys[0]?.pubkey.equals(actor) || !instruction.keys[0].isSigner) {
    throw new Error('Saved red packet transaction does not match its identity.');
  }
  return { version: 1, program: p.program, packet: p.packet, actor: p.actor, action: p.action,
    raw: p.raw, signature: p.signature, lastValidBlockHeight: p.lastValidBlockHeight };
}
export function packetPendingFromSigned(prepared: PreparedPacket, signed: Transaction): PacketPending {
  if (!prepared.message.equals(signed.serializeMessage()) || !signed.signature) throw new Error('Wallet changed the reviewed red packet transaction.');
  return decodePacketPending({ version: 1, program: prepared.program.toBase58(), packet: prepared.packet.toBase58(),
    actor: prepared.actor.toBase58(), action: prepared.action, raw: signed.serialize({ requireAllSignatures: true, verifySignatures: true }).toString('base64'),
    signature: bs58.encode(signed.signature), lastValidBlockHeight: prepared.lastValidBlockHeight });
}
export async function submitPacket(pending: PacketPending, persist: (pending: PacketPending) => Promise<void>,
  broadcast: Connection['sendRawTransaction'] = connection.sendRawTransaction.bind(connection)) {
  const checked = decodePacketPending(pending);
  await persist(checked);
  // Recovery observes this signature only; it never creates or auto-signs a replacement.
  const signature = await broadcast(Buffer.from(checked.raw, 'base64'), { skipPreflight: false, maxRetries: 3 });
  if (signature !== checked.signature) throw new Error('RPC returned a different signature. Check the saved transaction.');
}
export async function checkPacketPending(pending: PacketPending, rpc: Connection = connection): Promise<PacketOutcome> {
  const p = decodePacketPending(pending);
  await verifyPacketProgram(new PublicKey(p.program), rpc);
  const signed = Transaction.from(Buffer.from(p.raw, 'base64'));
  const status = (await rpc.getSignatureStatuses([p.signature], { searchTransactionHistory: true })).value[0];
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
    if (status.err) return 'failed';
    const tx = await rpc.getTransaction(p.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) return 'pending';
    if (!tx.meta || tx.meta.err || tx.transaction.signatures[0] !== p.signature
        || !Buffer.from(tx.transaction.message.serialize()).equals(signed.serializeMessage())) {
      throw new Error('Onchain transaction does not match the saved red packet operation.');
    }
    return 'confirmed';
  }
  if (!status && await rpc.getBlockHeight('finalized') > p.lastValidBlockHeight
      && !(await rpc.isBlockhashValid(signed.recentBlockhash!, { commitment: 'finalized' })).value
      && !(await rpc.getSignatureStatuses([p.signature], { searchTransactionHistory: true })).value[0]) return 'expired';
  return 'pending';
}

export type SavedPacket = { version: 1; link: string | null; pending: PacketPending | null };
export function decodeSavedPacket(value: unknown): SavedPacket {
  if (!value || typeof value !== 'object') throw new Error('Cannot recover saved red packet state.');
  const record = value as SavedPacket;
  if (record.version !== 1 || (record.link !== null && typeof record.link !== 'string') || !Object.hasOwn(record, 'pending')) {
    throw new Error('Invalid red packet storage.');
  }
  const pending = record.pending === null ? null : decodePacketPending(record.pending);
  if (record.link !== null) {
    const program = publicKey(new URL(record.link).searchParams.get('program') || '');
    const packet = parsePacketLink(record.link, program);
    if (pending && (pending.program !== program.toBase58() || pending.packet !== packet.toBase58())) throw new Error('Saved packet and transaction disagree.');
  } else if (pending) throw new Error('Saved packet transaction has no packet link.');
  return { version: 1, link: record.link, pending };
}
