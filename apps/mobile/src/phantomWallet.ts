import { Buffer } from 'buffer';
import { PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { WalletClient } from './walletClient';

export const PHANTOM_APP_URL = 'https://github.com/Zack5937/TapPop';
const CALLBACK = 'tappay://wallet/phantom';
const MAX_RESPONSE = 16_384;

export interface PhantomTransport {
  open(url: string): Promise<void>;
  subscribe(receive: (url: string) => void): () => void;
}

type Session = {
  address: PublicKey;
  token: string;
  encryptionPublicKey: Uint8Array;
  shared: Uint8Array;
};

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function field(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_RESPONSE) {
    throw new Error('Phantom returned an invalid response. Reconnect and retry.');
  }
  return value;
}

function bytes(value: unknown, length?: number): Uint8Array {
  const text = field(value);
  const result = bs58.decode(text);
  if (bs58.encode(result) !== text || (length !== undefined && result.length !== length)) {
    throw new Error('Phantom returned invalid encoded data.');
  }
  return result;
}

function decrypt(response: URLSearchParams, shared: Uint8Array): Record<string, unknown> {
  const plaintext = nacl.box.open.after(bytes(response.get('data')), bytes(response.get('nonce'), 24), shared);
  if (!plaintext) throw new Error('Cannot authenticate the Phantom response. Nothing was submitted.');
  const result: unknown = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Phantom response.');
  return result as Record<string, unknown>;
}

function encrypted(payload: Record<string, string>, session: Session): Record<string, string> {
  const nonce = random(24);
  return {
    dapp_encryption_public_key: bs58.encode(session.encryptionPublicKey),
    nonce: bs58.encode(nonce),
    payload: bs58.encode(nacl.box.after(Buffer.from(JSON.stringify(payload)), nonce, session.shared)),
  };
}

// This adapter never has a wallet signing key. The transient X25519 secret is
// exclusively for encrypted app-to-wallet transport, and is never persisted.
export class PhantomWallet implements WalletClient {
  private session?: Session;
  private pending = false;

  constructor(private readonly transport: PhantomTransport, private readonly timeoutMs = 120_000) {}

