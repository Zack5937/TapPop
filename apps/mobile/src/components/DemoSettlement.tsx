import { PhoneTap } from './PhoneTap';
import { paymentLinkTarget } from '../paymentLinks';
import { NfcRequest } from './NfcRequest';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { PublicKey } from '@solana/web3.js';
import { supportedAssets, explorerUrl } from '../config';
import { formatUnits } from '../amount';
import { signCheckout } from '../wallet';
import type { WalletSession } from '../signing';
import { paymentErrorMessage } from '../errors';
import { createDemoRequest, checkDemoAssets, demoQuote, prepareDemoExchange, reviewDemoExchange,
  exchangeFromTransaction, inspectDemoExchange, mergeDemoExchange, validateDemoRequest,
  encodeDemoRecord, decodeDemoText, broadcastDemoExchange, observeDemoSettlement,
  type DemoRecord } from '../demoSettlement';
import { loadDemoSettlement, saveDemoSettlement, clearDemoSettlement } from '../demoSettlementStorage';
import { settlementFrames, SettlementCollector } from '../settlementTransport';
import { PaymentQr, PaymentScanner } from './PaymentQr';

function Button({ text, onPress, disabled }: { text: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={[styles.button, disabled && { opacity: 0.4 }]}><Text style={styles.buttonText}>{text}</Text></Pressable>;
}

type Props = { session: WalletSession | null; updateSession: (value: WalletSession) => void;
  externalBlocked: boolean; onLockChange: (value: boolean) => void; onBusyChange: (value: boolean) => void };
export function DemoSettlement({ session, updateSession, externalBlocked, onLockChange, onBusyChange }: Props) {
  const [record, setRecord] = useState<DemoRecord | null>(null);
  const recordRef = useRef<DemoRecord | null>(null);
  const [ready, setReady] = useState(false); const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false); const mutex = useRef(false);
  const [checking, setChecking] = useState(false); const queryLock = useRef(false);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('5'); const [liquidity, setLiquidity] = useState(''); const [mint, setMint] = useState('');
  const [form, setForm] = useState(false); const [payload, setPayload] = useState('');
  const [scan, setScan] = useState(false); const scanLock = useRef(false);
  const collector = useRef(new SettlementCollector()); const [parts, setParts] = useState('');
  const [frame, setFrame] = useState(0); const [link, setLink] = useState<string | null>(null);
  const [costs, setCosts] = useState<{ networkFee: number; accountRent: number } | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof observeDemoSettlement>>>({ state: 'pending' });
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof prepareDemoExchange>> | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onLockChange(!ready || !!record || busy); }, [ready, record, busy, onLockChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    let cancelled = false;
    loadDemoSettlement().then((saved) => { if (!cancelled) { recordRef.current = saved; setRecord(saved); setReady(true); setError(''); } })
      .catch(() => { if (!cancelled) setError('Cannot recover saved demo settlement. Do not clear app data before checking wallet activity.'); });
    return () => { cancelled = true; };
  }, [attempt]);
  async function persist(next: DemoRecord) { await saveDemoSettlement(next); recordRef.current = next; setRecord(next); setFrame(0); }
  async function run(work: () => Promise<void>) {
    if (!ready || externalBlocked || mutex.current || queryLock.current) return;
    mutex.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(paymentErrorMessage(e)); }
    finally { mutex.current = false; setBusy(false); }
  }
  const check = useCallback(async () => {
    const current = recordRef.current;
    if (!current || mutex.current || queryLock.current || scanLock.current || externalBlocked) return;
    queryLock.current = true; setChecking(true);
    try {
      const observed = await observeDemoSettlement(current);
      if (mounted.current && recordRef.current === current) setResult((old) => old.state === 'pending' ? observed : old);
    } catch (e) { if (mounted.current && recordRef.current === current) setError(paymentErrorMessage(e)); }
    finally { queryLock.current = false; if (mounted.current) setChecking(false); }
  }, [externalBlocked]);
  useEffect(() => {
    if (!record || result.state !== 'pending') return;
    void check(); const timer = setInterval(() => void check(), 5000);
    const subscription = AppState.addEventListener('change', (s) => { if (s === 'active') void check(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [record, result.state, check]);
  async function accept(text: string) {
    const assembled = collector.current.accept(text);
    setParts(`${assembled.received}/${assembled.total} QR parts scanned`);
    if (!assembled.text) return;
    const next = decodeDemoText(assembled.text);
    validateDemoRequest(next.request);
    await checkDemoAssets(next.request);
    const current = recordRef.current;
    if (current && JSON.stringify(current.request) !== JSON.stringify(next.request)) throw new Error('Finish the current settlement before opening another request.');
    if (current?.exchange && !next.exchange) throw new Error('Keep the saved authorization. Scan the next signed exchange.');
    if (next.exchange) {
      if (current?.exchange) next.exchange = mergeDemoExchange(current.exchange, next.exchange);
      setCosts(await reviewDemoExchange(next.exchange));
    }
    await persist(next); setPrepared(null); setResult({ state: 'pending' });
  }
  const acceptRef = useRef(accept); acceptRef.current = accept;
  const runRef = useRef(run); runRef.current = run;
  useEffect(() => {
    const receive = (url: string | null) => { if (url && paymentLinkTarget(url) === 'demo') setLink(url); };
    void Linking.getInitialURL().then(receive);
    const listener = Linking.addEventListener('url', ({ url }) => receive(url));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!link || !ready || busy || checking || externalBlocked) return;
    const next = link; setLink(null); void runRef.current(() => acceptRef.current(next));
  }, [link, ready, busy, checking, externalBlocked]);
  const text = record ? encodeDemoRecord(record) : '';
  const frames = useMemo(() => text ? settlementFrames(text) : [], [text]);
  const disabled = !ready || busy || checking || externalBlocked;
  const request = record?.request; const quote = request ? demoQuote(request) : null;
  const tx = record?.exchange ? inspectDemoExchange(record.exchange) : null;
  const ownSignature = session && tx?.signatures.find((s) => s.publicKey.equals(session.address));
  const openScanner = () => { scanLock.current = true; setScan(true); };
  const closeScanner = () => { scanLock.current = false; setScan(false); };
  return <View style={styles.card}>
    <Text style={styles.title}>Pay with demo stock</Text>
    <Text style={styles.text}>Devnet demo · Not real equity or xStocks. Customer pays AAPLx-DEMO; a separate demo liquidity wallet pays USDC to the merchant. All required wallets confirm the same atomic transaction.</Text>
    {!ready ? <><Text style={styles.text}>Recovering demo settlement…</Text><Button text="Retry recovery" onPress={() => setAttempt((n) => n + 1)} /></> : <>
      {!record && <>
        <Button text="Create stock-funded USDC request" disabled={disabled || !session} onPress={() => setForm(true)} />
        {form && <>
          <Text style={styles.text}>USDC to receive</Text><TextInput accessibilityLabel="Demo settlement USDC amount" style={styles.input} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" editable={!disabled} />
          <Text style={styles.text}>Demo liquidity wallet (supplies USDC; must sign each exchange)</Text>
          <TextInput accessibilityLabel="Demo liquidity wallet" style={styles.input} value={liquidity} onChangeText={setLiquidity} autoCapitalize="none" autoCorrect={false} editable={!disabled} />
          <Text style={styles.text}>Choose the customer's funding token. Load an M1 demo mint below if none is listed.</Text>
          {supportedAssets().filter((a) => a.display.kind === 'scaled').map((a) => <Button key={a.mint.toBase58()} text={`AAPLx-DEMO · ${a.mint.toBase58().slice(0, 8)}${mint === a.mint.toBase58() ? ' ✓' : ''}`} disabled={disabled} onPress={() => setMint(a.mint.toBase58())} />)}
          <Text style={styles.text}>Merchant pays network fees and new account rent. No conversion/service fee; fixed demo rate only.</Text>
          <Button text="Show demo settlement request" disabled={disabled || !session || !mint} onPress={() => void run(async () => {
            if (!session) return;
            const next = createDemoRequest(session.address, liquidity, mint, amount);
            await checkDemoAssets(next); await persist({ request: next }); setResult({ state: 'pending' });
          })} />
        </>}
      </>}
      {request && quote && <>
        <Text style={styles.title}>{result.state === 'confirmed' ? 'Paid ✓' : result.state === 'failed' ? 'Settlement failed' : result.state === 'expired' ? 'Authorization expired' : 'Review demo settlement'}</Text>
        <Text style={styles.title}>Merchant receives {request.intent.settlementAmount} USDC</Text>
        <Text style={styles.text}>Customer pays {quote.fundingAmount} AAPLx-DEMO{ '\n' }{quote.label}{ '\n' }Customer gas: {request.intent.networkFeePolicy === 'RECEIVER' ? '0 SOL · merchant pays' : 'customer pays'}</Text>
        <Text selectable style={styles.address}>Merchant: {request.intent.receiver}{ '\n' }Liquidity wallet: {request.liquidity}{ '\n' }Funding mint: {request.fundingMint}</Text>
        {record?.exchange && <Text selectable style={styles.address}>Customer: {record.exchange.customer}{ '\n' }Signatures: {tx?.signatures.filter((s) => s.signature).length}/{tx?.signatures.length}</Text>}
        {result.state === 'pending' && <>
          <PaymentQr value={frames[Math.min(frame, frames.length - 1)]!} />
          {!record?.exchange ? <NfcRequest value={text} disabled={disabled} /> : <PhoneTap value={text} disabled={disabled} />}
          <Text style={styles.text}>Scan all {frames.length} QR parts on the next wallet's device. Request → customer signs → merchant signs → liquidity wallet signs and broadcasts. Each signer must review the parties, amounts and costs.</Text>
          {frames.length > 1 && <Button text={`QR ${frame + 1}/${frames.length} · Next part`} disabled={disabled} onPress={() => setFrame((n) => (n + 1) % frames.length)} />}
          <Text selectable style={styles.payload}>{text}</Text>
          {!record?.exchange && session && ![request.intent.receiver, request.liquidity].includes(session.address.toBase58()) && <>
            <Button text="Review AAPLx-DEMO payment" disabled={disabled} onPress={() => void run(async () => {
              const readyPayment = await prepareDemoExchange(request, session.address); setPrepared(readyPayment); setCosts(readyPayment.costs);
            })} />
            {prepared && <Button text="Confirm customer payment in wallet" disabled={disabled} onPress={() => void run(async () => {
              const latest = await prepareDemoExchange(request, session.address);
              if (latest.costs.networkFee > prepared.costs.networkFee || latest.costs.accountRent > prepared.costs.accountRent) {
                setPrepared(latest); setCosts(latest.costs); throw new Error('Costs changed. Review and confirm again.');
              }
              const signed = await signCheckout(session, latest.transaction, updateSession);
              validateDemoRequest(request);
              const exchange = exchangeFromTransaction(request, session.address, signed, latest.latest.lastValidBlockHeight);
              await persist({ request, exchange }); setPrepared(null);
            })} />}
          </>}
          {record?.exchange && session && ownSignature && !ownSignature.signature && <Button text={session.address.toBase58() === request.liquidity ? 'Authorize demo USDC liquidity in wallet' : 'Authorize merchant fees in wallet'} disabled={disabled || !costs} onPress={() => void run(async () => {
            const current = record.exchange!;
            const checked = await reviewDemoExchange(current);
            if (!costs || checked.networkFee > costs.networkFee || checked.accountRent > costs.accountRent) {
              setCosts(checked); throw new Error('Review updated costs and confirm again.');
            }
            if ((await observeDemoSettlement(record)).state !== 'pending') throw new Error('Settlement has already resolved. Check its status.');
            const signed = await signCheckout(session, inspectDemoExchange(current), updateSession);
            validateDemoRequest(request);
            const exchange = exchangeFromTransaction(request, new PublicKey(current.customer), signed, current.lastValidBlockHeight);
            await persist({ request, exchange });
            if (signed.verifySignatures()) await broadcastDemoExchange(exchange, persist);
          })} />}
          {record?.exchange && <Button text="Review authorization costs" disabled={disabled} onPress={() => void run(async () => setCosts(await reviewDemoExchange(record.exchange!)))} />}
          {record?.exchange && tx?.verifySignatures() && <Button text="Broadcast saved signed transaction" disabled={disabled} onPress={() => void run(async () => {
            await reviewDemoExchange(record.exchange!);
            const observed = await observeDemoSettlement(record);
            if (observed.state !== 'pending') { setResult(observed); return; }
            await broadcastDemoExchange(record.exchange!, persist);
          })} />}
        </>}
        {costs && <Text style={styles.text}>Network fee: {formatUnits(BigInt(costs.networkFee), 9)} SOL{ '\n' }New account rent: {formatUnits(BigInt(costs.accountRent), 9)} SOL{ '\n' }Both paid by {request.intent.networkFeePolicy === 'RECEIVER' ? 'merchant' : 'customer'}. Network fees may be charged on failure.</Text>}
        <Button text="Check settlement" disabled={disabled} onPress={() => void check()} />
        {result.signature && <Button text="View settlement transaction" disabled={disabled} onPress={() => void run(async () => { await Linking.openURL(explorerUrl(result.signature!)); })} />}
        {(!record?.exchange || result.state !== 'pending') && <Button text={result.state === 'pending' ? 'Close unsigned request' : 'Done'} disabled={disabled} onPress={() => void run(async () => {
          await clearDemoSettlement(); recordRef.current = null; setRecord(null); setResult({ state: 'pending' }); setCosts(null); setPrepared(null); setFrame(0); setPayload(''); collector.current.reset(); setParts('');
        })} />}
      </>}
      {result.state === 'pending' && <>
        <PhoneTap disabled={disabled || !session} onReadingChange={(reading) => { scanLock.current = reading; }} onReceive={(data) => void run(() => accept(data))} />
        <Button text="Scan demo settlement QR" disabled={disabled || !session} onPress={openScanner} />
        <Text style={styles.text}>{parts}</Text>
        {!!parts && <Button text="Reset scanned parts" disabled={disabled} onPress={() => { collector.current.reset(); setParts(''); }} />}
        <TextInput accessibilityLabel="Demo settlement QR text" placeholder="Paste full demo settlement text" style={styles.input} value={payload} onChangeText={setPayload} autoCapitalize="none" autoCorrect={false} editable={!disabled} />
        <Button text="Read demo settlement text" disabled={disabled || !payload || !session} onPress={() => void run(() => accept(payload))} />
      </>}
    </>}
    {busy && <Text style={styles.text}>Working… confirm in your wallet when prompted.</Text>}
    {checking && <Text style={styles.text}>Checking Solana…</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {scan && <PaymentScanner onClose={closeScanner} onScan={(data) => { closeScanner(); void run(() => accept(data)); }} />}
  </View>;
}
const styles = StyleSheet.create({
  card: { padding: 22, backgroundColor: '#fff', borderRadius: 24, gap: 14 },
  title: { fontSize: 22, fontWeight: '700', color: '#13382d' },
  text: { fontSize: 14, lineHeight: 22, color: '#526c60' },
  address: { fontSize: 12, color: '#385548' }, payload: { fontSize: 10, color: '#526c60', maxHeight: 65 },
  input: { padding: 14, borderWidth: 1, borderColor: '#dce5de', borderRadius: 12, color: '#13382d' },
  button: { backgroundColor: '#087f5b', borderRadius: 14, padding: 16, minHeight: 52 },
  buttonText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
  error: { backgroundColor: '#ffebe7', color: '#972e23', padding: 12, borderRadius: 12 },
});
