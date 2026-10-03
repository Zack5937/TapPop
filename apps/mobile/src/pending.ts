import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { parseAssetAmount } from './amount';
import { devnetUsdc, getConfiguredAsset } from './config';
import { recipientKey, type PendingPayment } from './payments';

export function decodePending(raw: string): PendingPayment {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Invalid saved payment.');
  const p = value as Record<string, unknown>;
  for (const field of ['signature', 'blockhash', 'sender', 'receiver', 'amount']) {
    if (typeof p[field] !== 'string') throw new Error('Invalid saved payment.');
  }
  if (typeof p.lastValidBlockHeight !== 'number' || !Number.isSafeInteger(p.lastValidBlockHeight)
      || p.lastValidBlockHeight < 1 || bs58.decode(p.signature as string).length !== 64) {
    throw new Error('Invalid saved payment.');
  }
  new PublicKey(p.blockhash as string);
  recipientKey(p.receiver as string, recipientKey(p.sender as string));
  // Old Milestone 0 records were exclusively Devnet USDC. Migrate those only;
  // a partially present or unknown asset identity must never fall back to USDC.
  if (p.mint === undefined && p.tokenProgram === undefined) {
    p.mint = devnetUsdc.mint.toBase58();
    p.tokenProgram = devnetUsdc.tokenProgram.toBase58();
  }
  if (typeof p.mint !== 'string' || typeof p.tokenProgram !== 'string') {
    throw new Error('Invalid saved payment asset.');
  }
  if (p.feePayer !== undefined && (typeof p.feePayer !== 'string' || (p.feePayer !== p.sender && p.feePayer !== p.receiver))) {
    throw new Error('Invalid saved fee payer.');
  }
  if ((p.reference === undefined) !== (p.memo === undefined)) throw new Error('Incomplete saved request.');
  if (p.reference !== undefined) {
    if (typeof p.reference !== 'string' || typeof p.memo !== 'string' || p.memo.length > 200) throw new Error('Invalid saved reference.');
    new PublicKey(p.reference);
  }
  const asset = getConfiguredAsset(p.mint, p.tokenProgram);
  parseAssetAmount(p.amount as string, asset);
  return p as PendingPayment;
}
