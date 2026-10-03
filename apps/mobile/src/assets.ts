import type { PublicKey } from '@solana/web3.js';

export type Asset = Readonly<{
  mint: PublicKey;
  symbol: string;
  name: string;
  decimals: number;
  tokenProgram: PublicKey;
  isDemo: boolean;
  display: Readonly<{ kind: 'decimal' } | { kind: 'scaled'; multiplier: 2 }>;
}>;

// The only scaled profile enabled in this milestone is immutable multiplier 2.
export function amountMultiplier(asset: Asset): bigint {
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) {
    throw new Error('This asset requires unsupported amount display rules.');
  }
  if (asset.display.kind === 'decimal') return 1n;
  if (asset.display.kind === 'scaled' && asset.display.multiplier === 2) return 2n;
  throw new Error('This asset requires unsupported amount display rules.');
}
