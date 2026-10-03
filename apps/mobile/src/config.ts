import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { demoAsset } from './demoAsset';
import type { Asset } from './assets';

const rpcUrl = process.env.EXPO_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
if (new URL(rpcUrl).protocol !== 'https:') {
  throw new Error('Devnet RPC must use HTTPS.');
}

export const devnetUsdc: Asset = Object.freeze({
  mint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  symbol: 'USDC',
  name: 'Devnet USDC',
  decimals: 6,
  tokenProgram: TOKEN_PROGRAM_ID,
  isDemo: true,
  display: Object.freeze({ kind: 'decimal' as const }),
});

const assets: Asset[] = [devnetUsdc];
export function supportedAssets(): readonly Asset[] { return assets; }
export function registerDemoMint(address: string): Asset {
  const asset = demoAsset(new PublicKey(address));
  if (asset.mint.equals(devnetUsdc.mint) || asset.mint.equals(PublicKey.default)) throw new Error('Invalid demo mint address.');
  if (!assets.some((a) => a.mint.equals(asset.mint))) assets.push(asset);
  return asset;
}
const configuredDemoMint = process.env.EXPO_PUBLIC_AAPLX_DEMO_MINT;
if (configuredDemoMint) registerDemoMint(configuredDemoMint);

export function getConfiguredAsset(mint: string, tokenProgram: string): Asset {
  const asset = assets.find((a) => a.mint.toBase58() === mint && a.tokenProgram.toBase58() === tokenProgram);
  if (!asset) throw new Error('Unsupported asset or token program.');
  return asset;
}

export function validateAsset(asset: Asset): void {
  const configured = getConfiguredAsset(asset.mint.toBase58(), asset.tokenProgram.toBase58());
  if (asset.decimals !== configured.decimals || asset.display.kind !== configured.display.kind
      || (asset.display.kind === 'scaled' && asset.display.multiplier !== 2)
      || asset.symbol !== configured.symbol) {
    throw new Error('Asset metadata does not match configuration.');
  }
}

export const config = Object.freeze({
  chain: 'solana:devnet' as const,
  rpcUrl,
  rpcTimeoutMs: 15_000,
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  identity: { name: 'Tap Pay · Devnet' },
});

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
