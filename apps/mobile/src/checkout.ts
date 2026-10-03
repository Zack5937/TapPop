import type { MerchantCode, MerchantPayment } from './merchantCode';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { PublicKey, Transaction, TransactionInstruction, type Connection, type BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
import type { WalletClient } from './walletClient';
import { ACCOUNT_SIZE, TOKEN_2022_PROGRAM_ID, ExtensionType, getAccountLen, getMint, TokenError } from '@solana/spl-token';
import { config, registerDemoMint } from './config';
import { validateDemoMint } from './demoAsset';
import { parseAssetAmount } from './amount';
import { readAssetAccount, recipientKey, transferInstructions, verifyNetwork, matchesPayment, type PendingPayment } from './payments';
import { authorizedAddress, type WalletSession, type SignedPayment } from './signing';
import { connection } from './rpc';
import { intentAsset, intentMemo, validateIntent, MAX_NETWORK_FEE, MEMO_PROGRAM, OFFER_PREFIX, MAX_QR_LENGTH, type PaymentIntent } from './paymentIntent';

export type PaymentOffer = {
  merchantPayment?: MerchantPayment;
  intentId: string; nonce: string; sender: string; transaction: string; lastValidBlockHeight: number;
};
export type CheckoutRecord = { role: 'merchant'; code: MerchantCode }
  | { role: 'receive'; intent: PaymentIntent; pending?: PendingPayment; merchantCode?: MerchantCode }
  | { role: 'pay'; intent: PaymentIntent; offer: PaymentOffer; pending?: PendingPayment };

export async function checkIntentAsset(intent: Pick<PaymentIntent, 'settlementMint' | 'settlementTokenProgram'>, rpc: Connection = connection) {
  await verifyNetwork(rpc);
  const asset = intentAsset(intent);
  const mint = await getMint(rpc, asset.mint, 'confirmed', asset.tokenProgram).catch((cause: unknown) => {
    if (cause instanceof TokenError) throw new Error('The requested token mint is missing or has the wrong token program.', { cause });
    throw cause;
  });
  if (!mint.isInitialized || mint.decimals !== asset.decimals) throw new Error('Settlement mint does not match the request.');
  if (asset.display.kind === 'scaled') { validateDemoMint(mint); registerDemoMint(asset.mint.toBase58()); }
  return asset;
}

export function buildRequestTransaction(intent: PaymentIntent, sender: PublicKey, latest: BlockhashWithExpiryBlockHeight): Transaction {
  const asset = intentAsset(intent);
  recipientKey(intent.receiver, sender);
  const receiver = new PublicKey(intent.receiver);
  const feePayer = intent.networkFeePolicy === 'RECEIVER' ? receiver : sender;
  const instructions = transferInstructions(sender, receiver, parseAssetAmount(intent.settlementAmount, asset), asset);
  if (instructions.some((i) => i.programId.toBase58() === intent.reference || i.keys.some((k) => k.pubkey.toBase58() === intent.reference)) || intent.reference === MEMO_PROGRAM.toBase58()) throw new Error('Payment reference must be a separate account.');
  instructions[0]!.keys[0]!.pubkey = feePayer; // Explicitly disclosed ATA rent policy matches fee policy in this milestone.
  instructions[1]!.keys.push({ pubkey: new PublicKey(intent.reference), isSigner: false, isWritable: false });
  return new Transaction({ feePayer, ...latest }).add(...instructions,
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(intentMemo(intent)) }));
}

async function checkFunds(intent: PaymentIntent, sender: PublicKey, transaction: Transaction, rpc: Connection) {
  const asset = await checkIntentAsset(intent, rpc);
  const receiver = new PublicKey(intent.receiver);
  const [source, destination, sol, fee] = await Promise.all([
    readAssetAccount(sender, asset, rpc), readAssetAccount(receiver, asset, rpc),
    rpc.getBalance(transaction.feePayer!, 'confirmed'), rpc.getFeeForMessage(transaction.compileMessage(), 'confirmed'),
  ]);
  if (!source || source.amount < parseAssetAmount(intent.settlementAmount, asset)) throw new Error(`Not enough ${asset.symbol}.`);
  if (source.isFrozen || destination?.isFrozen) throw new Error('A token account is frozen. Payment is blocked.');
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0 || fee.value > MAX_NETWORK_FEE) {
    throw new Error('Network fee is unavailable or exceeds the 0.00002 SOL cap.');
  }
  const rent = destination ? 0 : await rpc.getMinimumBalanceForRentExemption(asset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? getAccountLen([ExtensionType.ImmutableOwner]) : ACCOUNT_SIZE);
  if (sol < fee.value + rent) throw new Error(`${intent.networkFeePolicy === 'RECEIVER' ? 'Receiver' : 'Payer'} needs more Devnet SOL for network fees and new account rent.`);
  return { networkFee: fee.value, accountRent: rent };
}

