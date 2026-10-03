import AsyncStorage from '@react-native-async-storage/async-storage';
import { decodeSavedPacket, type SavedPacket } from './redPacketPending';
export type { SavedPacket } from './redPacketPending';
const KEY = 'devnet-red-packet-v1';
export async function loadRedPacket(): Promise<SavedPacket> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw === null ? { version: 1, link: null, pending: null } : decodeSavedPacket(JSON.parse(raw));
}
export async function saveRedPacket(record: SavedPacket) {
  await AsyncStorage.setItem(KEY, JSON.stringify(decodeSavedPacket(record)));
}
