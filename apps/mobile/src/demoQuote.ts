import type { Asset } from './assets';
import { devnetUsdc } from './config';
import { formatAssetAmount, parseAssetAmount } from './amount';

export interface QuoteProvider {
  quote(funding: Asset, usdcAmount: string): { fundingAmount: string; fundingRaw: bigint; settlementRaw: bigint; label: string };
}

// Demo price per displayed token, not per raw unit. Never a live market quote.
export const DemoQuoteProvider: QuoteProvider = {
  quote(funding, usdcAmount) {
    if (funding.symbol !== 'AAPLx-DEMO' || funding.decimals !== 6
        || funding.display.kind !== 'scaled' || funding.display.multiplier !== 2) throw new Error('Unsupported demo funding asset.');
    const settlementRaw = parseAssetAmount(usdcAmount, devnetUsdc);
    // 1 raw funding unit = 0.000002 UI tokens = 400 raw USDC at 200 USDC/UI.
    if (settlementRaw % 400n !== 0n) throw new Error('Demo conversion requires a USDC amount in multiples of 0.0004. No hidden rounding.');
    const fundingRaw = settlementRaw / 400n;
    return { fundingRaw, settlementRaw, fundingAmount: formatAssetAmount(fundingRaw, funding), label: 'Demo fixed price: 1 AAPLx-DEMO = 200 USDC' };
  },
};
