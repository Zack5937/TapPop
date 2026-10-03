import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodeDemoRecord, type DemoRecord } from './demoSettlement';
const KEY = 'devnet-demo-settlement-v1';
export async function loadDemoSettlement(): Promise<DemoRecord | null> {
  const text = await AsyncStorage.getItem(KEY);
  return text === null ? null : decodeDemoRecord(JSON.parse(text));
}
export async function saveDemoSettlement(record: DemoRecord): Promise<void> {
  const checked = decodeDemoRecord(record);
  await AsyncStorage.setItem(KEY, JSON.stringify(checked));
}
export async function clearDemoSettlement(): Promise<void> { await AsyncStorage.removeItem(KEY); }
