import { amountMultiplier, type Asset } from './assets';

const U64_MAX = (1n << 64n) - 1n;

export function parseAssetAmount(input: string, asset: Asset): bigint {
  const multiplier = amountMultiplier(asset);
  const pattern = new RegExp(`^(0|[1-9]\\d{0,19})${asset.decimals ? `(\\.\\d{1,${asset.decimals}})?` : ''}$`);
  if (!pattern.test(input)) {
    throw new Error(`Enter a positive ${asset.symbol} amount with at most ${asset.decimals} decimal places.`);
  }
  const [whole = '0', fraction = ''] = input.split('.');
  const amount = BigInt(whole) * 10n ** BigInt(asset.decimals) + BigInt(fraction.padEnd(asset.decimals, '0') || '0');
  if (amount % multiplier !== 0n) throw new Error(`${asset.symbol} amount is smaller than a transferable unit. Choose a multiple of 0.000002.`);
  if (amount <= 0n || amount / multiplier > U64_MAX) {
    throw new Error(`${asset.symbol} amount is outside the supported range.`);
  }
  return amount / multiplier;
}

export function formatAssetAmount(amount: bigint, asset: Asset): string {
  return formatUnits(amount * amountMultiplier(asset), asset.decimals);
}

export function formatUnits(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount / scale}${fraction ? `.${fraction}` : ''}`;
}
