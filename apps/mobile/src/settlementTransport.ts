import { Buffer } from 'buffer';
export const SETTLEMENT_PART_PREFIX = 'tappay://settle-part?';
const CHUNK = 1000;

export function settlementFrames(text: string): string[] {
  if (text.length > 7000) throw new Error('Settlement QR payload is too large.');
  if (text.length <= 1400) return [text];
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('hex');
  const total = Math.ceil(text.length / CHUNK);
  return Array.from({ length: total }, (_, index) => `${SETTLEMENT_PART_PREFIX}id=${id}&index=${index}&total=${total}&data=${encodeURIComponent(text.slice(index * CHUNK, (index + 1) * CHUNK))}`);
}

// Transport grouping is not authorization. The reassembled record and every
// transaction signature are validated before review or persistence.
export class SettlementCollector {
  private id = '';
  private total = 0;
  private parts = new Map<number, string>();
  reset() { this.id = ''; this.total = 0; this.parts.clear(); }
  accept(text: string): { text?: string; received: number; total: number } {
    if (!text.startsWith(SETTLEMENT_PART_PREFIX)) {
      if (text.length > 7000) throw new Error('Settlement payload too large.');
      this.reset(); return { text, received: 1, total: 1 };
    }
    if (text.length > 3300) throw new Error('Invalid settlement QR part.');
    const params = new URL(text).searchParams;
    const id = params.get('id') ?? ''; const index = Number(params.get('index')); const total = Number(params.get('total'));
    const data = params.get('data');
    if (!/^[a-f0-9]{24}$/.test(id) || !Number.isInteger(total) || total < 2 || total > 7
        || !params.has('index') || !Number.isInteger(index) || index < 0 || index >= total
        || !data || data.length > CHUNK) throw new Error('Invalid settlement QR part.');
    if (this.id && (this.id !== id || this.total !== total)) throw new Error('QR belongs to another exchange. Reset scanned parts first.');
    if (this.parts.has(index) && this.parts.get(index) !== data) throw new Error('Conflicting settlement QR parts.');
    this.id = id; this.total = total; this.parts.set(index, data);
    if (this.parts.size < total) return { received: this.parts.size, total };
    const result = Array.from({ length: total }, (_, i) => this.parts.get(i)!).join('');
    this.reset(); return { text: result, received: total, total };
  }
}
