import { signCheckoutTransaction } from './checkout';
import { Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { prepareDemoCreation } from './demoAsset';
import { connection, verifyNetwork } from './payments';
import { withWallet } from './walletTransport';
import { config, devnetUsdc } from './config';
import type { Asset } from './assets';
import type { PendingPayment } from './payments';
import { authorizedAddress, signDemoCreation, signAssetTransfer, submitSignedPayment, type WalletSession } from './signing';
export type { WalletSession } from './signing';

export async function connectWallet(): Promise<WalletSession> {
  return withWallet(async (wallet) => {
    const result = await wallet.authorize({ chain: config.chain, identity: config.identity });
    const account = result.accounts[0];
    if (!account) throw new Error('The wallet returned no account.');
    return { address: authorizedAddress(account.address), authToken: result.auth_token };
  });
}

export async function disconnectWallet(session: WalletSession) {
  await withWallet((wallet) => wallet.deauthorize({ auth_token: session.authToken }));
}

export async function sendAsset(
  session: WalletSession,
  receiver: string,
  amount: string,
  rememberBeforeBroadcast: (payment: PendingPayment) => Promise<void>,
  updateSession: (session: WalletSession) => void,
  asset: Asset = devnetUsdc,
): Promise<PendingPayment> {
  // Sign only: derive and persist the signature BEFORE broadcast, so an RPC timeout
  // or app restart cannot turn a possibly successful transfer into a blind retry.
  const signed = await withWallet((wallet) => signAssetTransfer(wallet, session, receiver, amount, updateSession, undefined, asset));
  return submitSignedPayment(signed, rememberBeforeBroadcast);
}

export async function createDemoAsset(
  session: WalletSession,
  rememberMint: (address: string) => Promise<unknown>,
  updateSession: (session: WalletSession) => void,
): Promise<string> {
  await verifyNetwork(connection);
  const prepared = await prepareDemoCreation(session.address, connection);
  const address = prepared.mint.toBase58();
  if (!prepared.transaction) { await rememberMint(address); return address; }
  const transaction = prepared.transaction;
  const signed = await withWallet((wallet) => signDemoCreation(wallet, session, transaction, updateSession));
  // Remember the deterministic mint before broadcasting. Retry always targets
  // the same account, so a timeout cannot create a second supply or mint.
  await rememberMint(address);
  const expectedSignature = bs58.encode(Transaction.from(signed).signature!);
  try {
    const returned = await connection.sendRawTransaction(signed, { skipPreflight: false, maxRetries: 3 });
    if (returned !== expectedSignature) throw new Error('RPC signature mismatch.');
  } catch (cause) {
    throw new Error('Demo creation is not confirmed. The mint address is saved. Refresh its balance or retry creation with the same wallet; this cannot create a second mint.', { cause });
  }
  return address;
}

export async function signCheckout(
  session: WalletSession, transaction: Transaction, updateSession: (session: WalletSession) => void,
): Promise<Transaction> {
  return withWallet((wallet) => signCheckoutTransaction(wallet, session, transaction, updateSession));
}
