import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { PublicKey, Transaction, TransactionInstruction, type Connection, type BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
import { ACCOUNT_SIZE, ExtensionType, getAccountLen } from '@solana/spl-token';
import { devnetUsdc, registerDemoMint, MEMO_PROGRAM } from './config';
import { createIntent, validateIntent, intentMemo, MAX_NETWORK_FEE, type PaymentIntent } from './paymentIntent';
import { checkIntentAsset } from './checkout';
import { recipientKey, readAssetAccount, transferInstructions, type Settlement } from './payments';
import { demoAsset } from './demoAsset';
import { DemoQuoteProvider } from './demoQuote';
import { connection } from './rpc';

export type DemoRequest = { version: 1; type: 'DEMO_SETTLEMENT'; intent: PaymentIntent; fundingMint: string; liquidity: string };
export type DemoExchange = { request: DemoRequest; customer: string; transaction: string; lastValidBlockHeight: number };
export type DemoRecord = { request: DemoRequest; exchange?: DemoExchange };
export const DEMO_SETTLEMENT_PREFIX = 'tappay://settle?data=';

export function validateDemoRequest(value: unknown, restore = false): DemoRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid demo settlement request.');
  const p = value as DemoRequest;
  if (p.version !== 1 || p.type !== 'DEMO_SETTLEMENT') throw new Error('Unsupported demo settlement request.');
  const intent = validateIntent(p.intent, restore);
  if (intent.settlementMint !== devnetUsdc.mint.toBase58() || intent.merchantCodeId) throw new Error('Demo settlement requires a fixed USDC request.');
  if (typeof p.liquidity !== 'string' || recipientKey(p.liquidity, new PublicKey(intent.receiver)).toBase58() !== p.liquidity) throw new Error('Invalid demo liquidity wallet.');
  if (typeof p.fundingMint !== 'string' || new PublicKey(p.fundingMint).toBase58() !== p.fundingMint) throw new Error('Invalid funding mint.');
  const asset = registerDemoMint(p.fundingMint);
  DemoQuoteProvider.quote(asset, intent.settlementAmount);
  return { version: 1, type: 'DEMO_SETTLEMENT', intent, fundingMint: p.fundingMint, liquidity: p.liquidity };
}

export function createDemoRequest(merchant: PublicKey, liquidity: string, fundingMint: string, amount: string): DemoRequest {
  return validateDemoRequest({ version: 1, type: 'DEMO_SETTLEMENT',
    intent: createIntent(merchant, devnetUsdc, amount), fundingMint, liquidity });
}

export async function checkDemoAssets(request: DemoRequest, rpc: Connection = connection) {
  await checkIntentAsset(request.intent, rpc);
  const asset = demoAsset(new PublicKey(request.fundingMint));
  await checkIntentAsset({ settlementMint: request.fundingMint, settlementTokenProgram: asset.tokenProgram.toBase58() }, rpc);
}

export function demoQuote(request: DemoRequest) {
  return DemoQuoteProvider.quote(demoAsset(new PublicKey(request.fundingMint)), request.intent.settlementAmount);
}

export function buildDemoExchange(request: DemoRequest, customer: PublicKey, latest: BlockhashWithExpiryBlockHeight): Transaction {
  validateDemoRequest(request, true);
  const merchant = recipientKey(request.intent.receiver, customer);
  const liquidity = recipientKey(request.liquidity, customer);
  const asset = demoAsset(new PublicKey(request.fundingMint));
  const quote = demoQuote(request);
  const feePayer = request.intent.networkFeePolicy === 'RECEIVER' ? merchant : customer;
  const stock = transferInstructions(customer, liquidity, quote.fundingRaw, asset);
  const usdc = transferInstructions(liquidity, merchant, quote.settlementRaw, devnetUsdc);
  stock[0]!.keys[0]!.pubkey = feePayer;
  usdc[0]!.keys[0]!.pubkey = feePayer;
  const instructions = [...stock, ...usdc];
  if (instructions.some((i) => i.programId.toBase58() === request.intent.reference
      || i.keys.some((k) => k.pubkey.toBase58() === request.intent.reference))
      || request.intent.reference === MEMO_PROGRAM.toBase58()) throw new Error('Invalid settlement reference.');
  usdc[1]!.keys.push({ pubkey: new PublicKey(request.intent.reference), isSigner: false, isWritable: false });
  return new Transaction({ feePayer, ...latest }).add(...instructions,
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`DemoSwap:1:${intentMemo(request.intent)}`) }));
}

