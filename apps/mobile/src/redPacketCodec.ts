import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { PublicKey, type AccountInfo } from '@solana/web3.js';

export const PACKET_SIZE = 203;
export const CLAIM_SIZE = 114;
// ORAO SDK 0.7.0: discriminator + enum + client + seed + Vec length + 7 responses.
export const ORACLE_REQUEST_SIZE = 8 + 1 + 32 + 32 + 4 + 7 * 96;
export const ORACLE_PROGRAM = new PublicKey('VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y');
export const ORACLE_CONFIG = PublicKey.findProgramAddressSync([Buffer.from('orao-vrf-network-configuration')], ORACLE_PROGRAM)[0];
export const PACKET_PREFIX = 'tappay://packet?';
export const UNDEPLOYED_PACKET_PROGRAM = 'EH8Um52SbBNGdchqXURwAXrjxYTygRGsw37un2UmmeMx';

export function packetProgram(value = process.env.EXPO_PUBLIC_RED_PACKET_PROGRAM_ID): PublicKey {
  if (!value || value === UNDEPLOYED_PACKET_PROGRAM) throw new Error('Red packets are not deployed/configured for this build yet.');
  return publicKey(value);
}
export function publicKey(value: string): PublicKey {
  const key = new PublicKey(value);
  if (key.toBase58() !== value || key.equals(PublicKey.default)) throw new Error('Invalid public address.');
  return key;
}
export function discriminator(namespace: 'account' | 'global', name: string): Buffer {
  return Buffer.from(sha256(Buffer.from(`${namespace}:${name}`))).subarray(0, 8);
}
export function packetAddress(program: PublicKey, creator: PublicKey, nonce: Uint8Array) {
  if (nonce.length !== 32) throw new Error('Invalid packet nonce.');
  return PublicKey.findProgramAddressSync([Buffer.from('packet'), creator.toBuffer(), nonce], program);
}
export function claimAddress(program: PublicKey, packet: PublicKey, claimant: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('claim'), packet.toBuffer(), claimant.toBuffer()], program);
}
export function requestSeed(packet: PublicKey, claimant: PublicKey, nonce: Uint8Array): Buffer {
  if (nonce.length !== 32) throw new Error('Invalid request nonce.');
  return Buffer.from(sha256(Buffer.concat([Buffer.from('tap-pay-vrf-v1'), packet.toBuffer(), claimant.toBuffer(), Buffer.from(nonce)])));
}
export function oracleAddress(seed: Uint8Array): PublicKey {
  if (seed.length !== 32) throw new Error('Invalid VRF seed.');
  return PublicKey.findProgramAddressSync([Buffer.from('orao-vrf-randomness-request'), seed], ORACLE_PROGRAM)[0];
}
export function packetLink(program: PublicKey, packet: PublicKey): string {
  return `${PACKET_PREFIX}v=1&network=devnet&program=${program.toBase58()}&packet=${packet.toBase58()}`;
}
export function parsePacketLink(text: string, program: PublicKey): PublicKey {
  if (text.length > 256 || !text.startsWith(PACKET_PREFIX)) throw new Error('Scan a Devnet red packet QR.');
  const url = new URL(text);
  const packet = publicKey(url.searchParams.get('packet') || '');
  if (text !== packetLink(program, packet)) throw new Error('Wrong network, program or invalid red packet link.');
  return packet;
}

export type Packet = {
  address: PublicKey; creator: PublicKey; mint: PublicKey; tokenProgram: PublicKey; nonce: Buffer;
  mode: 0 | 1; total: bigint; remaining: bigint; maxClaims: number; claimedCount: number;
  expiresAt: number; pendingClaim: PublicKey; status: 0 | 1 | 2; bump: number;
};
export type Claim = { address: PublicKey; packet: PublicKey; claimant: PublicKey; seed: Buffer; amount: bigint; status: 0 | 1 | 2; bump: number };