  private async request(method: string, params: Record<string, string>): Promise<URLSearchParams> {
    if (this.pending) throw new Error('A Phantom request is already open. Finish it before retrying.');
    const state = bs58.encode(random(32));
    const redirect = `${CALLBACK}?state=${state}`;
    const url = new URL(`https://phantom.com/ul/v1/${method}`);
    for (const [key, value] of Object.entries({ ...params, redirect_link: redirect })) url.searchParams.set(key, value);
    const deadline = Date.now() + this.timeoutMs;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.pending = true;
    try {
      return await new Promise<URLSearchParams>((resolve, reject) => {
        const expired = () => reject(new Error('Phantom request timed out. Return to the app and retry; nothing was submitted.'));
        timer = setTimeout(expired, this.timeoutMs);
        unsubscribe = this.transport.subscribe((text) => {
          if (text.length > MAX_RESPONSE) return;
          let response: URL;
          try { response = new URL(text); } catch { return; }
          if (response.protocol !== 'tappay:' || response.host !== 'wallet' || response.pathname !== '/phantom'
              || response.username || response.password || response.hash
              || response.searchParams.getAll('state').length !== 1 || response.searchParams.get('state') !== state) return;
          if (Date.now() >= deadline) { expired(); return; }
          for (const key of ['data', 'nonce', 'phantom_encryption_public_key', 'errorCode', 'errorMessage']) {
            if (response.searchParams.getAll(key).length > 1) { reject(new Error('Duplicate Phantom response fields.')); return; }
          }
          if (response.searchParams.has('errorCode')) {
            // Do not display arbitrary callback text or include callback/session data in logs.
            reject(new Error(response.searchParams.get('errorCode') === '4001'
              ? 'Phantom request was rejected. Nothing was submitted.'
              : 'Phantom could not complete the request. Check Devnet and reconnect.'));
          } else resolve(response.searchParams);
        });
        void this.transport.open(url.toString()).catch(reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
      this.pending = false;
    }
  }

  async authorize(input: Parameters<WalletClient['authorize']>[0]) {
    if (input.chain !== 'solana:devnet') throw new Error('Only Solana Devnet is supported.');
    if (this.pending) throw new Error('A Phantom request is already open.');
    if (input.auth_token) {
      if (!this.session || this.session.token !== input.auth_token) throw new Error('Phantom session ended. Reconnect your wallet.');
      return this.authorization(this.session);
    }
    this.clearSession();
    const pair = nacl.box.keyPair.fromSecretKey(random(32));
    let shared: Uint8Array | undefined;
    try {
      const response = await this.request('connect', {
        app_url: PHANTOM_APP_URL,
        cluster: 'devnet',
        dapp_encryption_public_key: bs58.encode(pair.publicKey),
      });
      shared = nacl.box.before(bytes(response.get('phantom_encryption_public_key'), 32), pair.secretKey);
      const result = decrypt(response, shared);
      const address = new PublicKey(bytes(result.public_key, 32));
      if (!PublicKey.isOnCurve(address.toBytes())) throw new Error('Invalid Phantom wallet address.');
      const token = field(result.session);
      const signedSession = nacl.sign.open(bytes(token), address.toBytes());
      if (!signedSession) throw new Error('Phantom session signature is invalid.');
      const metadata = JSON.parse(Buffer.from(signedSession).toString('utf8'));
      if (!metadata || metadata.app_url !== PHANTOM_APP_URL || metadata.chain !== 'solana' || metadata.cluster !== 'devnet') {
        throw new Error('Phantom session does not match this app and Solana Devnet.');
      }
      this.session = { address, token, encryptionPublicKey: pair.publicKey, shared };
      return this.authorization(this.session);
    } catch (error) {
      shared?.fill(0);
      throw error;
    } finally { pair.secretKey.fill(0); }
  }

  private authorization(session: Session) {
    return { accounts: [{ address: session.address.toBuffer().toString('base64') }], auth_token: session.token };
  }

  private clearSession() {
    this.session?.shared.fill(0);
    this.session = undefined;
  }

  async deauthorize({ auth_token }: { auth_token: string }): Promise<void> {
    if (this.pending) throw new Error('A Phantom request is already open.');
    const session = this.session;
    if (!session || session.token !== auth_token) { this.clearSession(); return; }
    try { await this.request('disconnect', encrypted({ session: session.token }, session)); }
    finally { this.clearSession(); }
  }

  async signTransactions({ transactions }: { transactions: Transaction[] }): Promise<Transaction[]> {
    const session = this.session;
    if (!session) throw new Error('Connect Phantom before signing.');
    if (transactions.length !== 1 || !(transactions[0] instanceof Transaction)) throw new Error('Review and sign one payment at a time.');
    const transaction = transactions[0];
    const message = Buffer.from(transaction.serializeMessage());
    const prior = transaction.signatures.filter((s) => s.signature).map((s) => ({ publicKey: s.publicKey, signature: Buffer.from(s.signature!) }));
    if (!transaction.signatures.some((s) => s.publicKey.equals(session.address))) throw new Error('The connected wallet is not a required signer.');
    const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: true });
    const response = await this.request('signTransaction', encrypted({ transaction: bs58.encode(serialized), session: session.token }, session));
    const result = decrypt(response, session.shared);
    const signed = Transaction.from(bytes(result.transaction));
    if (!message.equals(signed.serializeMessage()) || !signed.verifySignatures(false)
        || !signed.signatures.find((s) => s.publicKey.equals(session.address))?.signature
        || prior.some((s) => !signed.signatures.find((other) => other.publicKey.equals(s.publicKey))?.signature?.equals(s.signature))) {
      throw new Error('Phantom changed the transaction or returned invalid signatures. Nothing was submitted.');
    }
    return [signed];
  }
}