export async function prepareRequestPayment(intent: PaymentIntent, sender: PublicKey, fundingMint: string, rpc: Connection = connection) {
  validateIntent(intent);
  if (fundingMint !== intent.settlementMint) throw new Error('Cross-token settlement is not available yet.');
  await checkIntentAsset(intent, rpc);
  if (await findRequestPayment(intent, rpc)) throw new Error('This request has already been paid. Ask for a new receive QR.');
  const latest = await rpc.getLatestBlockhash('confirmed');
  const transaction = buildRequestTransaction(intent, sender, latest);
  const costs = await checkFunds(intent, sender, transaction, rpc);
  return { transaction, latest, costs };
}

export function inspectOffer(intent: PaymentIntent, offer: PaymentOffer): Transaction {
  if (!offer || offer.intentId !== intent.intentId || offer.nonce !== intent.nonce
      || !Number.isSafeInteger(offer.lastValidBlockHeight) || offer.lastValidBlockHeight < 1
      || typeof offer.transaction !== 'string' || offer.transaction.length > 1700) throw new Error('Invalid payment authorization.');
  if (intent.merchantCodeId) {
    const p = offer.merchantPayment;
    if (!p || p.codeId !== intent.merchantCodeId || p.amount !== intent.settlementAmount || p.reference !== intent.reference
        || p.createdAt !== intent.createdAt || p.expiresAt !== intent.expiresAt) throw new Error('Customer-entered payment details do not match the signed request.');
  } else if (offer.merchantPayment) throw new Error('Unexpected merchant payment details.');
  const sender = recipientKey(offer.sender);
  const raw = Buffer.from(offer.transaction, 'base64');
  if (raw.toString('base64') !== offer.transaction || raw.length > 1232) throw new Error('Invalid transaction encoding.');
  const tx = Transaction.from(raw);
  if (!tx.recentBlockhash) throw new Error('Missing transaction blockhash.');
  const expected = buildRequestTransaction(intent, sender, { blockhash: tx.recentBlockhash, lastValidBlockHeight: offer.lastValidBlockHeight });
  if (!expected.serializeMessage().equals(tx.serializeMessage())) throw new Error('Authorization does not match the amount, token, receiver, fee policy or request.');
  if (!tx.signatures.find((s) => s.publicKey.equals(sender))?.signature || !tx.verifySignatures(false)) {
    throw new Error('Missing or invalid payer signature.');
  }
  return tx;
}

export function encodeOffer(offer: PaymentOffer): string {
  const encoded = OFFER_PREFIX + encodeURIComponent(JSON.stringify(offer));
  if (encoded.length > MAX_QR_LENGTH) throw new Error('Authorization is too large for a QR code.');
  return encoded;
}
export function decodeOffer(text: string): PaymentOffer {
  if (text.length > MAX_QR_LENGTH || !text.startsWith(OFFER_PREFIX)) throw new Error('Scan the customer’s Tap Pay authorization QR.');
  return JSON.parse(decodeURIComponent(text.slice(OFFER_PREFIX.length))) as PaymentOffer;
}

export async function signCheckoutTransaction(
  wallet: Pick<WalletClient, 'authorize' | 'signTransactions'>, session: WalletSession,
  transaction: Transaction, updateSession: (session: WalletSession) => void,
): Promise<Transaction> {
  const message = Buffer.from(transaction.serializeMessage());
  const prior = transaction.signatures.filter((s) => s.signature).map((s) => ({ publicKey: s.publicKey, signature: Buffer.from(s.signature!) }));
  const auth = await wallet.authorize({ chain: config.chain, identity: config.identity, auth_token: session.authToken });
  if (!auth.accounts[0] || !authorizedAddress(auth.accounts[0].address).equals(session.address)) throw new Error('Wallet account changed. Reconnect and review again.');
  if (!transaction.signatures.some((s) => s.publicKey.equals(session.address))) throw new Error('This wallet is not a required signer.');
  updateSession({ ...session, authToken: auth.auth_token });
  const results = await wallet.signTransactions({ transactions: [transaction] });
  const signed = results[0];
  if (results.length !== 1 || !signed || !message.equals(signed.serializeMessage())) throw new Error('Wallet changed the reviewed transaction. Nothing was submitted.');
  if (!signed.signatures.find((s) => s.publicKey.equals(session.address))?.signature
      || !signed.verifySignatures(false)
      || prior.some((s) => !signed.signatures.find((other) => other.publicKey.equals(s.publicKey))?.signature?.equals(s.signature))) {
    throw new Error('Wallet returned invalid or missing payment signatures.');
  }
  return signed;
}

export function offerFromTransaction(intent: PaymentIntent, sender: PublicKey, transaction: Transaction, height: number): PaymentOffer {
  const offer = {
    ...(intent.merchantCodeId ? { merchantPayment: { codeId: intent.merchantCodeId, amount: intent.settlementAmount,
      reference: intent.reference, createdAt: intent.createdAt, expiresAt: intent.expiresAt } } : {}),
    intentId: intent.intentId, nonce: intent.nonce, sender: sender.toBase58(),
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: true }).toString('base64'), lastValidBlockHeight: height };
  inspectOffer(intent, offer);
  return offer;
}

