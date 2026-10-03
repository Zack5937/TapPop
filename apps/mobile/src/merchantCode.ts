import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import type { Asset } from './assets';
import { recipientKey } from './payments';
import { createIntent, intentAsset, MAX_QR_LENGTH, validateIntent, type PaymentIntent } from './paymentIntent';

export type MerchantCode = Readonly<{
  version: 1 | 2; type: 'MERCHANT'; chain: 'solana:devnet'; codeId: string;
  receiver: string; settlementMint: string; settlementTokenProgram: string;
  networkFeePolicy: 'RECEIVER'; accountRentPolicy: 'RECEIVER'; createdAt: number; expiresAt: number | null;
}>;
export type MerchantPayment = { codeId: string; amount: string; reference: string; createdAt: number; expiresAt: number };
export const MERCHANT_PREFIX = 'tappay://merchant?code=';
const LEGACY_MERCHANT_CODE_SECONDS = 86400;

export function merchantCodeExpired(code: MerchantCode, now = Math.floor(Date.now() / 1000)): boolean {
  return code.expiresAt !== null && code.expiresAt <= now;
}

export function validateMerchantCode(value: unknown, allowExpired = false, now = Math.floor(Date.now() / 1000)): MerchantCode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid merchant code.');
  const p = value as MerchantCode;
  if (![1, 2].includes(p.version) || p.type !== 'MERCHANT' || p.chain !== 'solana:devnet'
      || p.networkFeePolicy !== 'RECEIVER' || p.accountRentPolicy !== 'RECEIVER'
      || typeof p.codeId !== 'string' || !/^[a-f0-9]{32}$/.test(p.codeId)) throw new Error('Unsupported merchant code or fee policy.');
  for (const key of ['receiver', 'settlementMint', 'settlementTokenProgram'] as const) {
    if (typeof p[key] !== 'string' || new PublicKey(p[key]).toBase58() !== p[key]
        || new PublicKey(p[key]).equals(PublicKey.default)) throw new Error('Invalid merchant address.');
  }
  recipientKey(p.receiver);
  intentAsset(p);
  const validExpiry = p.version === 2 ? p.expiresAt === null
    : Number.isSafeInteger(p.expiresAt) && p.expiresAt !== null
      && p.expiresAt > p.createdAt && p.expiresAt - p.createdAt <= LEGACY_MERCHANT_CODE_SECONDS;
  if (!Number.isSafeInteger(p.createdAt) || p.createdAt <= 0 || !validExpiry
      || (!allowExpired && (p.createdAt > now + 30 || merchantCodeExpired(p, now)))) throw new Error('Merchant code expired or has an invalid lifetime.');
  return { version: p.version, type: 'MERCHANT', chain: 'solana:devnet', codeId: p.codeId,
    receiver: p.receiver, settlementMint: p.settlementMint, settlementTokenProgram: p.settlementTokenProgram,
    networkFeePolicy: 'RECEIVER', accountRentPolicy: 'RECEIVER', createdAt: p.createdAt, expiresAt: p.expiresAt };
}

export function createMerchantCode(receiver: PublicKey, asset: Asset): MerchantCode {
  const codeId = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  return validateMerchantCode({ version: 2, type: 'MERCHANT', chain: 'solana:devnet', codeId,
    receiver: receiver.toBase58(), settlementMint: asset.mint.toBase58(), settlementTokenProgram: asset.tokenProgram.toBase58(),
    networkFeePolicy: 'RECEIVER', accountRentPolicy: 'RECEIVER', createdAt: now, expiresAt: null });
}

export function createMerchantPayment(code: MerchantCode, amount: string): PaymentIntent {
  validateMerchantCode(code);
  const payment = createIntent(new PublicKey(code.receiver), intentAsset(code), amount);
  return validateIntent({ ...payment, merchantCodeId: code.codeId, expiresAt: code.expiresAt === null ? payment.expiresAt : Math.min(payment.expiresAt, code.expiresAt) });
}

export function validateMerchantBinding(code: MerchantCode, intent: PaymentIntent, allowExpired = false): void {
  validateMerchantCode(code, allowExpired); validateIntent(intent, allowExpired);
  if (intent.merchantCodeId !== code.codeId || intent.receiver !== code.receiver
      || intent.settlementMint !== code.settlementMint || intent.settlementTokenProgram !== code.settlementTokenProgram
      || intent.networkFeePolicy !== 'RECEIVER' || intent.accountRentPolicy !== 'RECEIVER'
      || intent.createdAt < code.createdAt - 30 || (code.expiresAt !== null && intent.expiresAt > code.expiresAt)) throw new Error('Payment does not match this merchant code.');
}

export function resolveMerchantPayment(code: MerchantCode, offer: { intentId: string; nonce: string; merchantPayment?: MerchantPayment }): PaymentIntent {
  if (!offer.merchantPayment) throw new Error('Scan an authorization created from this merchant code.');
  const p = offer.merchantPayment;
  const intent = validateIntent({ version: 1, type: 'REQUEST', chain: 'solana:devnet', intentId: offer.intentId, nonce: offer.nonce,
    merchantCodeId: p.codeId, receiver: code.receiver, settlementMint: code.settlementMint, settlementTokenProgram: code.settlementTokenProgram,
    settlementAmount: p.amount, acceptedFundingAssets: [code.settlementMint], networkFeePolicy: 'RECEIVER', accountRentPolicy: 'RECEIVER',
    reference: p.reference, createdAt: p.createdAt, expiresAt: p.expiresAt });
  validateMerchantBinding(code, intent);
  return intent;
}

export function encodeMerchantCode(code: MerchantCode): string {
  return MERCHANT_PREFIX + encodeURIComponent(JSON.stringify(validateMerchantCode(code, true)));
}
export function decodeMerchantCode(text: string): MerchantCode {
  if (text.length > MAX_QR_LENGTH || !text.startsWith(MERCHANT_PREFIX)) throw new Error('Scan a Tap Pay merchant QR.');
  return validateMerchantCode(JSON.parse(decodeURIComponent(text.slice(MERCHANT_PREFIX.length))));
}
