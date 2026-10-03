import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerDemoMint } from './config';
import { decodePending } from './pending';
import type { PendingPayment } from './payments';

const KEY = 'devnet-pending-payment-v1';

export async function loadPending() {
  const demo = await AsyncStorage.getItem('devnet-demo-mint-v1');
  if (demo !== null) registerDemoMint(demo);
  const raw = await AsyncStorage.getItem(KEY);
  // Only an absent key means no payment; empty/corrupt records must fail closed.
  return raw === null ? null : decodePending(raw);
}

export async function savePending(payment: PendingPayment) {
  await AsyncStorage.setItem(KEY, JSON.stringify(payment));
}

export async function clearPending() {
  await AsyncStorage.removeItem(KEY);
}

// Public mint address only. Its onchain program/extensions are revalidated on use.
export async function saveDemoMint(address: string) {
  await AsyncStorage.setItem('devnet-demo-mint-v1', address);
  return registerDemoMint(address);
}
