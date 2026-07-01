import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { LiteSVM, FailedTransactionMetadata, TransactionMetadata } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  type Signer,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  AccountState,
  getMintLen,
  getAssociatedTokenAddressSync,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";

export const GUARD_PROGRAM_ID = new PublicKey(
  "4yGL5iFhDj1vaz2XmhPejauPZmdcRBUX6kkifhpxTXTH",
);

/** Create a fresh LiteSVM (Token-2022 + ATA programs are preloaded). */
export function newSvm(): LiteSVM {
  return new LiteSVM();
}

/** Load the compiled guard program at its declare_id. Build it first: `anchor build`. */
export function loadGuard(svm: LiteSVM): void {
  const soPath = fileURLToPath(new URL("../target/deploy/guard.so", import.meta.url));
  svm.addProgramFromFile(address(GUARD_PROGRAM_ID.toBase58()), soPath);
}

export function fund(svm: LiteSVM, kp: Keypair, sol = 100n): void {
  svm.airdrop(address(kp.publicKey.toBase58()), lamports(sol * 1_000_000_000n));
}

/** Bridge: build/sign a web3.js v1 tx, submit through kit-native LiteSVM. */
export function send(
  svm: LiteSVM,
  ixs: TransactionInstruction[],
  signers: Signer[],
): TransactionMetadata {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const res = svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  if (res instanceof FailedTransactionMetadata) {
    throw new TxError(res.err().toString(), res.meta().logs());
  }
  return res as TransactionMetadata;
}

/** Like send, but expects failure; returns the joined program logs for assertions. */
export function expectFail(
  svm: LiteSVM,
  ixs: TransactionInstruction[],
  signers: Signer[],
): string {
  try {
    send(svm, ixs, signers);
  } catch (e) {
    if (e instanceof TxError) return `${e.message}\n${e.logs.join("\n")}`;
    throw e;
  }
  throw new Error("expected transaction to fail, but it succeeded");
}

export class TxError extends Error {
  constructor(msg: string, public logs: string[]) {
    super(msg);
  }
}

// ---------- Token-2022 mint builders ----------

interface MintOpts {
  decimals?: number;
  transferFee?: { bps: number; maxFee: bigint };
  permanentDelegate?: PublicKey;
  defaultFrozen?: boolean;
  transferHook?: PublicKey;
}

/** Create a Token-2022 mint with the requested extensions (one tx, mint co-signs). */
export function createMint(svm: LiteSVM, payer: Keypair, opts: MintOpts = {}): PublicKey {
  const decimals = opts.decimals ?? 6;
  const mint = Keypair.generate();
  const exts: ExtensionType[] = [];
  if (opts.transferFee) exts.push(ExtensionType.TransferFeeConfig);
  if (opts.permanentDelegate) exts.push(ExtensionType.PermanentDelegate);
  if (opts.defaultFrozen) exts.push(ExtensionType.DefaultAccountState);
  if (opts.transferHook) exts.push(ExtensionType.TransferHook);

  const space = getMintLen(exts);
  const rent = svm.minimumBalanceForRentExemption(BigInt(space));

  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports: Number(rent),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ];
  // Extension-init instructions MUST precede InitializeMint.
  if (opts.transferFee) {
    ixs.push(
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        payer.publicKey,
        payer.publicKey,
        opts.transferFee.bps,
        opts.transferFee.maxFee,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (opts.permanentDelegate) {
    ixs.push(
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        opts.permanentDelegate,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (opts.defaultFrozen) {
    ixs.push(
      createInitializeDefaultAccountStateInstruction(
        mint.publicKey,
        AccountState.Frozen,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  if (opts.transferHook) {
    ixs.push(
      createInitializeTransferHookInstruction(
        mint.publicKey,
        payer.publicKey,
        opts.transferHook,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  // DefaultAccountState=Frozen requires a freeze authority.
  const freezeAuth = opts.defaultFrozen ? payer.publicKey : null;
  ixs.push(
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      payer.publicKey,
      freezeAuth,
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  send(svm, ixs, [payer, mint]);
  return mint.publicKey;
}

export function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
}

/** Create an ATA for `owner` and mint `amount` into it (payer is the mint authority). */
export function createAtaAndMint(
  svm: LiteSVM,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
): PublicKey {
  const acc = ata(mint, owner);
  send(
    svm,
    [
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        acc,
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      createMintToInstruction(mint, acc, payer.publicKey, amount, [], TOKEN_2022_PROGRAM_ID),
    ],
    [payer],
  );
  return acc;
}

// ---------- Anchor instruction encoding (no client dependency) ----------

function disc(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

export function anchorIx(
  name: string,
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
  args?: bigint,
): TransactionInstruction {
  const data = args === undefined ? disc(name) : Buffer.concat([disc(name), u64le(args)]);
  return new TransactionInstruction({ programId: GUARD_PROGRAM_ID, keys, data });
}

export const vaultPda = (mint: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], GUARD_PROGRAM_ID);

export const positionPda = (vault: PublicKey, owner: PublicKey): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("position"), vault.toBuffer(), owner.toBuffer()],
    GUARD_PROGRAM_ID,
  );

const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

export function initVaultIx(authority: PublicKey, mint: PublicKey): TransactionInstruction {
  const [vault] = vaultPda(mint);
  const vaultAta = ata(mint, vault);
  return anchorIx("init_vault", [
    m(authority, true, true),
    m(mint),
    m(vault, true),
    m(vaultAta, true),
    m(TOKEN_2022_PROGRAM_ID),
    m(ASSOCIATED_TOKEN_PROGRAM_ID),
    m(SystemProgram.programId),
  ]);
}

export function openPositionIx(owner: PublicKey, mint: PublicKey): TransactionInstruction {
  const [vault] = vaultPda(mint);
  const [position] = positionPda(vault, owner);
  return anchorIx("open_position", [
    m(owner, true, true),
    m(vault),
    m(position, true),
    m(SystemProgram.programId),
  ]);
}

export function depositIx(
  user: PublicKey,
  mint: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const [vault] = vaultPda(mint);
  const [position] = positionPda(vault, user);
  return anchorIx(
    "deposit",
    [
      m(user, true, true),
      m(mint),
      m(vault, true),
      m(ata(mint, vault), true),
      m(ata(mint, user), true),
      m(position, true),
      m(user),
      m(TOKEN_2022_PROGRAM_ID),
    ],
    amount,
  );
}

export function withdrawIx(
  user: PublicKey,
  mint: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const [vault] = vaultPda(mint);
  const [position] = positionPda(vault, user);
  return anchorIx(
    "withdraw",
    [
      m(user, true, true),
      m(mint),
      m(vault, true),
      m(ata(mint, vault), true),
      m(ata(mint, user), true),
      m(position, true),
      m(user),
      m(TOKEN_2022_PROGRAM_ID),
    ],
    amount,
  );
}

// ---------- account readers ----------

export function readAccountAmount(svm: LiteSVM, tokenAccount: PublicKey): bigint {
  const raw = svm.getAccount(address(tokenAccount.toBase58()));
  if (!raw || !raw.data) throw new Error("token account not found");
  // SPL token account layout: amount is a u64 LE at offset 64.
  return Buffer.from(raw.data).readBigUInt64LE(64);
}

export function readPositionDeposited(svm: LiteSVM, position: PublicKey): bigint {
  const raw = svm.getAccount(address(position.toBase58()));
  if (!raw || !raw.data) throw new Error("position not found");
  // Position: 8 disc + owner(32) + vault(32) => deposited u64 LE at offset 72.
  return Buffer.from(raw.data).readBigUInt64LE(72);
}

export { Keypair, PublicKey };
