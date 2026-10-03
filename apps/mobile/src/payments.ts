import {
  type Connection, PublicKey, Transaction, type BlockhashWithExpiryBlockHeight, type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE, TOKEN_2022_PROGRAM_ID, ExtensionType, getAccountLen, TokenAccountNotFoundError, TokenError,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAccount, getAssociatedTokenAddressSync, getMint, type Account,
} from '@solana/spl-token';
import { config, MEMO_PROGRAM, devnetUsdc, getConfiguredAsset, validateAsset } from './config';
import type { Asset } from './assets';
import { parseAssetAmount } from './amount';
import { readDemoMint, validateDemoMint } from './demoAsset';
import { connection } from './rpc';

export { connection } from './rpc';

export async function readAssetAccount(owner: PublicKey, asset: Asset, rpc: Connection): Promise<Account | null> {
  const ata = getAssociatedTokenAddressSync(asset.mint, owner, false, asset.tokenProgram);
  const token = await getAccount(rpc, ata, 'confirmed', asset.tokenProgram).catch((error: unknown) => {
    if (error instanceof TokenAccountNotFoundError) return null;
    if (error instanceof TokenError) {
      throw new Error('Invalid token account for the configured asset.', { cause: error });
    }
    throw error;
  });
  if (token && (!token.mint.equals(asset.mint) || !token.owner.equals(owner) || !token.isInitialized)) {
    throw new Error('Unexpected or uninitialized token account.');
  }
  return token;
}

export function recipientKey(input: string, sender?: PublicKey): PublicKey {
  let key: PublicKey;
  try {
    key = new PublicKey(input.trim());
  } catch {
    throw new Error('Enter a valid Solana wallet address.');
  }
  if (!PublicKey.isOnCurve(key.toBytes()) || key.equals(PublicKey.default)) {
    throw new Error('Use a regular wallet address for this demo.');
  }
  if (sender?.equals(key)) throw new Error('Choose a different receiving wallet.');
  return key;
}

export async function verifyNetwork(rpc: Connection = connection): Promise<void> {
  if (await rpc.getGenesisHash() !== config.genesisHash) {
    throw new Error('RPC is not Solana Devnet. Payment blocked.');
  }
}

export async function readBalances(owner: PublicKey, rpc: Connection = connection, asset: Asset = devnetUsdc) {
  validateAsset(asset);
  await verifyNetwork(rpc);
  if (asset.display.kind === 'scaled') await readDemoMint(asset.mint, rpc);
  const [sol, token] = await Promise.all([
    rpc.getBalance(owner, 'confirmed'),
    readAssetAccount(owner, asset, rpc),
  ]);
  return { sol: BigInt(sol), token: token?.amount ?? 0n };
}

export function transferInstructions(sender: PublicKey, receiver: PublicKey, amount: bigint, asset: Asset = devnetUsdc) {
  validateAsset(asset);
  // Both accounts are derived from the configured mint, never from external input.
  const source = getAssociatedTokenAddressSync(asset.mint, sender, false, asset.tokenProgram);
  const destination = getAssociatedTokenAddressSync(asset.mint, receiver, false, asset.tokenProgram);
  return [
    createAssociatedTokenAccountIdempotentInstruction(sender, destination, receiver, asset.mint, asset.tokenProgram),
    createTransferCheckedInstruction(source, asset.mint, destination, sender, amount, asset.decimals, [], asset.tokenProgram),
  ];
}

