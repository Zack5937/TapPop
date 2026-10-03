import { RedPacket } from './src/components/RedPacket';
import { DemoSettlement } from './src/components/DemoSettlement';
import { Checkout } from './src/components/Checkout';
import { useEffect, useReducer, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { formatUnits, formatAssetAmount, parseAssetAmount } from './src/amount';
import { devnetUsdc, explorerUrl, getConfiguredAsset, supportedAssets } from './src/config';
import { checkSettlement, readBalances, recipientKey, type PendingPayment } from './src/payments';
import { initialPaymentState, paymentReducer } from './src/paymentState';
import { paymentErrorMessage } from './src/errors';
import { clearPending, loadPending, savePending, saveDemoMint } from './src/storage';
import { watchSettlement } from './src/settlementWatch';
import { connectWallet, disconnectWallet, sendAsset, createDemoAsset, type WalletSession } from './src/wallet';

import type { Asset } from './src/assets';
import { readDemoMint } from './src/demoAsset';
import { connection, verifyNetwork } from './src/payments';
import { PublicKey } from '@solana/web3.js';

function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, (disabled || pressed) && styles.dim]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text>
  </Pressable>;
}

export default function App() {
  const [packetLocked, setPacketLocked] = useState(true);
  const [packetBusy, setPacketBusy] = useState(false);
  const [demoLocked, setDemoLocked] = useState(true);
  const [demoBusy, setDemoBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutLocked, setCheckoutLocked] = useState(true);
  const [paymentAsset, setPaymentAsset] = useState<Asset>(devnetUsdc);
  const [demoAddress, setDemoAddress] = useState('');
  const [setupNotice, setSetupNotice] = useState('');
  const [assetRevision, setAssetRevision] = useState(0);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [balances, setBalances] = useState<Awaited<ReturnType<typeof readBalances>> | null>(null);
  const [receiver, setReceiver] = useState('');
  const [amount, setAmount] = useState('1');
  const [review, setReview] = useState<{ receiver: string; amount: string } | null>(null);
  const [{ payment: pending, settlement }, dispatchPayment] = useReducer(paymentReducer, initialPaymentState);
  const [ready, setReady] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [recoveryError, setRecoveryError] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const lock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setRecoveryError(false);
    loadPending().then((payment) => {
      if (!cancelled) { dispatchPayment({ type: 'restore', payment }); setAssetRevision((r) => r + 1); setReady(true); }
    }).catch(() => {
      if (!cancelled) setRecoveryError(true);
    });
    return () => { cancelled = true; };
  }, [recoveryAttempt]);

  useEffect(() => {
    setStatusError('');
    if (!pending || settlement !== 'pending') return;
    const watcher = watchSettlement(pending, (result) => {
      setStatusError('');
      dispatchPayment({ type: 'status', signature: pending.signature, settlement: result });
    }, () => setStatusError('Unable to check Solana right now. Your payment is saved; we will keep checking. Do not send it again.'));
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void watcher.checkNow();
    });
    return () => { watcher.stop(); subscription.remove(); };
  }, [pending, settlement]);

  useEffect(() => {
    if (settlement !== 'confirmed' || !session) return;
    let cancelled = false;
    setBalances(null);
    readBalances(session.address, connection, paymentAsset).then((value) => {
      if (!cancelled) setBalances(value);
    }).catch(() => {
      if (!cancelled) setError('Payment confirmed. Balance refresh failed; tap Refresh balance.');
    });
    return () => { cancelled = true; };
  }, [settlement, session, paymentAsset]);

  async function run(label: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError('');
    try { await action(); }
    catch (e) { setError(paymentErrorMessage(e)); }
    finally { lock.current = false; setBusy(''); }
  }

  async function refresh(wallet: WalletSession) {
    setBalances(null);
    setBalances(await readBalances(wallet.address, connection, paymentAsset));
  }

  async function check(payment: PendingPayment) {
    const result = await checkSettlement(payment);
    setStatusError('');
    dispatchPayment({ type: 'status', signature: payment.signature, settlement: result });
  }

  async function rememberDemo(address: string) {
    const asset = await saveDemoMint(address);
    setPaymentAsset(asset); setBalances(null); setReview(null);
    setDemoAddress(address); setAssetRevision((r) => r + 1);
  }

  const disabled = !!busy || !ready;
  const pendingAsset = pending ? getConfiguredAsset(pending.mint, pending.tokenProgram) : paymentAsset;
  return <SafeAreaProvider><SafeAreaView style={styles.screen}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.header}><Text style={styles.brand}>tap pay</Text><Text style={styles.badge}>DEVNET</Text></View>
      <Text style={styles.heading}>Payments, made simple.</Text>
      <Text style={styles.subtitle}>Test {paymentAsset.symbol}. Your wallet stays in control.</Text>
      {Platform.OS === 'ios' && <Text style={styles.muted}>Use Phantom with Solana Devnet testnet mode enabled. Approve each signature in Phantom, then return here. Reconnect after restarting the app. Use QR for payment requests and signature exchange.</Text>}

      {!ready && <View style={styles.card}>
        <Text style={styles.section}>Recovering payment</Text>
        <Text accessibilityRole={recoveryError ? 'alert' : 'text'} style={styles.muted}>{recoveryError
          ? 'Cannot read the saved payment. Sending stays blocked to avoid a duplicate. Retry after checking device storage. Do not clear app data before checking your wallet activity.'
          : 'Checking this device for an unfinished payment before enabling sending…'}</Text>
        {recoveryError ? <Button label="Retry recovery" onPress={() => {
          setRecoveryError(false); setRecoveryAttempt((attempt) => attempt + 1);
        }} /> : <ActivityIndicator color="#087f5b" />}
      </View>}

      <Checkout session={session} updateSession={setSession} externalBlocked={!!busy || !ready || !!pending || demoLocked || packetLocked} onLockChange={setCheckoutLocked} onBusyChange={setCheckoutBusy} />
      <DemoSettlement session={session} updateSession={setSession} externalBlocked={!!busy || !ready || !!pending || checkoutLocked || packetLocked} onLockChange={setDemoLocked} onBusyChange={setDemoBusy} />
      <RedPacket session={session} updateSession={setSession} externalBlocked={!!busy || !ready || !!pending || checkoutLocked || demoLocked} onLockChange={setPacketLocked} onBusyChange={setPacketBusy} />
      <View style={styles.card} key={`assets-${assetRevision}`}>
        <Text style={styles.section}>Choose asset</Text>
        {supportedAssets().map((asset) => <Button key={asset.mint.toBase58()}
          label={`${asset.symbol}${asset.display.kind === 'scaled' ? ` · ${asset.mint.toBase58().slice(0, 6)}` : ''}${asset.mint.equals(paymentAsset.mint) ? ' ✓' : ''}`}
          secondary disabled={disabled || !!pending || checkoutLocked || demoLocked || packetLocked} onPress={() => void run('Loading asset…', async () => {
            if (asset.display.kind === 'scaled') await saveDemoMint(asset.mint.toBase58());
            setPaymentAsset(asset); setBalances(null); setReview(null);
            if (session) setBalances(await readBalances(session.address, connection, asset));
          })} />)}
        {paymentAsset.display.kind === 'scaled' && <>
          <Text style={styles.muted}>Devnet demo asset · Not backed by real equity. Immutable display multiplier: ×2.</Text>
          <Text selectable style={styles.address}>{paymentAsset.mint.toBase58()}</Text>
        </>}
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>AVAILABLE {paymentAsset.symbol}</Text>
        <Text style={styles.balance}>{balances ? formatAssetAmount(balances.token, paymentAsset) : '—'} <Text style={styles.currency}>{paymentAsset.symbol}</Text></Text>
        <Text style={styles.muted}>Network fees · {balances ? formatUnits(balances.sol, 9) : '—'} SOL</Text>
        {session ? <>
          <Text selectable style={styles.address}>{session.address.toBase58()}</Text>
          <Button label="Refresh balance" secondary disabled={disabled} onPress={() => void run('Refreshing…', () => refresh(session))} />
          <Button label="Disconnect wallet" secondary disabled={disabled || !!pending || checkoutBusy || demoBusy || packetBusy} onPress={() => void run('Disconnecting…', async () => {
            try {
              await disconnectWallet(session);
            } catch {
              throw new Error('Disconnected locally. Wallet permission could not be revoked; manage this app’s access in your wallet.');
            } finally {
              // A failed/expired remote authorization must not trap the UI in
              // a session that cannot reconnect. No token survives this reset.
              setSession(null); setBalances(null); setReview(null);
            }
          })} />
        </> : <Button label="Connect wallet" disabled={disabled || checkoutBusy || demoBusy || packetBusy} onPress={() => void run('Opening wallet…', async () => {
          const wallet = await connectWallet(); setSession(wallet); await refresh(wallet);
        })} />}
      </View>

      {pending ? <View style={styles.card}>
        <Text style={styles.section}>{settlement === 'confirmed' ? 'Paid ✓' : settlement === 'failed' ? 'Payment failed' : settlement === 'expired' ? 'Payment expired' : 'Checking payment'}</Text>
        <Text style={styles.balance}>{pending.amount} <Text style={styles.currency}>{pendingAsset.symbol}</Text></Text>
        <Text style={styles.label}>TO</Text><Text selectable style={styles.address}>{pending.receiver}</Text>
        <Text style={styles.muted}>{settlement === 'confirmed' ? 'Confirmed on Solana Devnet.' : settlement === 'failed' ? 'Solana confirmed that the transaction failed.' : settlement === 'expired' ? 'The transaction expired without confirmation.' : 'Confirmation may take a moment. Check the existing payment before sending again.'}</Text>
        {!!statusError && <Text accessibilityRole="alert" style={styles.error}>{statusError}</Text>}
        <Button label="Check payment status" disabled={disabled} onPress={() => void run('Checking Solana…', () => check(pending))} />
        <Button label="View transaction details" secondary onPress={() => void run('Opening details…', async () => { await Linking.openURL(explorerUrl(pending.signature)); })} disabled={disabled} />
        {settlement !== 'pending' && <Button label="Done" secondary disabled={disabled} onPress={() => void run('Finishing…', async () => {
          await clearPending(); dispatchPayment({ type: 'clear', signature: pending.signature }); setReview(null);
        })} />}
      </View> : <View style={styles.card}>
        <Text style={styles.section}>Send {paymentAsset.symbol}</Text>
        {review ? <>
          <Text style={styles.label}>YOU ARE SENDING</Text>
          <Text style={styles.balance}>{review.amount} <Text style={styles.currency}>{paymentAsset.symbol}</Text></Text>
          <Text style={styles.label}>TO WALLET</Text><Text selectable style={styles.address}>{review.receiver}</Text>
          <Text style={styles.muted}>Devnet only. The wallet will show the transaction and network fee for your approval. A new receiving token account may require SOL rent.</Text>
          <Button label="Confirm in wallet" disabled={disabled || !session || checkoutLocked || demoLocked || packetLocked} onPress={() => void run('Confirm in your wallet…', async () => {
            if (!session) return;
            const payment = await sendAsset(session, review.receiver, review.amount, async (p) => {
              await savePending(p); dispatchPayment({ type: 'save', payment: p });
            }, setSession, paymentAsset);
            await check(payment);
          })} />
          <Button label="Edit payment" secondary disabled={disabled} onPress={() => setReview(null)} />
        </> : <>
          <Text style={styles.label}>RECEIVING WALLET</Text>
          <TextInput accessibilityLabel="Receiving wallet address" style={styles.input} value={receiver} onChangeText={setReceiver}
            placeholder="Paste a Solana wallet address" placeholderTextColor="#7a8480" autoCapitalize="none" autoCorrect={false} editable={!disabled} />
          <Text style={styles.label}>AMOUNT · {paymentAsset.symbol}</Text>
          <TextInput accessibilityLabel={`${paymentAsset.symbol} amount`} style={styles.input} value={amount} onChangeText={setAmount}
            keyboardType="decimal-pad" editable={!disabled} />
          <Button label="Review payment" disabled={disabled || !session || checkoutLocked || demoLocked || packetLocked} onPress={() => void run('Reviewing…', async () => {
            if (!session) return;
            const key = recipientKey(receiver, session.address);
            const units = parseAssetAmount(amount, paymentAsset);
            setReview({ receiver: key.toBase58(), amount: formatAssetAmount(units, paymentAsset) });
          })} />
        </>}
      </View>}
      {!pending && <View style={styles.card}>
        <Text style={styles.section}>AAPLx-DEMO setup</Text>
        <Text style={styles.muted}>Create 1,000 demo tokens with your wallet. Requires Devnet SOL for fees and account rent. Not backed by real equity; not official xStocks. Each wallet creates one fixed supply.</Text>
        <Button label="Create demo asset in wallet" disabled={disabled || !session || checkoutLocked || demoLocked || packetLocked} onPress={() => void run('Creating demo asset…', async () => {
          if (!session) return;
          await createDemoAsset(session, rememberDemo, setSession);
          setSetupNotice('Demo mint submitted or already exists. Tap Refresh balance after confirmation. If the network timed out, retry creation with the same wallet to recover the same mint.');
        })} />
        {!!setupNotice && <Text style={styles.muted}>{setupNotice}</Text>}
        <Text style={styles.muted}>On a second device, paste the first device’s demo mint address to use the same asset.</Text>
        <TextInput accessibilityLabel="Demo mint address" style={styles.input} value={demoAddress} onChangeText={setDemoAddress}
          placeholder="Demo mint address" autoCapitalize="none" autoCorrect={false} editable={!disabled} />
        <Button label="Load demo asset" secondary disabled={disabled || checkoutLocked || demoLocked || packetLocked} onPress={() => void run('Checking demo asset…', async () => {
          await verifyNetwork(connection);
          const asset = await readDemoMint(new PublicKey(demoAddress.trim()), connection);
          await rememberDemo(asset.mint.toBase58());
          if (session) setBalances(await readBalances(session.address, connection, asset));
        })} />
      </View>}
      {!!busy && <View style={styles.progress}><ActivityIndicator color="#087f5b" /><Text style={styles.muted}>{busy}</Text></View>}
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Text style={styles.footer}>No centralized payment server.{ '\n' }Payments settle on Solana. Devnet tokens have no monetary value.</Text>
    </ScrollView>
  </SafeAreaView></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f3f6f3' },
  content: { padding: 24, gap: 16, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  brand: { fontSize: 28, fontWeight: '800', color: '#13382d' },
  badge: { color: '#087f5b', fontWeight: '700', fontSize: 12, backgroundColor: '#d9f1e4', padding: 8, borderRadius: 10 },
  heading: { color: '#13382d', fontSize: 36, fontWeight: '700', marginTop: 16 },
  subtitle: { color: '#5e7068', fontSize: 16, marginBottom: 4 },
  card: { backgroundColor: '#fff', padding: 22, borderRadius: 24, gap: 14 },
  label: { color: '#526c60', fontSize: 11, letterSpacing: 1.4, fontWeight: '700' },
  balance: { fontSize: 36, fontWeight: '700', color: '#13382d' },
  currency: { fontSize: 17, fontWeight: '500' },
  muted: { fontSize: 14, color: '#5e7068', lineHeight: 22, flexShrink: 1 },
  address: { fontSize: 13, color: '#385548', lineHeight: 21 },
  section: { fontSize: 22, fontWeight: '700', color: '#13382d' },
  input: { backgroundColor: '#f3f6f3', borderRadius: 12, borderWidth: 1, borderColor: '#dce5de', padding: 15, fontSize: 16, color: '#13382d' },
  button: { backgroundColor: '#087f5b', borderRadius: 14, padding: 16, alignItems: 'center', minHeight: 52 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondary: { backgroundColor: '#edf5f0' },
  secondaryText: { color: '#176047' },
  dim: { opacity: 0.45 },
  progress: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  error: { backgroundColor: '#ffebe7', color: '#972e23', padding: 16, borderRadius: 12, lineHeight: 22 },
  footer: { textAlign: 'center', color: '#687b70', fontSize: 12, lineHeight: 20 },
});
