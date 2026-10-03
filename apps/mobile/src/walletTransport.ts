import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import type { WalletClient } from './walletClient';

export async function withWallet<T>(action: (wallet: WalletClient) => Promise<T>): Promise<T> {
  return await transact((wallet) => action({
    authorize: (input) => wallet.authorize(input),
    deauthorize: async (input) => { await wallet.deauthorize(input); },
    signTransactions: (input) => wallet.signTransactions(input),
  }));
}