export async function prepareTransfer(sender: PublicKey, receiverText: string, amountText: string, rpc: Connection = connection, asset: Asset = devnetUsdc) {
  validateAsset(asset);
  const receiver = recipientKey(receiverText, sender);
  const amount = parseAssetAmount(amountText, asset);
  await verifyNetwork(rpc);
  const [mint, sol, source, destination] = await Promise.all([
    getMint(rpc, asset.mint, 'confirmed', asset.tokenProgram),
    rpc.getBalance(sender, 'confirmed'),
    readAssetAccount(sender, asset, rpc),
    readAssetAccount(receiver, asset, rpc),
  ]);
  if (!mint.isInitialized || mint.decimals !== asset.decimals) {
    throw new Error('Asset mint configuration does not match Devnet.');
  }
  if (asset.display.kind === 'scaled') validateDemoMint(mint);
  if (source?.isFrozen) throw new Error('Your token account is frozen. This asset cannot be sent.');
  if (destination?.isFrozen) throw new Error('The receiving token account is frozen. Choose another recipient.');
  if (!source || source.amount < amount) throw new Error(`Not enough ${asset.name}.`);
  const latest = await rpc.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: sender, ...latest })
    .add(...transferInstructions(sender, receiver, amount, asset));
  const [fee, rent] = await Promise.all([
    rpc.getFeeForMessage(transaction.compileMessage(), 'confirmed'),
    destination ? Promise.resolve(0) : rpc.getMinimumBalanceForRentExemption(asset.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? getAccountLen([ExtensionType.ImmutableOwner]) : ACCOUNT_SIZE),
  ]);
  if (fee.value === null) throw new Error('Could not estimate the network fee. Try again.');
  if (BigInt(sol) < BigInt(fee.value + rent)) {
    throw new Error('Not enough Devnet SOL for fees and the receiving token account.');
  }
  return { transaction, latest };
}

export type PendingPayment = BlockhashWithExpiryBlockHeight & {
  signature: string;
  feePayer?: string;
  reference?: string;
  memo?: string;
  mint: string;
  tokenProgram: string;
  sender: string;
  receiver: string;
  amount: string;
};

export type Settlement = 'confirmed' | 'failed' | 'expired' | 'pending';

export function matchesPayment(tx: ParsedTransactionWithMeta, payment: PendingPayment): boolean {
  const asset = getConfiguredAsset(payment.mint, payment.tokenProgram);
  if (!tx.meta || tx.meta.err || tx.transaction.signatures[0] !== payment.signature) return false;
  const payer = tx.transaction.message.accountKeys[0];
  if (!payer?.signer || payer.pubkey.toBase58() !== (payment.feePayer ?? payment.sender)) return false;
  if (!tx.transaction.message.accountKeys.some((key) => key.signer && key.pubkey.toBase58() === payment.sender)) return false;
  if (payment.reference && !tx.transaction.message.accountKeys.some((key) => key.pubkey.toBase58() === payment.reference && !key.signer)) return false;
  if (payment.memo && !tx.transaction.message.instructions.some((i) => i.programId.equals(MEMO_PROGRAM) && 'parsed' in i && i.parsed === payment.memo)) return false;
  const source = getAssociatedTokenAddressSync(asset.mint, new PublicKey(payment.sender), false, asset.tokenProgram).toBase58();
  const destination = getAssociatedTokenAddressSync(asset.mint, new PublicKey(payment.receiver), false, asset.tokenProgram).toBase58();
  return tx.transaction.message.instructions.some((instruction) => {
    if (!instruction.programId.equals(asset.tokenProgram) || !('parsed' in instruction)) return false;
    const parsed = instruction.parsed;
    const info = parsed?.info;
    return parsed?.type === 'transferChecked' && info?.mint === asset.mint.toBase58()
      && info.authority === payment.sender && info.source === source && info.destination === destination
      && info.tokenAmount?.amount === parseAssetAmount(payment.amount, asset).toString()
      && info.tokenAmount?.decimals === asset.decimals;
  });
}

export async function checkSettlement(payment: PendingPayment, rpc: Connection = connection): Promise<Settlement> {
  getConfiguredAsset(payment.mint, payment.tokenProgram);
  await verifyNetwork(rpc);
  const result = await rpc.getSignatureStatuses([payment.signature], { searchTransactionHistory: true });
  const status = result.value[0];
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
    if (status.err) return 'failed';
    const tx = await rpc.getParsedTransaction(payment.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) return 'pending';
    if (!matchesPayment(tx, payment)) throw new Error('Onchain transaction does not match this payment. Sending remains blocked.');
    return 'confirmed';
  }
  // Only a finalized height past expiry plus an absent history entry permits a new payment.
  if (!status && await rpc.getBlockHeight('finalized') > payment.lastValidBlockHeight
      && !(await rpc.isBlockhashValid(payment.blockhash, { commitment: 'finalized' })).value) {
    const recheck = await rpc.getSignatureStatuses([payment.signature], { searchTransactionHistory: true });
    if (!recheck.value[0]) return 'expired';
  }
  return 'pending';
}
