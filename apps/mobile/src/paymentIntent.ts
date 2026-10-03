import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { devnetUsdc } from './config';
import { demoAsset } from './demoAsset';
import { formatAssetAmount, parseAssetAmount } from './amount';
import { recipientKey } from './payments';
import type { Asset } from './assets';

export type FeePolicy = 'RECEIVER' | 'PAYER';
export type PaymentIntent = Readonly<{
  version: 1; type: 'REQUEST'; chain: 'solana:devnet'; intentId: string;
  receiver: string; settlementMint: string; settlementTokenProgram: string;
  settlementAmount: string; acceptedFundingAssets: readonly string[];
  networkFeePolicy: FeePolicy; accountRentPolicy: FeePolicy;
  merchantCodeId?: string;
  reference: string; nonce: string; createdAt: number; expiresAt: number;
}>;
export const REQUEST_PREFIX = 'tappay://pay?request=';
export const OFFER_PREFIX = 'tappay://authorize?offer=';
export const MAX_QR_LENGTH = 2200;
export const REQUEST_SECONDS = 600;
export const MAX_NETWORK_FEE = 20_000;
export { MEMO_PROGRAM } from './config';

export function intentAsset(intent: Pick<PaymentIntent, 'settlementMint' | 'settlementTokenProgram'>): Asset {
  if (intent.settlementMint === devnetUsdc.mint.toBase58()
      && intent.settlementTokenProgram === devnetUsdc.tokenProgram.toBase58()) return devnetUsdc;
  if (intent.settlementTokenProgram === TOKEN_2022_PROGRAM_ID.toBase58()
      && intent.settlementMint !== devnetUsdc.mint.toBase58()) return demoAsset(new PublicKey(intent.settlementMint));
  throw new Error('Unsupported settlement token or token program.');
}

export function validateIntent(value: unknown, allowExpired = false, now = Math.floor(Date.now() / 1000)): PaymentIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid payment request.');
  const p = value as PaymentIntent;
  if (p.version !== 1 || p.type !== 'REQUEST' || p.chain !== 'solana:devnet'
      || !['RECEIVER', 'PAYER'].includes(p.networkFeePolicy)
      || p.accountRentPolicy !== p.networkFeePolicy) throw new Error('Unsupported payment request or fee policy.');
  for (const key of ['intentId', 'nonce'] as const) {
    if (typeof p[key] !== 'string' || !/^[a-f0-9]{32}$/.test(p[key])) throw new Error('Invalid request identity.');
  }
  for (const key of ['receiver', 'settlementMint', 'settlementTokenProgram', 'reference'] as const) {
    if (typeof p[key] !== 'string' || new PublicKey(p[key]).toBase58() !== p[key]
        || new PublicKey(p[key]).equals(PublicKey.default)) throw new Error('Invalid request address.');
  }
  recipientKey(p.receiver);
  if (p.merchantCodeId !== undefined && (typeof p.merchantCodeId !== 'string' || !/^[a-f0-9]{32}$/.test(p.merchantCodeId))) throw new Error('Invalid merchant code identity.');
  if (p.reference === p.receiver || p.reference === p.settlementMint || p.reference === p.settlementTokenProgram) {
    throw new Error('Invalid payment reference.');
  }
  if (!Number.isSafeInteger(p.createdAt) || !Number.isSafeInteger(p.expiresAt)
      || p.createdAt <= 0 || p.expiresAt <= p.createdAt || p.expiresAt - p.createdAt > REQUEST_SECONDS
      || (!allowExpired && (p.createdAt > now + 30 || p.expiresAt <= now))) throw new Error('Payment request expired or has an invalid lifetime.');
  const asset = intentAsset(p);
  if (typeof p.settlementAmount !== 'string'
      || formatAssetAmount(parseAssetAmount(p.settlementAmount, asset), asset) !== p.settlementAmount) {
    throw new Error('Invalid request amount.');
  }
  if (!Array.isArray(p.acceptedFundingAssets) || p.acceptedFundingAssets.length !== 1
      || p.acceptedFundingAssets[0] !== p.settlementMint) throw new Error('Cross-token settlement is not available yet.');
  // Rebuild known fields; never retain hidden properties from external JSON.
  return { version: 1, type: 'REQUEST', chain: 'solana:devnet', intentId: p.intentId,
    receiver: p.receiver, settlementMint: p.settlementMint, settlementTokenProgram: p.settlementTokenProgram,
    settlementAmount: p.settlementAmount, acceptedFundingAssets: [p.settlementMint],
    networkFeePolicy: p.networkFeePolicy, accountRentPolicy: p.accountRentPolicy,
    ...(p.merchantCodeId ? { merchantCodeId: p.merchantCodeId } : {}),
    reference: p.reference, nonce: p.nonce, createdAt: p.createdAt, expiresAt: p.expiresAt };
}

export function createIntent(receiver: PublicKey, asset: Asset, amount: string, policy: FeePolicy = 'RECEIVER'): PaymentIntent {
  const randomHex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  return validateIntent({ version: 1, type: 'REQUEST', chain: 'solana:devnet', intentId: randomHex(),
    receiver: receiver.toBase58(), settlementMint: asset.mint.toBase58(), settlementTokenProgram: asset.tokenProgram.toBase58(),
    settlementAmount: formatAssetAmount(parseAssetAmount(amount, asset), asset), acceptedFundingAssets: [asset.mint.toBase58()],
    networkFeePolicy: policy, accountRentPolicy: policy, reference: new PublicKey(crypto.getRandomValues(new Uint8Array(32))).toBase58(),
    nonce: randomHex(), createdAt: now, expiresAt: now + REQUEST_SECONDS });
}

export function intentMemo(p: PaymentIntent): string {
  return `TapPay:1:${p.intentId}:${p.nonce}:${p.expiresAt}:${p.networkFeePolicy}:${p.accountRentPolicy}${p.merchantCodeId ? `:${p.merchantCodeId}` : ''}`;
}

export function encodeRequest(intent: PaymentIntent): string {
  return REQUEST_PREFIX + encodeURIComponent(JSON.stringify(validateIntent(intent, true)));
}
export function decodeRequest(text: string): PaymentIntent {
  if (text.length > MAX_QR_LENGTH || !text.startsWith(REQUEST_PREFIX)) throw new Error('Scan a Tap Pay Devnet payment QR.');
  return validateIntent(JSON.parse(decodeURIComponent(text.slice(REQUEST_PREFIX.length))));
}