export function inspectDemoExchange(exchange: DemoExchange): Transaction {
  if (!exchange || typeof exchange.transaction !== 'string' || exchange.transaction.length > 1700
      || !Number.isSafeInteger(exchange.lastValidBlockHeight) || exchange.lastValidBlockHeight < 1) throw new Error('Invalid settlement authorization.');
  const request = validateDemoRequest(exchange.request, true);
  const customer = recipientKey(exchange.customer);
  if (customer.toBase58() !== exchange.customer) throw new Error('Invalid customer.');
  const raw = Buffer.from(exchange.transaction, 'base64');
  if (raw.length > 1232 || raw.toString('base64') !== exchange.transaction) throw new Error('Invalid settlement transaction encoding.');
  const transaction = Transaction.from(raw);
  const expected = buildDemoExchange(request, customer, { blockhash: transaction.recentBlockhash!, lastValidBlockHeight: exchange.lastValidBlockHeight });
  if (!expected.serializeMessage().equals(transaction.serializeMessage()) || !transaction.verifySignatures(false)
      || !transaction.signatures.find((s) => s.publicKey.equals(customer))?.signature) throw new Error('Settlement instructions or customer signature do not match the reviewed quote.');
  return transaction;
}

export function exchangeFromTransaction(request: DemoRequest, customer: PublicKey, transaction: Transaction, height: number): DemoExchange {
  const exchange = { request, customer: customer.toBase58(), transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64'), lastValidBlockHeight: height };
  inspectDemoExchange(exchange);
  return exchange;
}

export function mergeDemoExchange(previous: DemoExchange, incoming: DemoExchange): DemoExchange {
  const old = inspectDemoExchange(previous); const next = inspectDemoExchange(incoming);
  if (JSON.stringify(validateDemoRequest(previous.request, true)) !== JSON.stringify(validateDemoRequest(incoming.request, true))
      || previous.lastValidBlockHeight !== incoming.lastValidBlockHeight
      || !old.serializeMessage().equals(next.serializeMessage())) throw new Error('Finish the saved settlement before accepting a different transaction.');
  for (const signature of old.signatures) {
    if (signature.signature) next.addSignature(signature.publicKey, signature.signature);
  }
  return exchangeFromTransaction(previous.request, new PublicKey(previous.customer), next, previous.lastValidBlockHeight);
}

export async function reviewDemoExchange(exchange: DemoExchange, rpc: Connection = connection) {
  const request = validateDemoRequest(exchange.request);
  const transaction = inspectDemoExchange(exchange);
  return checkDemoFunds(request, new PublicKey(exchange.customer), transaction, rpc);
}

async function checkDemoFunds(request: DemoRequest, customer: PublicKey, transaction: Transaction, rpc: Connection) {
  await checkDemoAssets(request, rpc);
  if (!(await rpc.isBlockhashValid(transaction.recentBlockhash!, { commitment: 'confirmed' })).value) throw new Error('Settlement authorization expired. Check the saved payment before starting again.');
  const funding = demoAsset(new PublicKey(request.fundingMint));
  const liquidity = new PublicKey(request.liquidity); const merchant = new PublicKey(request.intent.receiver);
  const [customerStock, treasuryStock, treasuryUsdc, merchantUsdc, fee, sol] = await Promise.all([
    readAssetAccount(customer, funding, rpc), readAssetAccount(liquidity, funding, rpc),
    readAssetAccount(liquidity, devnetUsdc, rpc), readAssetAccount(merchant, devnetUsdc, rpc),
    rpc.getFeeForMessage(transaction.compileMessage(), 'confirmed'), rpc.getBalance(transaction.feePayer!, 'confirmed'),
  ]);
  const quote = demoQuote(request);
  if (!customerStock || customerStock.amount < quote.fundingRaw) throw new Error('Not enough AAPLx-DEMO.');
  if (!treasuryUsdc || treasuryUsdc.amount < quote.settlementRaw) throw new Error('Demo liquidity wallet needs more Devnet USDC.');
  if ([customerStock, treasuryStock, treasuryUsdc, merchantUsdc].some((a) => a?.isFrozen)) throw new Error('A settlement token account is frozen.');
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0 || fee.value > MAX_NETWORK_FEE) throw new Error('Settlement network fee exceeds the cap or is unavailable.');
  const rent = (treasuryStock ? 0 : await rpc.getMinimumBalanceForRentExemption(getAccountLen([ExtensionType.ImmutableOwner])))
    + (merchantUsdc ? 0 : await rpc.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
  if (sol < fee.value + rent) throw new Error('Fee payer needs more Devnet SOL for fees and receiving account rent.');
  return { networkFee: fee.value, accountRent: rent };
}

export async function prepareDemoExchange(request: DemoRequest, customer: PublicKey, rpc: Connection = connection) {
  validateDemoRequest(request);
  await checkDemoAssets(request, rpc);
  const observed = await observeDemoSettlement({ request }, rpc);
  if (observed.state === 'confirmed') throw new Error('This request is already paid.');
  const latest = await rpc.getLatestBlockhash('confirmed');
  const transaction = buildDemoExchange(request, customer, latest);
  const costs = await checkDemoFunds(request, customer, transaction, rpc);
  return { transaction, latest, costs };
}

export function decodeDemoRecord(value: unknown): DemoRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved demo settlement.');
  const p = value as DemoRecord;
  const request = validateDemoRequest(p.request, true);
  if (!p.exchange) return { request };
  inspectDemoExchange(p.exchange);
  if (JSON.stringify(request) !== JSON.stringify(validateDemoRequest(p.exchange.request, true))) throw new Error('Saved request and settlement disagree.');
  return { request, exchange: { ...p.exchange, request } };
}