function accountData(info: AccountInfo<Buffer>, owner: PublicKey, name: string, size?: number): Buffer {
  if (info.executable || !info.owner.equals(owner) || (size !== undefined && info.data.length !== size)
      || info.data.length < 8 || !info.data.subarray(0, 8).equals(discriminator('account', name))) {
    throw new Error(`Invalid ${name} account owner or layout.`);
  }
  return info.data;
}
export function decodePacket(address: PublicKey, info: AccountInfo<Buffer>, program: PublicKey): Packet {
  const d = accountData(info, program, 'Packet', PACKET_SIZE);
  const packet: Packet = { address, creator: new PublicKey(d.subarray(8, 40)), mint: new PublicKey(d.subarray(40, 72)),
    tokenProgram: new PublicKey(d.subarray(72, 104)), nonce: d.subarray(104, 136), mode: d[136] as 0 | 1,
    total: d.readBigUInt64LE(137), remaining: d.readBigUInt64LE(145), maxClaims: d.readUInt32LE(153),
    claimedCount: d.readUInt32LE(157), expiresAt: Number(d.readBigInt64LE(161)),
    pendingClaim: new PublicKey(d.subarray(169, 201)), status: d[201] as 0 | 1 | 2, bump: d[202]! };
  const [expected, bump] = packetAddress(program, packet.creator, packet.nonce);
  const left = packet.maxClaims - packet.claimedCount;
  if (!address.equals(expected) || bump !== packet.bump || ![0, 1].includes(packet.mode)
      || ![0, 1, 2].includes(packet.status) || packet.maxClaims < 1 || packet.maxClaims > 1000 || left < 0
      || packet.total < BigInt(packet.maxClaims) || packet.remaining > packet.total
      || !Number.isSafeInteger(packet.expiresAt) || packet.expiresAt <= 0
      || (packet.mode === 0 && packet.total % BigInt(packet.maxClaims) !== 0n)
      || (packet.status === 0 && (left === 0 || packet.remaining < BigInt(left)))
      || (packet.status === 1 && (left !== 0 || packet.remaining !== 0n))
      || (packet.status === 2 && packet.remaining !== 0n)
      || (packet.status === 0 && packet.mode === 0 && packet.remaining !== packet.total / BigInt(packet.maxClaims) * BigInt(left))
      || (!packet.pendingClaim.equals(PublicKey.default) && (packet.mode !== 1 || packet.status !== 0 || left < 2))) {
    throw new Error('Invalid red packet state or PDA.');
  }
  return packet;
}
export function decodeClaim(address: PublicKey, info: AccountInfo<Buffer>, program: PublicKey, packet: PublicKey): Claim {
  const d = accountData(info, program, 'ClaimRecord', CLAIM_SIZE);
  const claim: Claim = { address, packet: new PublicKey(d.subarray(8, 40)), claimant: new PublicKey(d.subarray(40, 72)),
    seed: d.subarray(72, 104), amount: d.readBigUInt64LE(104), status: d[112] as 0 | 1 | 2, bump: d[113]! };
  const [expected, bump] = claimAddress(program, packet, claim.claimant);
  if (!claim.packet.equals(packet) || !address.equals(expected) || claim.bump !== bump || ![0, 1, 2].includes(claim.status)
      || (claim.status === 1 ? claim.amount === 0n : claim.amount !== 0n)) throw new Error('Invalid claim record.');
  return claim;
}
export function decodeOracle(address: PublicKey, info: AccountInfo<Buffer>, claim: Claim): boolean {
  const d = accountData(info, ORACLE_PROGRAM, 'RandomnessV2');
  if (d.length < 77 || !address.equals(oracleAddress(claim.seed)) || !new PublicKey(d.subarray(9, 41)).equals(claim.claimant)
      || !d.subarray(41, 73).equals(claim.seed) || (d[8] !== 0 && d[8] !== 1)
      || (d[8] === 1 && d.length < 137) || (d[8] === 0 && (d.readUInt32LE(73) > 10 || 77 + d.readUInt32LE(73) * 96 > d.length))) {
    throw new Error('Invalid or mismatched VRF request.');
  }
  return d[8] === 1;
}
export function decodeOracleConfig(info: AccountInfo<Buffer>): { treasury: PublicKey; fee: bigint } {
  const d = accountData(info, ORACLE_PROGRAM, 'NetworkState');
  if (d.length < 93) throw new Error('Invalid VRF configuration.');
  const authorities = d.readUInt32LE(80);
  const option = 84 + authorities * 32;
  if (authorities < 1 || authorities > 10 || d.length < option + 1 + 8 || ![0, 1].includes(d[option]!)) throw new Error('Invalid VRF authorities.');
  if (d[option] === 1 && d.length < option + 1 + 72 + 8) throw new Error('Invalid VRF fee configuration.');
  return { treasury: publicKey(new PublicKey(d.subarray(40, 72)).toBase58()), fee: d.readBigUInt64LE(72) };
}
