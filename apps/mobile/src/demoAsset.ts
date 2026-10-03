import { PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TokenError, ExtensionType, getMint, getMintLen, getAccountLen,
  getExtensionTypes, getScaledUiAmountConfig, type Mint, AuthorityType,
  createInitializeScaledUiAmountConfigInstruction, createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
  createMintToCheckedInstruction, createSetAuthorityInstruction,
} from '@solana/spl-token';
import type { Asset } from './assets';

export const DEMO_SEED = 'tap-pay-aaplx-demo-v1';
export const DEMO_RAW_SUPPLY = 500_000_000n; // 1,000 UI tokens at multiplier 2.

export function demoAsset(mint: PublicKey): Asset {
  return Object.freeze({ mint, symbol: 'AAPLx-DEMO', name: 'AAPLx-DEMO', decimals: 6,
    tokenProgram: TOKEN_2022_PROGRAM_ID, isDemo: true,
    display: Object.freeze({ kind: 'scaled' as const, multiplier: 2 as const }),
  });
}

// Deliberately accept only this immutable demo profile, not arbitrary xStocks.
// Mutable/scheduled multipliers and transfer-affecting extensions need a later integration.
export function validateDemoMint(mint: Mint): void {
  const scaled = getScaledUiAmountConfig(mint);
  const extensions = getExtensionTypes(mint.tlvData);
  if (!mint.isInitialized || mint.decimals !== 6 || mint.mintAuthority || mint.freezeAuthority
      || extensions.length !== 1 || extensions[0] !== ExtensionType.ScaledUiAmountConfig
      || !scaled || !scaled.authority.equals(PublicKey.default)
      || scaled.multiplier !== 2 || scaled.newMultiplier !== 2) {
    throw new Error('Unsupported demo mint. Expected immutable Token-2022 Scaled UI Amount ×2 with no mint/freeze authority.');
  }
}

export async function readDemoMint(address: PublicKey, rpc: Connection): Promise<Asset> {
  const mint = await getMint(rpc, address, 'confirmed', TOKEN_2022_PROGRAM_ID).catch((cause: unknown) => {
    if (cause instanceof TokenError) {
      throw new Error('Demo mint is unavailable or is not a valid Token-2022 mint. Check the address; if just created, wait for confirmation and refresh.', { cause });
    }
    throw cause;
  });
  validateDemoMint(mint);
  return demoAsset(address);
}

export async function prepareDemoCreation(owner: PublicKey, rpc: Connection) {
  const mint = await PublicKey.createWithSeed(owner, DEMO_SEED, TOKEN_2022_PROGRAM_ID);
  if (await rpc.getAccountInfo(mint, 'confirmed')) {
    await readDemoMint(mint, rpc);
    return { mint, transaction: null };
  }
  const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  // Token-2022 associated accounts include ImmutableOwner even without other account extensions.
  const [rent, accountRent, latest, balance] = await Promise.all([
    rpc.getMinimumBalanceForRentExemption(space),
    rpc.getMinimumBalanceForRentExemption(getAccountLen([ExtensionType.ImmutableOwner])),
    rpc.getLatestBlockhash('confirmed'), rpc.getBalance(owner, 'confirmed'),
  ]);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const transaction = new Transaction({ feePayer: owner, ...latest }).add(
    SystemProgram.createAccountWithSeed({ fromPubkey: owner, basePubkey: owner, seed: DEMO_SEED,
      newAccountPubkey: mint, lamports: rent, space, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeScaledUiAmountConfigInstruction(mint, null, 2),
    createInitializeMint2Instruction(mint, 6, owner, null, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, ata, owner, DEMO_RAW_SUPPLY, 6, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, owner, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  );
  const fee = (await rpc.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value;
  if (fee === null || balance < rent + accountRent + fee) throw new Error('Not enough Devnet SOL to create the demo asset and pay account rent.');
  return { mint, transaction };
}
