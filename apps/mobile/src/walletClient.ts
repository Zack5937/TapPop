import type { Transaction } from '@solana/web3.js';

// The payment layer needs authorization and sign-only transactions on both platforms.
export interface WalletClient {
  authorize(input: {
    chain: `${string}:${string}`;
    identity: { name?: string; uri?: string; icon?: string };
    auth_token?: string;
  }): Promise<{ accounts: { address: string }[]; auth_token: string }>;
  deauthorize(input: { auth_token: string }): Promise<void>;
  signTransactions(input: { transactions: Transaction[] }): Promise<Transaction[]>;
}
