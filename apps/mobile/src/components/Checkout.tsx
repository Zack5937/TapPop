import { PhoneTap } from './PhoneTap';
import { paymentLinkTarget } from '../paymentLinks';
import { NfcRequest, NfcHint } from './NfcRequest';
import { merchantCodeExpired, createMerchantCode, createMerchantPayment, decodeMerchantCode, encodeMerchantCode, resolveMerchantPayment, MERCHANT_PREFIX, type MerchantCode } from '../merchantCode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { PublicKey } from '@solana/web3.js';
import { devnetUsdc, supportedAssets, explorerUrl } from '../config';
import { formatUnits } from '../amount';
import { createIntent, decodeRequest, encodeRequest, intentAsset, validateIntent, OFFER_PREFIX, type FeePolicy, type PaymentIntent } from '../paymentIntent';
import { checkIntentAsset, decodeOffer, encodeOffer, findOfferPayment, findRequestPayment, fullySignedPayment, offerExpired,
  offerFromTransaction, prepareRequestPayment, reviewSponsorship, type CheckoutRecord, type PaymentOffer } from '../checkout';
import { clearCheckout, loadCheckout, saveCheckout } from '../checkoutStorage';
import { checkSettlement, type PendingPayment, type Settlement } from '../payments';
import { paymentErrorMessage } from '../errors';
import { submitSignedPayment, type WalletSession } from '../signing';
import { signCheckout } from '../wallet';
import { PaymentQr, PaymentScanner } from './PaymentQr';

function Button({ text, onPress, disabled = false }: { text: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && { opacity: 0.4 }]}>
    <Text style={styles.buttonText}>{text}</Text>
  </Pressable>;
}

type Props = { session: WalletSession | null; updateSession: (session: WalletSession) => void;
  externalBlocked: boolean; onLockChange: (locked: boolean) => void; onBusyChange: (busy: boolean) => void };