export function paymentFromTransaction(intent: PaymentIntent, offer: PaymentOffer, tx: Transaction): PendingPayment {
  if (!tx.signature) throw new Error('Missing fee payer signature.');
  return { signature: bs58.encode(tx.signature), blockhash: tx.recentBlockhash!, lastValidBlockHeight: offer.lastValidBlockHeight,
    sender: offer.sender, receiver: intent.receiver, mint: intent.settlementMint, tokenProgram: intent.settlementTokenProgram,
    amount: intent.settlementAmount, feePayer: tx.feePayer!.toBase58(), reference: intent.reference, memo: intentMemo(intent) };
}

export function fullySignedPayment(intent: PaymentIntent, offer: PaymentOffer): SignedPayment {
  const tx = inspectOffer(intent, offer);
  const raw = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
  return { raw, payment: paymentFromTransaction(intent, offer, tx) };
}

export async function reviewSponsorship(intent: PaymentIntent, offer: PaymentOffer, merchant: PublicKey, rpc: Connection = connection) {
  validateIntent(intent);
  if (intent.networkFeePolicy !== 'RECEIVER' || merchant.toBase58() !== intent.receiver) throw new Error('Only the receiving wallet can authorize these fees.');
  await checkIntentAsset(intent, rpc);
  const transaction = inspectOffer(intent, offer);
  if (!(await rpc.isBlockhashValid(transaction.recentBlockhash!, { commitment: 'confirmed' })).value) throw new Error('Authorization expired. The customer must check its status before trying again.');
  if (transaction.signatures.find((s) => s.publicKey.equals(merchant))?.signature) throw new Error('This authorization already contains a receiver signature. Check the payment first.');
  const costs = await checkFunds(intent, new PublicKey(offer.sender), transaction, rpc);
  return { transaction, costs };
}

// Both phones observe Solana; no offchain service declares a request paid.
export async function findRequestPayment(intent: PaymentIntent, rpc: Connection = connection): Promise<PendingPayment | null> {
  await checkIntentAsset(intent, rpc);
  const signatures = await rpc.getSignaturesForAddress(new PublicKey(intent.reference), { limit: 20 }, 'confirmed');
  for (const info of signatures) {
    if (info.err) continue;
    const tx = await rpc.getParsedTransaction(info.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx?.meta || tx.meta.err) continue;
    for (const key of tx.transaction.message.accountKeys.filter((k) => k.signer)) {
      if (key.pubkey.toBase58() === intent.receiver) continue;
      const payment: PendingPayment = { signature: info.signature, blockhash: tx.transaction.message.recentBlockhash,
        lastValidBlockHeight: 1, sender: key.pubkey.toBase58(), receiver: intent.receiver, mint: intent.settlementMint,
        tokenProgram: intent.settlementTokenProgram, amount: intent.settlementAmount,
        feePayer: intent.networkFeePolicy === 'RECEIVER' ? intent.receiver : key.pubkey.toBase58(),
        reference: intent.reference, memo: intentMemo(intent) };
      if (matchesPayment(tx, payment)) return payment;
    }
  }
  // Never infer expiry from this bounded discovery query. Signed offers use an
  // independent payer-signature history scan before allowing a replacement.
  return null;
}

export async function offerExpired(offer: PaymentOffer, rpc: Connection = connection): Promise<boolean> {
  const tx = Transaction.from(Buffer.from(offer.transaction, 'base64'));
  return await rpc.getBlockHeight('finalized') > offer.lastValidBlockHeight
    && !(await rpc.isBlockhashValid(tx.recentBlockhash!, { commitment: 'finalized' })).value;
}

export async function findOfferPayment(intent: PaymentIntent, offer: PaymentOffer, rpc: Connection = connection): Promise<PendingPayment | null> {
  await checkIntentAsset(intent, rpc);
  const signed = inspectOffer(intent, offer);
  const customerSignature = bs58.encode(signed.signatures.find((s) => s.publicKey.toBase58() === offer.sender)!.signature!);
  let before: string | undefined;
  for (let page = 0; page < 3; page++) {
    const history = await rpc.getSignaturesForAddress(new PublicKey(intent.reference), { limit: 100, before }, 'confirmed');
    for (const item of history) {
      const tx = await rpc.getParsedTransaction(item.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx) throw new Error('Transaction history is incomplete. Keep the saved authorization and check again.');
      if (!tx.transaction.signatures.includes(customerSignature)) continue;
      const payment: PendingPayment = { signature: item.signature, sender: offer.sender, receiver: intent.receiver,
        mint: intent.settlementMint, tokenProgram: intent.settlementTokenProgram, amount: intent.settlementAmount,
        blockhash: signed.recentBlockhash!, lastValidBlockHeight: offer.lastValidBlockHeight,
        feePayer: intent.networkFeePolicy === 'RECEIVER' ? intent.receiver : offer.sender,
        reference: intent.reference, memo: intentMemo(intent) };
      if (tx.meta?.err || matchesPayment(tx, payment)) return payment;
      throw new Error('Onchain payment does not match the saved authorization. Sending remains blocked.');
    }
    if (history.length < 100) return null;
    before = history[history.length - 1]!.signature;
  }
  throw new Error('Request history is too large to safely resolve. Sending remains blocked.');
}