export function encodeDemoRecord(record: DemoRecord): string {
  return DEMO_SETTLEMENT_PREFIX + Buffer.from(JSON.stringify(decodeDemoRecord(record))).toString('base64');
}
export function decodeDemoText(text: string): DemoRecord {
  if (text.length > 7000 || !text.startsWith(DEMO_SETTLEMENT_PREFIX)) throw new Error('Scan a demo settlement request or authorization.');
  return decodeDemoRecord(JSON.parse(Buffer.from(text.slice(DEMO_SETTLEMENT_PREFIX.length), 'base64').toString()));
}

export async function broadcastDemoExchange(exchange: DemoExchange, remember: (record: DemoRecord) => Promise<void>, rpc: Connection = connection) {
  const transaction = inspectDemoExchange(exchange);
  const raw = transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
  const signature = bs58.encode(transaction.signature!);
  await remember({ request: exchange.request, exchange });
  const returned = await rpc.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  if (returned !== signature) throw new Error('RPC returned a different signature. Keep checking the saved settlement.');
  return signature;
}

export async function observeDemoSettlement(record: DemoRecord, rpc: Connection = connection): Promise<{ state: Settlement; signature?: string }> {
  const request = validateDemoRequest(record.request, true);
  await checkDemoAssets(request, rpc);
  const saved = record.exchange ? inspectDemoExchange(record.exchange) : null;
  // Compare the entire onchain message: both transfer legs, amounts, programs,
  // authorities, fee payer, reference and memo must match, not just a USDC receipt.
  async function lookup(): Promise<{ state: Settlement; signature?: string }> {
    let before: string | undefined;
    for (let page = 0; page < 3; page++) {
      const history = await rpc.getSignaturesForAddress(new PublicKey(request.intent.reference), { limit: 100, before }, 'confirmed');
      for (const item of history) {
        const result = await rpc.getTransaction(item.signature, { commitment: 'confirmed' });
        if (!result || !result.meta) throw new Error('Settlement history is incomplete. Keep the saved payment.');
        const tx = Transaction.populate(result.transaction.message, result.transaction.signatures);
        if (saved) {
          if (!saved.serializeMessage().equals(tx.serializeMessage())) continue;
          if (!saved.signatures.every((s) => !s.signature || tx.signatures.find((t) => t.publicKey.equals(s.publicKey))?.signature?.equals(s.signature))) continue;
        } else {
          // Stock transfer authority is the only signer other than merchant/liquidity.
          const customer = tx.signatures.find((s) => ![request.intent.receiver, request.liquidity].includes(s.publicKey.toBase58()))?.publicKey;
          if (!customer) continue;
          const expected = buildDemoExchange(request, customer, { blockhash: tx.recentBlockhash!, lastValidBlockHeight: 1 });
          if (!expected.serializeMessage().equals(tx.serializeMessage())) continue;
        }
        if (!tx.verifySignatures() || bs58.encode(tx.signature!) !== item.signature) throw new Error('Invalid onchain settlement signatures.');
        if (result.meta.err) { if (saved) return { state: 'failed', signature: item.signature }; continue; }
        return { state: 'confirmed', signature: item.signature };
      }
      if (history.length < 100) return { state: 'pending' };
      before = history[history.length - 1]!.signature;
    }
    throw new Error('Settlement history exceeds the safe recovery limit. Sending stays blocked.');
  }
  const found = await lookup();
  if (found.state !== 'pending') return found;
  if (saved && record.exchange && await rpc.getBlockHeight('finalized') > record.exchange.lastValidBlockHeight
      && !(await rpc.isBlockhashValid(saved.recentBlockhash!, { commitment: 'finalized' })).value) {
    const final = await lookup();
    if (final.state !== 'pending') return final;
    return { state: 'expired' };
  }
  return found;
}
