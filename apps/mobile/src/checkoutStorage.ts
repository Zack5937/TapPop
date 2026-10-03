import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodeCheckoutRecord } from './checkoutRecord';
import type { CheckoutRecord } from './checkout';
const KEY = 'devnet-checkout-v1';
export async function loadCheckout(): Promise<CheckoutRecord | null> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw === null ? null : decodeCheckoutRecord(raw);
}
export async function saveCheckout(record: CheckoutRecord): Promise<void> {
  decodeCheckoutRecord(JSON.stringify(record));
  await AsyncStorage.setItem(KEY, JSON.stringify(record));
}
export async function clearCheckout(): Promise<void> { await AsyncStorage.removeItem(KEY); }
