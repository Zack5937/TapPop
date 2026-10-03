import { Buffer } from 'buffer';
import { REQUEST_PREFIX, OFFER_PREFIX, decodeRequest } from './paymentIntent';
import { MERCHANT_PREFIX, decodeMerchantCode } from './merchantCode';
import { DEMO_SETTLEMENT_PREFIX, decodeDemoText, validateDemoRequest } from './demoSettlement';
import { SETTLEMENT_PART_PREFIX } from './settlementTransport';

// Routing only. Existing payment handlers still validate amounts, parties,
// network, expiry and signatures; a link never invokes wallet signing.
export function paymentLinkTarget(url: string): 'checkout' | 'demo' | null {
  if (url.length > 7000) return null;
  if ([REQUEST_PREFIX, MERCHANT_PREFIX, OFFER_PREFIX].some((prefix) => url.startsWith(prefix))) return 'checkout';
  if ([DEMO_SETTLEMENT_PREFIX, SETTLEMENT_PART_PREFIX].some((prefix) => url.startsWith(prefix))) return 'demo';
  return null;
}

export function prepareNfcRequest(url: string): { uri: string; ndefBytes: number; permanent: boolean } {
  let permanent = false;
  if (url.startsWith(REQUEST_PREFIX)) decodeRequest(url);
  else if (url.startsWith(MERCHANT_PREFIX)) permanent = decodeMerchantCode(url).expiresAt === null;
  else if (url.startsWith(DEMO_SETTLEMENT_PREFIX)) {
    const record = decodeDemoText(url);
    validateDemoRequest(record.request);
    if (record.exchange) throw new Error('NFC tags hold receive requests, not signed payment authorizations.');
  } else throw new Error('Use a receive request or merchant link for this NFC tag.');
  // One uncompressed NDEF URI record: RTD U (one byte), URI prefix 0,
  // short-record header (3 bytes) or normal header (6 bytes). Tag TLV overhead
  // is additional and is deliberately stated separately in the UI.
  const payloadBytes = Buffer.byteLength(url, 'utf8') + 1;
  return { uri: url, ndefBytes: payloadBytes + 1 + (payloadBytes <= 255 ? 3 : 6), permanent };
}
