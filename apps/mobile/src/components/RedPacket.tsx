import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { devnetUsdc, explorerUrl, supportedAssets } from '../config';
import { formatAssetAmount, formatUnits } from '../amount';
import type { Asset } from '../assets';
import type { WalletSession } from '../signing';
import { signCheckout } from '../wallet';
import { paymentErrorMessage } from '../errors';
import { PACKET_PREFIX, packetLink, packetProgram, parsePacketLink } from '../redPacketCodec';
import { preparePacket, readPacket, verifyPacketProgram, type PacketView, type PreparedPacket, type PacketAction } from '../redPacket';
import { checkPacketPending, packetPendingFromSigned, submitPacket, type PacketOutcome } from '../redPacketPending';
import { loadRedPacket, saveRedPacket, type SavedPacket } from '../redPacketStorage';
import { PaymentQr, PaymentScanner } from './PaymentQr';

function Button({ text, onPress, disabled }: { text: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}>
    <Text style={styles.buttonText}>{text}</Text></Pressable>;
}
type Props = { session: WalletSession | null; updateSession: (session: WalletSession) => void; externalBlocked: boolean;
  onLockChange: (locked: boolean) => void; onBusyChange: (busy: boolean) => void };

export function RedPacket({ session, updateSession, externalBlocked, onLockChange, onBusyChange }: Props) {
  const [ready, setReady] = useState(false); const [attempt, setAttempt] = useState(0);
  const [record, setRecord] = useState<SavedPacket>({ version: 1, link: null, pending: null });
  const recordRef = useRef(record);
  const [view, setView] = useState<PacketView | null>(null);
  const [outcome, setOutcome] = useState<PacketOutcome>('pending');
  const [prepared, setPrepared] = useState<PreparedPacket | null>(null);
  const [busy, setBusy] = useState(false); const mutex = useRef(false);
  const [checking, setChecking] = useState(false); const checkingRef = useRef(false);
  const [error, setError] = useState(''); const [scan, setScan] = useState(false);
  const scanning = useRef(false);
  const [payload, setPayload] = useState(''); const [incoming, setIncoming] = useState<string | null>(null);
  const [asset, setAsset] = useState<Asset>(devnetUsdc); const [mode, setMode] = useState<0 | 1>(0);
  const [amount, setAmount] = useState('1'); const [count, setCount] = useState('5'); const [hours, setHours] = useState('24');
  let configurationError = '';
  try { packetProgram(); } catch (e) { configurationError = paymentErrorMessage(e); }
  const mounted = useRef(true);
  const sessionAddressRef = useRef(session?.address.toBase58());
  sessionAddressRef.current = session?.address.toBase58();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onLockChange(!ready || busy || !!prepared || !!record.pending); }, [ready, busy, prepared, record.pending, onLockChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { setView(null); }, [session?.address.toBase58()]);
  useEffect(() => {
    let cancelled = false;
    loadRedPacket().then((saved) => { if (!cancelled) { recordRef.current = saved; setRecord(saved); setReady(true); setError(''); } })
      .catch(() => { if (!cancelled) setError('Cannot recover red packet storage. Retry; do not clear app data before checking wallet activity.'); });
    return () => { cancelled = true; };
  }, [attempt]);
  async function persist(next: SavedPacket) {
    await saveRedPacket(next); recordRef.current = next; setRecord(next);
  }
  async function run(work: () => Promise<void>) {
    if (!ready || externalBlocked || mutex.current || checkingRef.current || configurationError) return;
    mutex.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(paymentErrorMessage(e)); }
    finally { mutex.current = false; setBusy(false); }
  }
  const refresh = useCallback(async () => {
    const current = recordRef.current;
    const viewer = session?.address.toBase58();
    if (!ready || !current.link || mutex.current || checkingRef.current || scanning.current || configurationError) return;
    checkingRef.current = true; setChecking(true);
    try {
      if (current.pending) {
        const next = await checkPacketPending(current.pending);
        if (mounted.current && recordRef.current === current) setOutcome((previous) => previous === 'pending' ? next : previous);
        // An unsuccessful/unconfirmed creation need not have an account yet.
        if (current.pending.action === 'create' && next !== 'confirmed') return;
      }
      const nextView = await readPacket(parsePacketLink(current.link, packetProgram()), session?.address);
      if (mounted.current && recordRef.current === current && viewer === sessionAddressRef.current) { setView(nextView); setError(''); }
    } catch (e) { if (mounted.current && recordRef.current === current) setError(paymentErrorMessage(e)); }
    finally { checkingRef.current = false; if (mounted.current) setChecking(false); }
  }, [ready, configurationError, session?.address.toBase58()]);
  useEffect(() => {
    if (!record.link || prepared) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [record.link, record.pending, prepared, refresh]);
  async function accept(text: string) {
    if (recordRef.current.pending || prepared) throw new Error('Finish the current transaction review before opening another packet.');
    const program = packetProgram(); const address = parsePacketLink(text, program);
    const next = await readPacket(address, session?.address);
    await persist({ version: 1, link: packetLink(program, address), pending: null });
    setView(next); setOutcome('pending'); setPayload('');
  }
  useEffect(() => {
    const receive = (url: string | null) => { if (url?.startsWith(PACKET_PREFIX)) setIncoming(url); };
    void Linking.getInitialURL().then(receive).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => receive(url));
    return () => sub.remove();
  }, []);
  async function reviewAction(action: Exclude<PacketAction, 'create'>) {
    if (!session || !recordRef.current.link || recordRef.current.pending) return;
    setPrepared(await preparePacket(session.address, { address: parsePacketLink(recordRef.current.link, packetProgram()), action }));
  }
  const disabled = !ready || !!configurationError || busy || checking || externalBlocked;
  const p = view?.packet;
  return <View style={styles.card}>
    <Text style={styles.title}>Token red packets</Text>
    <Text style={styles.text}>普通红包 · Equal shares / 拼手气 · Lucky shares. USDC or AAPLx-DEMO on Devnet. Demo tokens are not real equity or official xStocks.</Text>
    {!!configurationError && <Text style={styles.error}>{configurationError}</Text>}
    {!ready && <><Text style={styles.text}>Recovering red packet transactions…</Text><Button text="Retry recovery" onPress={() => setAttempt((n) => n + 1)} /></>}
    {incoming && <><Text style={styles.text}>A red packet link is ready to open. Opening never signs a transaction.</Text>
      <Button text="Open received packet" disabled={disabled || !!record.pending || !!prepared} onPress={() => void run(async () => { await accept(incoming); setIncoming((current) => current === incoming ? null : current); })} />
      <Button text="Dismiss link" disabled={busy} onPress={() => setIncoming(null)} /></>}
    {ready && !record.link && !prepared && <>
      <Text style={styles.label}>TOKEN</Text>
      {supportedAssets().map((a) => <Button key={a.mint.toBase58()} text={`${a.symbol}${a.display.kind === 'scaled' ? ` · ${a.mint.toBase58().slice(0, 8)}` : ''}${a.mint.equals(asset.mint) ? ' ✓' : ''}`} disabled={disabled} onPress={() => setAsset(a)} />)}
      <Button text={`普通红包 · Equal${mode === 0 ? ' ✓' : ''}`} disabled={disabled} onPress={() => setMode(0)} />
      <Button text={`拼手气红包 · Lucky${mode === 1 ? ' ✓' : ''}`} disabled={disabled} onPress={() => setMode(1)} />
      <Text style={styles.label}>TOTAL · {asset.symbol}</Text><TextInput accessibilityLabel="Red packet total" style={styles.input} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" editable={!disabled} />
      <Text style={styles.label}>SHARES · 1–1000</Text><TextInput accessibilityLabel="Red packet shares" style={styles.input} value={count} onChangeText={setCount} keyboardType="number-pad" editable={!disabled} />
      <Text style={styles.label}>EXPIRES IN HOURS · 1–168</Text><TextInput accessibilityLabel="Red packet expiry hours" style={styles.input} value={hours} onChangeText={setHours} keyboardType="number-pad" editable={!disabled} />
      <Text style={styles.text}>Creator pays creation fees and escrow rent. Claimants pay their own network/rent costs; lucky claims also pay VRF fees. Unfulfilled lucky claims may wait until one hour after expiry before a creator refund.</Text>
      <Button text="Review red packet" disabled={disabled || !session} onPress={() => void run(async () => {
        if (!session) return;
        if (!/^[1-9]\d{0,3}$/.test(count) || !/^[1-9]\d{0,2}$/.test(hours)) throw new Error('Enter whole numbers for shares and expiry.');
        setPrepared(await preparePacket(session.address, { create: { asset, mode, amount, count: Number(count), hours: Number(hours) } }));
      })} />
    </>}
    {prepared && <>
      <Text style={styles.title}>{prepared.title}</Text><Text style={styles.text}>{prepared.description}</Text>
      <Text selectable style={styles.address}>Token mint: {prepared.asset.mint.toBase58()}{'\n'}Wallet: {prepared.actor.toBase58()}</Text>
      <Text style={styles.text}>You pay · Devnet SOL{'\n'}Network fee: {formatUnits(prepared.networkFee, 9)}{'\n'}New account rent: {formatUnits(prepared.rent, 9)}{'\n'}VRF fee cap: {formatUnits(prepared.oracleFee, 9)}{'\n'}No service fee. Packet and claim account rent remains locked.</Text>
      <Button text="Confirm in wallet" disabled={disabled || !session} onPress={() => void run(async () => {
        if (!session || !session.address.equals(prepared.actor)) throw new Error('Wallet changed. Review again.');
        if (Date.now() - prepared.preparedAt > 60_000) throw new Error('Review expired. Cancel and refresh the fees before signing.');
        await verifyPacketProgram(prepared.program);
        const signed = await signCheckout(session, prepared.transaction, updateSession);
        const pending = packetPendingFromSigned(prepared, signed);
        await submitPacket(pending, async (saved) => {
          await persist({ version: 1, link: packetLink(prepared.program, prepared.packet), pending: saved });
          setOutcome('pending'); setPrepared(null); setView(null);
        });
      })} />
      <Button text="Cancel review" disabled={busy} onPress={() => setPrepared(null)} />
    </>}
    {record.pending && <>
      <Text style={styles.title}>{outcome === 'confirmed' ? 'Transaction confirmed ✓' : outcome === 'failed' ? 'Transaction failed' : outcome === 'expired' ? 'Transaction expired' : 'Checking transaction…'}</Text>
      <Text style={styles.text}>{record.pending.action === 'reserve_lucky' ? 'A confirmed reservation is not a token receipt. Refresh and complete the claim after VRF fulfillment.' : 'The saved signature is checked on Solana before another operation is allowed.'}</Text>
      <Button text="View transaction" disabled={busy} onPress={() => { void Linking.openURL(explorerUrl(record.pending!.signature)).catch((e) => setError(paymentErrorMessage(e))); }} />
      <Button text="Check transaction" disabled={busy || checking || !!configurationError} onPress={() => void refresh()} />
      {outcome !== 'pending' && <Button text="Continue" disabled={disabled} onPress={() => void run(async () => {
        await persist({ ...recordRef.current, pending: null }); setOutcome('pending');
      })} />}
    </>}
    {view && p && <>
      <Text style={styles.title}>{p.mode === 0 ? 'Equal red packet' : 'Lucky red packet'}</Text>
      <Text style={styles.text}>{formatAssetAmount(p.remaining, view.asset)} / {formatAssetAmount(p.total, view.asset)} {view.asset.symbol} remaining{'\n'}{p.claimedCount}/{p.maxClaims} claimed{'\n'}{p.status === 1 ? 'Fully claimed' : p.status === 2 ? 'Refunded / closed' : view.now >= p.expiresAt ? 'Expired' : `Expires ${new Date(p.expiresAt * 1000).toLocaleString()}`}</Text>
      <Text selectable style={styles.address}>Creator: {p.creator.toBase58()}{'\n'}Mint: {p.mint.toBase58()}</Text>
      {view.ownClaim && <Text style={styles.title}>{view.ownClaim.status === 1 ? `Received ${formatAssetAmount(view.ownClaim.amount, view.asset)} ${view.asset.symbol} ✓` : view.ownClaim.status === 0 ? 'Your claim is reserved' : 'Reservation cancelled by expiry refund'}</Text>}
      {view.pending && <Text style={styles.text}>{view.fulfilled ? 'Random result is ready. Anyone can pay to complete this claim for its reserved recipient.' : 'Waiting for VRF. Other claims wait until this reservation completes.'}</Text>}
      {!record.pending && !prepared && session && p.status === 0 && <>
        {!view.ownClaim && !view.pending && view.now < p.expiresAt && <Button text={p.mode === 1 && p.maxClaims - p.claimedCount > 1 ? 'Review lucky reservation' : 'Review claim'} disabled={disabled}
          onPress={() => void run(() => reviewAction(p.mode === 1 && p.maxClaims - p.claimedCount > 1 ? 'reserve_lucky' : 'claim'))} />}
        {view.pending && view.fulfilled && <Button text="Review claim completion" disabled={disabled} onPress={() => void run(() => reviewAction('settle_lucky'))} />}
        {p.creator.equals(session.address) && view.now >= p.expiresAt && (!view.pending || (!view.fulfilled && view.now >= p.expiresAt + 3600)) &&
          <Button text="Review refund" disabled={disabled} onPress={() => void run(() => reviewAction('refund'))} />}
      </>}
      {record.link && <><PaymentQr value={record.link} /><Text selectable style={styles.address}>{record.link}</Text>
        <Button text="Share packet link" disabled={busy} onPress={() => { void Share.share({ message: record.link! }).catch((e) => setError(paymentErrorMessage(e))); }} />
        <Text style={styles.text}>A second device must load the same supported demo mint first. Keep this link before closing or opening another packet; this device saves only the current packet.</Text></>}
    </>}
    {record.link && !prepared && <Button text={checking ? 'Refreshing…' : 'Refresh packet'} disabled={busy || checking || !!configurationError} onPress={() => void refresh()} />}
    {ready && !record.pending && !prepared && <>
      {record.link && <Button text="Close packet view" disabled={disabled} onPress={() => void run(async () => {
        await persist({ version: 1, link: null, pending: null }); setView(null); setOutcome('pending');
      })} />}
      <Button text="Scan red packet" disabled={disabled} onPress={() => { scanning.current = true; setScan(true); }} />
      <TextInput accessibilityLabel="Red packet link" style={styles.input} value={payload} onChangeText={setPayload} placeholder="Paste a red packet link" autoCapitalize="none" autoCorrect={false} editable={!disabled} />
      <Button text="Open packet link" disabled={disabled || !payload} onPress={() => void run(() => accept(payload))} />
    </>}
    {scan && <PaymentScanner onClose={() => { scanning.current = false; setScan(false); }} onScan={(text) => {
      scanning.current = false; setScan(false); setIncoming(text);
      void run(async () => { await accept(text); setIncoming((current) => current === text ? null : current); });
    }} />}
    {!!busy && <Text style={styles.text}>Working…</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', padding: 22, borderRadius: 24, gap: 14 },
  title: { fontSize: 22, fontWeight: '700', color: '#13382d' }, text: { fontSize: 14, color: '#5e7068', lineHeight: 22 },
  label: { color: '#526c60', fontSize: 12, fontWeight: '700' }, address: { fontSize: 12, lineHeight: 19, color: '#385548' },
  input: { backgroundColor: '#f3f6f3', borderRadius: 12, borderWidth: 1, borderColor: '#dce5de', padding: 15, fontSize: 16, color: '#13382d' },
  button: { backgroundColor: '#087f5b', borderRadius: 14, padding: 16, alignItems: 'center', minHeight: 52 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' }, disabled: { opacity: 0.4 },
  error: { backgroundColor: '#ffebe7', color: '#972e23', padding: 14, borderRadius: 12, lineHeight: 21 },
});
