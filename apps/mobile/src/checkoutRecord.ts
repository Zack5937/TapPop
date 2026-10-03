import { validateMerchantCode, validateMerchantBinding } from './merchantCode';
import { registerDemoMint } from './config';
import { intentAsset, intentMemo, validateIntent } from './paymentIntent';
import { decodePending } from './pending';
import { inspectOffer, type CheckoutRecord } from './checkout';

export function decodeCheckoutRecord(raw: string): CheckoutRecord {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Invalid saved checkout.');
  const p = value as CheckoutRecord;
  if (p.role === 'merchant') {
    const code = validateMerchantCode(p.code, true);
    if (intentAsset(code).display.kind === 'scaled') registerDemoMint(code.settlementMint);
    return { role: 'merchant', code };
  }
  const intent = validateIntent(p.intent, true);
  if (intentAsset(intent).display.kind === 'scaled') registerDemoMint(intent.settlementMint);
  if (p.role !== 'pay' && p.role !== 'receive') throw new Error('Invalid checkout role.');
  if (p.role === 'pay') inspectOffer(intent, p.offer);
  if (p.role === 'receive' && p.merchantCode) validateMerchantBinding(p.merchantCode, intent, true);
  const pending = p.pending ? decodePending(JSON.stringify(p.pending)) : undefined;
  if (pending && (pending.receiver !== intent.receiver || pending.mint !== intent.settlementMint
      || pending.tokenProgram !== intent.settlementTokenProgram || pending.amount !== intent.settlementAmount
      || pending.reference !== intent.reference || pending.memo !== intentMemo(intent)
      || pending.feePayer !== (intent.networkFeePolicy === 'RECEIVER' ? intent.receiver : pending.sender)
      || (p.role === 'pay' && pending.sender !== p.offer.sender))) throw new Error('Saved checkout and payment do not match.');
  return p.role === 'pay' ? { role: 'pay', intent, offer: p.offer, pending } : { role: 'receive', intent, pending, ...(p.merchantCode ? { merchantCode: validateMerchantCode(p.merchantCode, true) } : {}) };
}