export function Checkout({ session, updateSession, externalBlocked, onLockChange, onBusyChange }: Props) {
  const [record, setRecord] = useState<CheckoutRecord | null>(null);
  const recordRef = useRef<CheckoutRecord | null>(null);
  const [ready, setReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [merchantReview, setMerchantReview] = useState<MerchantCode | null>(null);
  const [customerAmount, setCustomerAmount] = useState('');
  const [review, setReview] = useState<PaymentIntent | null>(null);
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof prepareRequestPayment>> | null>(null);
  const [sponsor, setSponsor] = useState<{ offer: PaymentOffer; costs: { networkFee: number; accountRent: number } } | null>(null);
  const [settlement, setSettlement] = useState<Settlement>('pending');
  const [receiveMode, setReceiveMode] = useState(false);
  const [amount, setAmount] = useState('5');
  const [receiveMint, setReceiveMint] = useState(devnetUsdc.mint.toBase58());
  const [fundingMint, setFundingMint] = useState(devnetUsdc.mint.toBase58());
  const [feePolicy, setFeePolicy] = useState<FeePolicy>('RECEIVER');
  const [payload, setPayload] = useState('');
  const [incomingLink, setIncomingLink] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [querying, setQuerying] = useState(false);
  const [now, setNow] = useState(Date.now());
  const lock = useRef(false);
  const checking = useRef(false);
  const scanning = useRef(false);
  const openScanner = () => { scanning.current = true; setScan(true); };
  const closeScanner = () => { scanning.current = false; setScan(false); };
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange(!!busy); }, [busy, onBusyChange]);
  useEffect(() => { onLockChange(!ready || !!record || !!review || !!merchantReview || !!busy); }, [ready, record, review, merchantReview, busy, onLockChange]);
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    loadCheckout().then((saved) => {
      if (!cancelled) { recordRef.current = saved; setRecord(saved); setReady(true); }
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [loadAttempt]);

  async function persist(next: CheckoutRecord) {
    await saveCheckout(next);
    recordRef.current = next; setRecord(next);
  }
  async function run(label: string, work: () => Promise<void>) {
    if (lock.current || externalBlocked || !ready || checking.current) return;
    lock.current = true; setBusy(label); setError('');
    try { await work(); } catch (e) { setError(paymentErrorMessage(e)); }
    finally { lock.current = false; setBusy(''); }
  }

  const checkCurrent = useCallback(async () => {
    const current = recordRef.current;
    if (current?.role === 'merchant') { setNow(Date.now()); return; }
    if (!current || checking.current || lock.current || scanning.current || externalBlocked) return;
    checking.current = true; setQuerying(true);
    try {
      let pending = current.pending;
      let result: Settlement = 'pending';
      if (pending) result = await checkSettlement(pending);
      else if (current.role === 'receive') {
        pending = await findRequestPayment(current.intent) ?? undefined;
        if (pending) result = 'confirmed';
      } else {
        pending = await findOfferPayment(current.intent, current.offer) ?? undefined;
        if (pending) result = await checkSettlement(pending);
        else if (await offerExpired(current.offer)) {
          pending = await findOfferPayment(current.intent, current.offer) ?? undefined;
          result = pending ? await checkSettlement(pending) : 'expired';
        }
      }
      if (!mounted.current || recordRef.current !== current) return;
      if (pending && !current.pending) await persist({ ...current, pending });
      if (!mounted.current) return;
      setSettlement((old) => old === 'pending' ? result : old);
      setError('');
    } catch (e) {
      if (mounted.current && recordRef.current === current) setError(`Payment is still saved. ${paymentErrorMessage(e)}`);
    } finally { checking.current = false; if (mounted.current) { setQuerying(false); setNow(Date.now()); } }
  }, [externalBlocked]);

  useEffect(() => {
    if (!record || settlement !== 'pending') return;
    void checkCurrent();
    const timer = setInterval(() => void checkCurrent(), 5000);
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') void checkCurrent(); });
    return () => { clearInterval(timer); listener.remove(); };
  }, [record, settlement, checkCurrent]);

  async function acceptPayload(text: string) {
    if (recordRef.current) {
      const current = recordRef.current;
      if (current.role === 'merchant') {
        if (!session) throw new Error('Connect the receiving wallet to approve fees.');
        const offer = decodeOffer(text);
        const intent = resolveMerchantPayment(current.code, offer);
        const checked = await reviewSponsorship(intent, offer, session.address);
        if (await findRequestPayment(intent)) throw new Error('This customer payment has already settled.');
        await persist({ role: 'receive', intent, merchantCode: current.code });
        setSettlement('pending'); setSponsor({ offer, costs: checked.costs });
        return;
      }
      if (current.role !== 'receive' || current.pending || !session || settlement !== 'pending') throw new Error('Finish checking the current payment before scanning another request.');
      const offer = decodeOffer(text);
      const result = await reviewSponsorship(current.intent, offer, session.address);
      if (await findRequestPayment(current.intent)) throw new Error('This request has already been paid. Check its status.');
      setSponsor({ offer, costs: result.costs });
      return;
    }
    if (text.startsWith(OFFER_PREFIX)) throw new Error('Open the original receive request before scanning an authorization.');
    if (text.startsWith(MERCHANT_PREFIX)) {
      const code = decodeMerchantCode(text);
      await checkIntentAsset(code);
      setMerchantReview(code); setCustomerAmount(''); setReview(null); setPrepared(null); setReceiveMode(false);
      return;
    }
    const intent = decodeRequest(text);
    await checkIntentAsset(intent);
    if (await findRequestPayment(intent)) throw new Error('This request has already been paid. Ask for a new receive QR.');
    setMerchantReview(null); setReview(intent); setFundingMint(intent.settlementMint); setPrepared(null); setReceiveMode(false);
  }
  const acceptRef = useRef<(text: string) => void>(() => {});
  acceptRef.current = (text) => { void run('Reading payment…', () => acceptPayload(text)); };
  // A deep link transports the same request and only opens review; it never signs.
  useEffect(() => {
    void Linking.getInitialURL().then((url) => { if (url && paymentLinkTarget(url) === 'checkout' && mounted.current) setIncomingLink(url); });
    const listener = Linking.addEventListener('url', ({ url }) => { if (paymentLinkTarget(url) === 'checkout') setIncomingLink(url); });
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!incomingLink || !ready || externalBlocked || busy || querying) return;
    const link = incomingLink; setIncomingLink(null); acceptRef.current(link);
  }, [incomingLink, ready, externalBlocked, busy, querying]);

  const disabled = externalBlocked || !ready || !!busy || querying;
  const request = record && record.role !== 'merchant' ? record.intent : review;
  const expired = !!request && request.expiresAt * 1000 <= now;
  const asset = request ? intentAsset(request) : merchantReview ? intentAsset(merchantReview) : record?.role === 'merchant' ? intentAsset(record.code) : devnetUsdc;
  const costs = prepared?.costs ?? sponsor?.costs;

  async function finish() {
    const saved = recordRef.current;
    if (saved?.role === 'receive' && saved.merchantCode && !merchantCodeExpired(saved.merchantCode)) {
      await persist({ role: 'merchant', code: saved.merchantCode });
    } else {
      await clearCheckout(); recordRef.current = null; setRecord(null);
    }
    setReview(null); setMerchantReview(null);
    setPrepared(null); setSponsor(null); setSettlement('pending'); setPayload(''); setError('');
  }

  return <View style={styles.card}>
    <Text style={styles.title}>Receive / Pay</Text>
    {!ready ? <>
      <Text style={styles.text}>{loadError ? 'Cannot recover the saved checkout. Sending is blocked. Do not clear app data before checking wallet activity.' : 'Recovering saved checkout…'}</Text>
      {loadError && <Button text="Retry checkout recovery" onPress={() => setLoadAttempt((n) => n + 1)} />}
    </> : <>
      {!record && !review && !merchantReview && <>
        <Button text="Receive" disabled={disabled || !session} onPress={() => setReceiveMode(true)} />
        <Button text="Scan to pay" disabled={disabled || !session} onPress={openScanner} />
        <NfcHint disabled={disabled} />
        {!session && <Text style={styles.text}>Connect your wallet below to receive or pay.</Text>}
        {receiveMode && <>
          <Text style={styles.text}>Receive token (default USDC)</Text>
          {supportedAssets().map((a) => <Button key={a.mint.toBase58()} text={`${a.symbol}${a.display.kind === 'scaled' ? ` · ${a.mint.toBase58().slice(0, 6)}` : ''}${a.mint.toBase58() === receiveMint ? ' ✓' : ''}`}
            disabled={disabled} onPress={() => setReceiveMint(a.mint.toBase58())} />)}
          <Button text="Show merchant QR — customer enters amount" disabled={disabled || !session} onPress={() => void run('Creating merchant code…', async () => {
            if (!session) return;
            const chosen = supportedAssets().find((a) => a.mint.toBase58() === receiveMint);
            if (!chosen) throw new Error('Select a supported receive token.');
            const code = createMerchantCode(session.address, chosen);
            await checkIntentAsset(code);
            await persist({ role: 'merchant', code }); setSettlement('pending'); setNow(Date.now());
          })} />
          <Text style={styles.text}>Merchant QR: customers enter the amount and pay 0 SOL gas. Merchant covers network fees and new account rent. This merchant code has no expiry.</Text>
          <Text style={styles.text}>Or request a specific amount:</Text>
          <TextInput accessibilityLabel="Amount to receive" style={styles.input} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" editable={!disabled} />
          <Text style={styles.text}>Who pays network fees?</Text>
          <Button text={`Receiver / merchant${feePolicy === 'RECEIVER' ? ' ✓' : ''}`} disabled={disabled} onPress={() => setFeePolicy('RECEIVER')} />
          <Button text={`Payer${feePolicy === 'PAYER' ? ' ✓' : ''}`} disabled={disabled} onPress={() => setFeePolicy('PAYER')} />
          <Text style={styles.text}>The selected side also pays rent if a new receiving token account is needed. Network fees are capped at 0.00002 SOL. No conversion or service fee in this same-token demo.</Text>
          <Button text="Show receive QR" disabled={disabled || !session} onPress={() => void run('Creating request…', async () => {
            if (!session) return;
            const chosen = supportedAssets().find((a) => a.mint.toBase58() === receiveMint);
            if (!chosen) throw new Error('Select a supported receive token.');
            const intent = createIntent(session.address, chosen, amount, feePolicy);
            await checkIntentAsset(intent);
            await persist({ role: 'receive', intent }); setSettlement('pending'); setNow(Date.now());
          })} />
        </>}
      </>}
      {record?.role === 'merchant' && <>
        <Text style={styles.title}>Merchant receive QR</Text>
        <Text style={styles.text}>Receive {asset.symbol}. Customers enter their own amount and pay 0 SOL gas. You confirm each payment and cover network fees plus any new account rent.</Text>
        <Text selectable style={styles.address}>{record.code.receiver}</Text>
        <Text selectable style={styles.address}>Token: {record.code.settlementMint}</Text>
        {!merchantCodeExpired(record.code, Math.floor(now / 1000)) ? <>
          <PaymentQr value={encodeMerchantCode(record.code)} />
          <NfcRequest value={encodeMerchantCode(record.code)} disabled={disabled} />
          <Text selectable style={styles.link}>{encodeMerchantCode(record.code)}</Text>
          <Button text="Scan customer authorization" disabled={disabled || !session} onPress={openScanner} />
        </> : <Text style={styles.text}>Merchant QR expired. Close it and generate a new code.</Text>}
        <Button text="Close merchant QR" disabled={disabled} onPress={() => void run('Closing merchant code…', finish)} />
      </>}
      {merchantReview && !record && !review && <>
        <Text style={styles.title}>Enter payment amount</Text>
        <Text style={styles.text}>Pay this merchant in {asset.symbol}</Text>
        <Text selectable style={styles.address}>{merchantReview.receiver}</Text>
        <Text selectable style={styles.address}>Token: {merchantReview.settlementMint}</Text>
        <TextInput accessibilityLabel="Customer payment amount" placeholder="Enter amount" keyboardType="decimal-pad" style={styles.input}
          value={customerAmount} onChangeText={setCustomerAmount} editable={!disabled} />
        <Text style={styles.amount}>Gas fee: 0 SOL</Text>
        <Text style={styles.text}>Paid by the merchant. The merchant also covers new receiving-account rent.</Text>
        {asset.display.kind === 'scaled' && <Text style={styles.text}>Devnet demo asset · Not backed by real equity.</Text>}
        <Button text="Review entered amount" disabled={disabled || !session} onPress={() => void run('Reviewing amount…', async () => {
          const intent = createMerchantPayment(merchantReview, customerAmount);
          await checkIntentAsset(intent);
          setReview(intent); setFundingMint(intent.settlementMint); setMerchantReview(null); setPrepared(null);
        })} />
        <Button text="Back" disabled={disabled} onPress={() => setMerchantReview(null)} />
      </>}
      {request && <>
        <Text style={styles.title}>{settlement === 'confirmed' ? 'Paid ✓' : settlement === 'failed' ? 'Payment failed' : settlement === 'expired' ? 'Authorization expired' : record?.role === 'receive' ? 'Waiting for payment' : 'Review payment'}</Text>
        <Text style={styles.amount}>{request.settlementAmount} {asset.symbol}</Text>
        <Text style={styles.text}>Receiver</Text><Text selectable style={styles.address}>{request.receiver}</Text>
        {record?.role !== 'receive' && request.networkFeePolicy === 'RECEIVER' && <>
          <Text style={styles.amount}>Gas fee: 0 SOL</Text>
          <Text style={styles.text}>Paid by the receiver / merchant.</Text>
        </>}
        <Text style={styles.text}>Network fees: {request.networkFeePolicy === 'RECEIVER' ? 'receiver / merchant' : 'payer'}. New receiving account rent: same side. Network fees may be charged even if the transaction fails.</Text>
        {asset.display.kind === 'scaled' && <Text style={styles.text}>Devnet demo asset · Not backed by real equity.</Text>}
        <Text selectable style={styles.address}>Token: {request.settlementMint}</Text>
      </>}
      {record?.role === 'receive' && !record.pending && settlement === 'pending' && <>
        {!expired ? (!record.merchantCode && <PaymentQr value={encodeRequest(record.intent)} />) : <Text style={styles.text}>Request expired. Previously signed payments may still arrive; check wallet activity before closing.</Text>}
        {!record.merchantCode && !expired && <NfcRequest value={encodeRequest(record.intent)} disabled={disabled} />}
        {!record.merchantCode && <Text selectable style={styles.link}>{encodeRequest(record.intent)}</Text>}
        {record.intent.networkFeePolicy === 'RECEIVER' && !expired && <>
          <Text style={styles.text}>Ask the customer to scan and confirm, then scan their authorization QR to approve network fees.</Text>
          <Button text="Scan customer authorization" disabled={disabled || !session} onPress={openScanner} />
        </>}
      </>}
      {review && !record && <>
        <Text style={styles.text}>Pay with</Text>
        {supportedAssets().map((a) => <Button key={a.mint.toBase58()}
          text={`${a.symbol}${a.display.kind === 'scaled' ? ` · ${a.mint.toBase58().slice(0, 6)}` : ''}${a.mint.toBase58() === fundingMint ? ' ✓' : ''}${a.mint.toBase58() !== review.settlementMint ? ' — conversion unavailable' : ''}`}
          disabled={disabled || a.mint.toBase58() !== review.settlementMint} onPress={() => { setFundingMint(a.mint.toBase58()); setPrepared(null); }} />)}
        <Button text="Review payment costs" disabled={disabled || !session} onPress={() => void run('Checking payment…', async () => {
          if (session) setPrepared(await prepareRequestPayment(review, session.address, fundingMint));
        })} />
        {prepared && <Button text="Confirm payment in wallet" disabled={disabled || !session} onPress={() => void run('Confirm in your wallet…', async () => {
          if (!session) return;
          // Rebuild after review so a stale blockhash is not silently signed; show revised costs if increased.
          const latest = await prepareRequestPayment(review, session.address, fundingMint);
          if (latest.costs.networkFee > prepared.costs.networkFee || latest.costs.accountRent > prepared.costs.accountRent) {
            setPrepared(latest); throw new Error('Payment costs changed. Review them and confirm again.');
          }
          const signed = await signCheckout(session, latest.transaction, updateSession);
          validateIntent(review);
          const offer = offerFromTransaction(review, session.address, signed, latest.latest.lastValidBlockHeight);
          const next: CheckoutRecord = { role: 'pay', intent: review, offer };
          if (review.networkFeePolicy === 'RECEIVER') await persist(next);
          else await submitSignedPayment(fullySignedPayment(review, offer), async (pending) => persist({ ...next, pending }));
          setReview(null); setPrepared(null); setSettlement('pending');
        })} />}
        <Button text="Back" disabled={disabled} onPress={() => { setReview(null); setPrepared(null); }} />
      </>}
      {record?.role === 'pay' && !record.pending && settlement === 'pending' && <>
        <Text style={styles.text}>Show this authorization QR to the receiver. Your token transfer is signed; the receiver must approve fees. Keep this payment until its result is known.</Text>
        <PhoneTap value={encodeOffer(record.offer)} disabled={disabled} /><PaymentQr value={encodeOffer(record.offer)} /><Text selectable style={styles.link}>{encodeOffer(record.offer)}</Text>
      </>}
      {costs && <Text style={styles.text}>Estimated network fee ({request?.networkFeePolicy === 'RECEIVER' ? 'merchant pays' : 'payer pays'}): {formatUnits(BigInt(costs.networkFee), 9)} SOL{ '\n' }New account rent: {formatUnits(BigInt(costs.accountRent), 9)} SOL</Text>}
      {sponsor && record?.role === 'receive' && !record.pending && <>
        <Text style={styles.text}>Customer</Text><Text selectable style={styles.address}>{sponsor.offer.sender}</Text>
        <Button text="Approve fees in merchant wallet" disabled={disabled || !session} onPress={() => void run('Confirm merchant fees…', async () => {
          if (!session) return;
          if (await findRequestPayment(record.intent)) throw new Error('This request has already been paid. Check its status.');
          const checked = await reviewSponsorship(record.intent, sponsor.offer, session.address);
          if (checked.costs.networkFee > sponsor.costs.networkFee || checked.costs.accountRent > sponsor.costs.accountRent) {
            setSponsor({ ...sponsor, costs: checked.costs }); throw new Error('Costs changed. Review and confirm again.');
          }
          const signed = await signCheckout(session, checked.transaction, updateSession);
          validateIntent(record.intent);
          const offer = offerFromTransaction(record.intent, new PublicKey(sponsor.offer.sender), signed, sponsor.offer.lastValidBlockHeight);
          await submitSignedPayment(fullySignedPayment(record.intent, offer), async (pending) => persist({ ...record, pending }));
          setSponsor(null);
        })} />
      </>}
      {record && record.role !== 'merchant' && <>
        <Button text="Check payment status" disabled={disabled} onPress={() => void checkCurrent()} />
        {record.pending && <Button text="View transaction" disabled={disabled} onPress={() => void run('Opening details…', async () => { await Linking.openURL(explorerUrl(record.pending!.signature)); })} />}
        {(settlement !== 'pending' || (record.role === 'receive' && !record.pending && expired))
          && <Button text={settlement === 'pending' ? 'Close expired request' : 'Done'} disabled={disabled} onPress={() => void run('Finishing…', finish)} />}
      </>}
      {(!record || record.role === 'merchant' || (record.role === 'receive' && !record.pending && !expired)) && <>
        <PhoneTap disabled={disabled || !session} onReadingChange={(reading) => { scanning.current = reading; }} onReceive={(text) => acceptRef.current(text)} />
        <Text style={styles.text}>Testing without a camera: paste the Tap Pay QR text.</Text>
        <TextInput accessibilityLabel="Payment QR text" style={styles.input} value={payload} onChangeText={setPayload} autoCapitalize="none" autoCorrect={false} editable={!disabled} />
        <Button text="Read payment QR text" disabled={disabled || !payload} onPress={() => void run('Reading payment…', () => acceptPayload(payload))} />
      </>}
    </>}
    {!!busy && <Text style={styles.text}>{busy}</Text>}
    {querying && <Text style={styles.text}>Checking Solana…</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {scan && <PaymentScanner onClose={closeScanner} onScan={(text) => { closeScanner(); acceptRef.current(text); }} />}
  </View>;
}
const styles = StyleSheet.create({
  card: { padding: 22, backgroundColor: '#fff', borderRadius: 24, gap: 14 },
  title: { fontSize: 22, fontWeight: '700', color: '#13382d' },
  amount: { fontSize: 30, fontWeight: '700', color: '#13382d' },
  text: { fontSize: 14, lineHeight: 22, color: '#526c60' },
  address: { fontSize: 12, color: '#385548' },
  link: { fontSize: 10, color: '#526c60', maxHeight: 65 },
  input: { padding: 14, borderWidth: 1, borderColor: '#dce5de', borderRadius: 12, color: '#13382d' },
  button: { backgroundColor: '#087f5b', borderRadius: 14, padding: 16, minHeight: 52 },
  buttonText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
  error: { backgroundColor: '#ffebe7', color: '#972e23', padding: 12, borderRadius: 12 },
});
