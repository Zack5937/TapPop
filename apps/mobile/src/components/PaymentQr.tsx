import { useMemo, useRef } from 'react';
import { Linking, Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { create } from 'qrcode/lib/core/qrcode';

export function PaymentQr({ value }: { value: string }) {
  const width = Math.min(useWindowDimensions().width - 80, 400);
  const qr = useMemo(() => {
    const matrix = create(value, { errorCorrectionLevel: 'M' }).modules;
    let path = '';
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) if (matrix.get(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
    }
    return { path, size: matrix.size + 8 };
  }, [value]);
  return <View accessible accessibilityLabel="Payment QR code" style={{ alignSelf: 'center', backgroundColor: '#fff' }}>
    <Svg width={width} height={width} viewBox={`0 0 ${qr.size} ${qr.size}`}>
      <Rect width={qr.size} height={qr.size} fill="#fff" /><Path d={qr.path} fill="#000" />
    </Svg>
  </View>;
}

export function PaymentScanner({ onScan, onClose }: { onScan: (value: string) => void; onClose: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <View style={{ flex: 1, backgroundColor: '#13382d', padding: 24, paddingTop: 50, gap: 20 }}>
      <Text style={{ color: '#fff', fontSize: 22 }}>Scan a Tap Pay QR code</Text>
      {permission?.granted ? <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => { if (!scanned.current) { scanned.current = true; onScan(data); } }} />
        : <Pressable accessibilityRole="button" onPress={() => {
          if (permission?.canAskAgain === false) void Linking.openSettings(); else void requestPermission();
        }} style={{ padding: 20, backgroundColor: '#087f5b' }}>
          <Text style={{ color: '#fff' }}>{permission?.canAskAgain === false ? 'Open settings to allow camera' : 'Allow camera to scan QR codes'}</Text>
        </Pressable>}
      <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 20 }}><Text style={{ color: '#fff' }}>Cancel</Text></Pressable>
    </View>
  </Modal>;
}
