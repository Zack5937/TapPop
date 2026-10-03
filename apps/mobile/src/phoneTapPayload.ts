import { Buffer } from 'buffer';
import { paymentLinkTarget, prepareNfcRequest } from './paymentLinks';
import { OFFER_PREFIX } from './paymentIntent';
import { decodeOffer } from './checkout';
import { DEMO_SETTLEMENT_PREFIX, decodeDemoText, validateDemoRequest } from './demoSettlement';

// Phone transport may also hand over existing partial signatures. This is not
// authorization to add signatures: the destination payment handler must inspect
// the exact transaction against its own saved request and require wallet approval.
export function phoneTapPayload(text: string): string {
  if (Buffer.byteLength(text, 'utf8') > 7000 || !paymentLinkTarget(text)) throw new Error('Unsupported phone tap payload.');
  if (text.startsWith(OFFER_PREFIX)) {
    const offer = decodeOffer(text);
    if (!offer || typeof offer.transaction !== 'string' || offer.transaction.length > 1700
        || typeof offer.intentId !== 'string' || typeof offer.sender !== 'string') throw new Error('Invalid phone payment authorization.');
  } else if (text.startsWith(DEMO_SETTLEMENT_PREFIX)) {
    const record = decodeDemoText(text);
    validateDemoRequest(record.request);
  } else prepareNfcRequest(text); // Rejects QR fragments and foreign schemes.
  return text;
}
