import { useEffect, useRef, useState } from 'react';
import { AppState, Modal, NativeModules, Platform, Pressable, Text, View } from 'react-native';
import { Buffer } from 'buffer';
import { phoneTapPayload } from '../phoneTapPayload';

type Bridge = {
  capabilities(): Promise<{ supported: boolean; enabled: boolean; hce: boolean }>;
  advertise(id: string, text: string): Promise<void>;
  read(id: string): Promise<string>;
  stop(id: string): Promise<void>;
};
function bridge(): Bridge {
  if (Platform.OS !== 'android' || !NativeModules.PhoneTap) throw new Error('Phone tap requires the updated Android APK. Use QR on this device.');
  return NativeModules.PhoneTap as Bridge;
}

type Props = { value?: string; disabled: boolean; onReceive?: (text: string) => void; onReadingChange?: (reading: boolean) => void };
export function PhoneTap({ value, disabled, onReceive, onReadingChange }: Props) {
  const [active, setActive] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const current = useRef<string | null>(null); const mounted = useRef(true); const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const receive = useRef(onReceive); receive.current = onReceive;
  const readingChange = useRef(onReadingChange); readingChange.current = onReadingChange;
  const sending = value !== undefined;
  function stop(note = '') {
    const id = current.current;
    if (!id) return;
    current.current = null;
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    if (!sending) readingChange.current?.(false);
    if (id) { try { void bridge().stop(id).catch(() => {}); } catch { /* Old APK fallback. */ } }
    if (mounted.current) { setActive(false); if (note) setError(note); }
  }
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') stop('Phone tap stopped when the app left the foreground.'); });
    return () => { mounted.current = false; stop(); subscription.remove(); };
  }, []);
  useEffect(() => { if (current.current) stop('Payment changed. Start a new phone tap.'); }, [value]);
  async function start() {
    if (disabled || current.current) return;
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
    current.current = id; setError(''); setActive(true); setMessage('Checking NFC…');
    if (!sending) readingChange.current?.(true);
    try {
      const native = bridge(); const capability = await native.capabilities();
      if (current.current !== id) return;
      if (!capability.supported) throw new Error('This phone has no NFC. Use QR instead.');
      if (!capability.enabled) throw new Error('Turn on NFC in system settings and retry.');
      if (sending && !capability.hce) throw new Error('This phone cannot send through NFC card emulation. Use QR instead.');
      timer.current = setTimeout(() => stop('Phone tap timed out. Start again to retry.'), 60000);
      if (sending) {
        await native.advertise(id, phoneTapPayload(value!));
        if (current.current === id) setMessage('Ready to send. On the other phone, open the matching payment section and choose Read nearby phone. Hold the NFC antennas together.');
      } else {
        setMessage('On the other phone choose Send to nearby phone. Keep both apps open and hold the NFC antennas together until this screen closes.');
        const text = await native.read(id);
        if (current.current !== id) return;
        const checked = phoneTapPayload(text);
        stop(); receive.current?.(checked);
      }
    } catch (e) {
      if (current.current === id) stop(e instanceof Error ? e.message : 'Phone tap failed. Retry or use QR.');
    }
  }
  if (Platform.OS !== 'android') return null;
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" disabled={disabled || active} onPress={() => void start()} style={{ padding: 15, borderRadius: 12, backgroundColor: '#eaf4ef', opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: '#087f5b', textAlign: 'center', fontWeight: '700' }}>{sending ? 'Send to nearby phone' : 'Read nearby phone'}</Text>
    </Pressable>
    {!!error && <Text accessibilityRole="alert" style={{ color: '#972e23' }}>{error}</Text>}
    <Modal visible={active} animationType="slide" onRequestClose={() => stop()}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 28, gap: 24, backgroundColor: '#f1f7f4' }}>
        <Text style={{ fontSize: 28, fontWeight: '700', color: '#13382d' }}>Phone to phone</Text>
        <Text style={{ color: '#385548', lineHeight: 26 }}>{message}</Text>
        <Text style={{ color: '#526c60', lineHeight: 24 }}>Sharing payment data only. No new signature or payment happens on a tap. Both phones must stay unlocked. This session stops after one minute or when you leave the app.</Text>
        <Pressable accessibilityRole="button" onPress={() => stop()} style={{ padding: 18, backgroundColor: '#087f5b', borderRadius: 14 }}>
          <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700' }}>Stop phone tap</Text>
        </Pressable>
      </View>
    </Modal>
  </View>;
}
