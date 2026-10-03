import type { Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { Buffer } from 'buffer';
import { PublicKey, type Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config, devnetUsdc, validateAsset } from './config';
import type { Asset } from './assets';
import { connection, prepareTransfer, recipientKey, type PendingPayment } from './payments';
import { formatAssetAmount, parseAssetAmount } from './amount';

export type WalletSession = { address: PublicKey; authToken: string };
export type SignedPayment = { payment: PendingPayment; raw: Buffer };

export function authorizedAddress(address: string): PublicKey {
  const bytes = Buffer.from(address, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== address) {
    throw new Error('The wallet returned an invalid account address.');
  }
  return recipientKey(new PublicKey(bytes).toBase58());
}

export async function signAssetTransfer(
  wallet: Pick<Web3MobileWallet, 'authorize' | 'signTransactions'>,
  session: WalletSession,
  receiverText: string,
  amountText: string,
  updateSession: (session: WalletSession) => void,
  prepare: typeof prepareTransfer = prepareTransfer,
  asset: Asset = devnetUsdc,
): Promise<SignedPayment> {
  validateAsset(asset);
  // Snapshot the reviewed values before crossing the wallet boundary.
  const receiver = recipientKey(receiverText, session.address).toBase58();
  const amount = formatAssetAmount(parseAssetAmount(amountText, asset), asset);
  const auth = await wallet.authorize({
    chain: config.chain, identity: config.identity, auth_token: session.authToken,
  });
  const account = auth.accounts[0];
  if (!account || !authorizedAddress(account.address).equals(session.address)) {
    throw new Error('Wallet account changed. Reconnect and review the payment again.');
  }
  updateSession({ address: session.address, authToken: auth.auth_token });
  const { transaction, latest } = await prepare(session.address, receiver, amount, undefined, asset);
  const originalMessage = Buffer.from(transaction.serializeMessage());
  const signedTransactions = await wallet.signTransactions({ transactions: [transaction] });
  const signed = signedTransactions[0];
  if (signedTransactions.length !== 1 || !signed || !originalMessage.equals(signed.serializeMessage()) || !signed.signature) {
    throw new Error('Wallet returned an unexpected transaction. Nothing was submitted.');
  }
  // Serialization verifies every required signature, not merely its presence.
  const raw = signed.serialize({ requireAllSignatures: true, verifySignatures: true });
  return {
    raw,
    payment: { ...latest, mint: asset.mint.toBase58(), tokenProgram: asset.tokenProgram.toBase58(), signature: bs58.encode(signed.signature), sender: session.address.toBase58(), receiver, amount },
  };
}

export async function submitSignedPayment(
  signed: SignedPayment,
  rememberBeforeBroadcast: (payment: PendingPayment) => Promise<void>,
  broadcast: typeof connection.sendRawTransaction = connection.sendRawTransaction.bind(connection),
): Promise<PendingPayment> {
  // A failed local write must prevent broadcast. A broadcast timeout must retain
  // the known signature so recovery queries the same payment instead of retrying.
  await rememberBeforeBroadcast(signed.payment);
  const returnedSignature = await broadcast(signed.raw, { skipPreflight: false, maxRetries: 3 });
  if (returnedSignature !== signed.payment.signature) {
    throw new Error('RPC returned a different signature. Check the saved payment before continuing.');
  }
  return signed.payment;
}

export async function signDemoCreation(
  wallet: Pick<Web3MobileWallet, 'authorize' | 'signTransactions'>,
  session: WalletSession,
  transaction: Transaction,
  updateSession: (session: WalletSession) => void,
): Promise<Buffer> {
  const message = Buffer.from(transaction.serializeMessage());
  const auth = await wallet.authorize({ chain: config.chain, identity: config.identity, auth_token: session.authToken });
  if (!auth.accounts[0] || !authorizedAddress(auth.accounts[0].address).equals(session.address)) {
    throw new Error('Wallet account changed. Reconnect before creating the demo asset.');
  }
  updateSession({ ...session, authToken: auth.auth_token });
  const results = await wallet.signTransactions({ transactions: [transaction] });
  if (results.length !== 1 || !results[0] || !message.equals(results[0].serializeMessage())) {
    throw new Error('Wallet changed the demo creation transaction. Nothing was submitted.');
  }
  return results[0].serialize({ requireAllSignatures: true, verifySignatures: true });
}
