import { PhoneTap } from './PhoneTap';
import { useState } from 'react';
import { Linking, Platform, Pressable, Share, Text, View } from 'react-native';
import { prepareNfcRequest } from '../paymentLinks';

export function NfcRequest({ value, disabled }: { value: string; disabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  async function share() {
    if (working || disabled) return;
    setWorking(true); setError('');
    try {
      const request = prepareNfcRequest(value);
      await Share.share({ title: 'Tap Pay NFC receive link', message: request.uri });
    } catch (e) { setError(e instanceof Error ? e.message : 'Cannot prepare this NFC request.'); }
    finally { setWorking(false); }
  }
  let details: ReturnType<typeof prepareNfcRequest> | undefined;
  let invalid = '';
  if (expanded) {
    try { details = prepareNfcRequest(value); } catch (e) { invalid = e instanceof Error ? e.message : 'Invalid NFC request.'; }
  }
  if (Platform.OS !== 'android') return null;
  return <View style={{ gap: 10 }}>
    <PhoneTap value={value} disabled={disabled} />
    <Pressable accessibilityRole="button" disabled={disabled || working} onPress={() => { setExpanded((old) => !old); setError(''); }} style={{ padding: 14, borderRadius: 12, backgroundColor: '#eaf4ef' }}>
      <Text style={{ color: '#087f5b', textAlign: 'center', fontWeight: '700' }}>Prepare NFC tag</Text>
    </Pressable>
    {expanded && details && <>
      <Text style={{ color: '#526c60', lineHeight: 22 }}>Use an NFC tag writer to save this full link as the first NDEF URI / URL record, not a text record. Then customers unlock their Android phone and tap the tag to review payment.</Text>
      <Text style={{ color: '#526c60', lineHeight: 22 }}>{details.permanent ? 'This merchant link has no expiry. Customers enter the amount.' : 'This request expires. Rewrite the tag for each new request.'} Required NDEF message space: {details.ndefBytes} bytes, plus tag formatting overhead. Check the writer’s capacity report.</Text>
      <Text selectable accessibilityLabel="NFC tag receive link" style={{ color: '#385548', fontSize: 10 }}>{details.uri}</Text>
      <Pressable accessibilityRole="button" disabled={disabled || working} onPress={() => void share()} style={{ padding: 14, borderRadius: 12, backgroundColor: '#087f5b' }}>
        <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700' }}>Share tag link</Text>
      </Pressable>
      <Text style={{ color: '#526c60', lineHeight: 22 }}>A tap only opens the request. Wallet confirmation is still required. Tag writing uses an external tool. For phone-to-phone transfer, use Send to nearby phone; QR remains available.</Text>
    </>}
    {!!(invalid || error) && <Text accessibilityRole="alert" style={{ color: '#972e23' }}>{invalid || error}</Text>}
  </View>;
}

export function NfcHint({ disabled }: { disabled: boolean }) {
  const [error, setError] = useState('');
  if (Platform.OS !== 'android') return <Text style={{ color: '#526c60', lineHeight: 22 }}>Scan a payment QR code on this iPhone. NFC phone tap is available on Android only.</Text>;
  return <View style={{ gap: 8 }}>
    <Text style={{ color: '#526c60', lineHeight: 22 }}>Or unlock your Android phone and tap a Tap Pay NFC tag. It opens the same payment review; if your phone has no NFC, scan the QR.</Text>
    <Pressable accessibilityRole="button" disabled={disabled} onPress={() => {
      setError(''); void Linking.sendIntent('android.settings.NFC_SETTINGS').catch(() => setError('NFC settings are unavailable. Enable NFC in system settings if supported, or use QR.'));
    }} style={{ padding: 12 }}><Text style={{ color: '#087f5b', fontWeight: '700' }}>Open NFC settings</Text></Pressable>
    {!!error && <Text accessibilityRole="alert" style={{ color: '#972e23' }}>{error}</Text>}
  </View>;
}
