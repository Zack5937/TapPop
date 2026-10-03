import { Linking } from 'react-native';
import { PhantomWallet } from './phantomWallet';
import type { WalletClient } from './walletClient';

// Keep the encryption session in memory only. A cold restart requires reconnecting;
// late callbacks cannot reconstruct, sign or broadcast a payment.
const wallet = new PhantomWallet({
  open: async (url) => {
    if (!await Linking.canOpenURL('phantom://')) {
      throw new Error('Install Phantom on this iPhone and enable its Solana Devnet testnet mode, then reconnect.');
    }
    await Linking.openURL(url);
  },
  subscribe: (receive) => {
    const subscription = Linking.addEventListener('url', ({ url }) => receive(url));
    return () => subscription.remove();
  },
});

export async function withWallet<T>(action: (client: WalletClient) => Promise<T>): Promise<T> {
  return action(wallet);
}
