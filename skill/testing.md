# testing.md — prove the integration with LiteSVM

Covers: how to write LiteSVM tests that prove a Token-2022 integration is safe. Read this when you've written guard logic (see [SKILL.md](SKILL.md)) and need the anti-slop bar: **a test that FAILS without the guard and PASSES with it.** Working tests live in [../examples/guard/tests/](../examples/guard/tests/).

## The bar (read this first)

A submission that only ships happy-path tests proves nothing. The standard here is two artifacts:

1. **A footgun test** — a raw Token-2022 transfer (no guard) where `credited != sent`. This is the bug your guard exists to prevent. See [footgun.test.ts](../examples/guard/tests/footgun.test.ts).
2. **The guard tests** — the same scenario through your program, asserting it either (a) credits the *received* amount via delta-measure, or (b) fails closed on a custody-dangerous extension. See [guard.test.ts](../examples/guard/tests/guard.test.ts) and [guard-rejects.test.ts](../examples/guard/tests/guard-rejects.test.ts).

If you can't write #1, you don't understand the threat. If #2 doesn't reference #1's scenario, you haven't proven the fix. 6 tests pass in `../examples/guard`.

## Stack facts you must internalize

| Fact | Consequence |
|---|---|
| **litesvm 1.2.0 is kit-native** (`@solana/kit`, not web3.js v1) | `airdrop`/`getBalance`/`getAccount` take a kit `Address` (base58 via `address("...")`); lamports are `bigint`; `sendTransaction` wants a **kit** `Transaction`. |
| `new LiteSVM()` **preloads** Token-2022 (`TokenzQdB…` v11), ATA (`ATokenGPv…`), SPL Token, Memo, ALT, Stake | **Do NOT `addProgramFromFile` these.** Only your own `.so` needs loading. (`LiteSVM.default()` is minimal — needs `.withBuiltins().withSysvars().withDefaultPrograms()`.) |
| spl-token 0.4.14 builders default to **legacy** Token | Every builder's LAST arg MUST be `TOKEN_2022_PROGRAM_ID`, or you get an owner-mismatch failure. |
| Anchor isn't on-chain in your client | Tests in [helpers.ts](../examples/guard/tests/helpers.ts) hand-encode the 8-byte discriminator (`sha256("global:<ix>")[..8]`) — no `@coral-xyz/anchor` client dep. |

Test toolchain: `vitest` (not ts-mocha). `package.json` → `"test": "vitest run"`.

## The web3.js → kit bridge

The whole suite builds instructions with `@solana/spl-token` (web3.js v1 types), then submits through kit-native LiteSVM. The bridge is one function — copy it verbatim from [helpers.ts](../examples/guard/tests/helpers.ts):

```ts
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import { LiteSVM, FailedTransactionMetadata, TransactionMetadata } from "litesvm";

export function send(svm, ixs, signers): TransactionMetadata {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash(); // kit Blockhash string; web3.js accepts it
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  // serialize web3.js tx → decode into a kit Transaction → submit
  const res = svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
  if (res instanceof FailedTransactionMetadata)
    throw new TxError(res.err().toString(), res.meta().logs());
  return res as TransactionMetadata;
}
```

Pair it with an `expectFail` that returns joined logs so you can assert on the error variant (e.g. `ForbiddenExtension`) rather than just "it threw":

```ts
export function expectFail(svm, ixs, signers): string {
  try { send(svm, ixs, signers); }
  catch (e) { if (e instanceof TxError) return `${e.message}\n${e.logs.join("\n")}`; throw e; }
  throw new Error("expected transaction to fail, but it succeeded");
}
```

Airdrop with kit types: `svm.airdrop(address(kp.publicKey.toBase58()), lamports(100n * 1_000_000_000n))`.

## Minting a Token-2022 mint WITH an extension

One transaction, **mint co-signs**, and the order is load-bearing: `createAccount` → all `InitializeXConfig` ix → `InitializeMint` **last**. Extension-init instructions MUST precede `InitializeMint`. The `createMint` helper takes an opts bag and pushes the right ix per extension ([helpers.ts](../examples/guard/tests/helpers.ts) lines 97–173):

```ts
const space = getMintLen(exts);                          // exts: ExtensionType[]
const rent  = svm.minimumBalanceForRentExemption(BigInt(space));
const ixs = [ SystemProgram.createAccount({
  fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
  space, lamports: Number(rent), programId: TOKEN_2022_PROGRAM_ID }) ];

if (opts.transferFee)       ixs.push(createInitializeTransferFeeConfigInstruction(
  mint.publicKey, payer.publicKey, payer.publicKey, opts.transferFee.bps, opts.transferFee.maxFee, TOKEN_2022_PROGRAM_ID));
if (opts.permanentDelegate) ixs.push(createInitializePermanentDelegateInstruction(
  mint.publicKey, opts.permanentDelegate, TOKEN_2022_PROGRAM_ID));
if (opts.defaultFrozen)     ixs.push(createInitializeDefaultAccountStateInstruction(
  mint.publicKey, AccountState.Frozen, TOKEN_2022_PROGRAM_ID));
if (opts.transferHook)      ixs.push(createInitializeTransferHookInstruction(
  mint.publicKey, payer.publicKey, opts.transferHook, TOKEN_2022_PROGRAM_ID));

// DefaultAccountState=Frozen REQUIRES a freeze authority (else InitializeMint fails).
const freezeAuth = opts.defaultFrozen ? payer.publicKey : null;
ixs.push(createInitializeMintInstruction(mint.publicKey, decimals, payer.publicKey, freezeAuth, TOKEN_2022_PROGRAM_ID));
send(svm, ixs, [payer, mint]);
```

Usage: `createMint(svm, payer, { transferFee: { bps: 500, maxFee: 1_000_000_000n } })`, or `{ permanentDelegate }`, `{ defaultFrozen: true }`, `{ transferHook }`. See [extension-allowlist-pattern.md](extension-allowlist-pattern.md) for which to allow vs block, and [transfer-fee-accounting.md](transfer-fee-accounting.md) for fee math.

## Loading your guard program

Build first (`anchor build`), then load the single `.so` at its `declare_id!`. The program id MUST equal `declare_id` / `Anchor.toml` or CPIs resolve to nothing:

```ts
export function loadGuard(svm: LiteSVM): void {
  const soPath = fileURLToPath(new URL("../target/deploy/guard.so", import.meta.url));
  svm.addProgramFromFile(address(GUARD_PROGRAM_ID.toBase58()), soPath);
}
```

Again: **do not** load Token-2022 or ATA — they're already there. Loading them yourself shadows the preloaded versions and is a common cause of mystery failures.

## Reading account state (no Anchor client)

LiteSVM `getAccount` returns a kit account with `data: Uint8Array`. The helpers read raw offsets — fast and dependency-free:

```ts
// SPL token account: amount is u64 LE at offset 64.
export function readAccountAmount(svm, tokenAccount): bigint {
  const raw = svm.getAccount(address(tokenAccount.toBase58()));
  return Buffer.from(raw.data).readBigUInt64LE(64);
}
// Guard Position: 8 disc + owner(32) + vault(32) → deposited u64 LE at offset 72.
export function readPositionDeposited(svm, position): bigint {
  const raw = svm.getAccount(address(position.toBase58()));
  return Buffer.from(raw.data).readBigUInt64LE(72);
}
```

(If you prefer typed reads: `unpackAccount(addr, {...}, TOKEN_2022_PROGRAM_ID).amount`, and `program.coder.accounts.decode(...)` for your PDAs. Raw offsets are used here to keep the test free of an Anchor client dep.)

## Walkthrough of the three test files

### footgun.test.ts — the bug, with NO guard
Mint a 5% transfer-fee token, fund Alice, transfer `100_000_000` to Bob with a raw `createTransferCheckedInstruction`, then assert the delta:

```ts
const credited = readAccountAmount(svm, bobAta);
const expectedFee = (sent * 500n) / 10_000n; // 5_000_000
expect(credited).not.toBe(sent);             // naive `credited === sent` is FALSE
expect(credited).toBe(sent - expectedFee);   // 95_000_000 actually arrived
```
This is why crediting shares on the *sent* amount over-issues and makes an integrator insolvent. No guard is loaded — it's the baseline.

### guard.test.ts — the fix, accounting stays exact
- **Clean mint:** deposit 1_000_000, withdraw 400_000; position deposited and vault ATA both track exactly (`1_000_000` → `600_000`). Fee-free path is conserved.
- **Transfer-fee mint:** fee is **allowed** (handled, not blocked). Deposit `requested = 100_000_000`; the guard credits the **received** `95_000_000` by delta-measuring the vault ATA balance, NOT the requested amount:
```ts
expect(readPositionDeposited(svm, position)).toBe(received);     // 95_000_000
expect(readPositionDeposited(svm, position)).not.toBe(requested);// not 100_000_000
```
This is the exact footgun scenario, now correct. That contrast is the proof.

### guard-rejects.test.ts — fails closed on dangerous extensions
Three mints carrying custody-dangerous extensions are each rejected at `init_vault`, asserted on the error variant in the logs:
```ts
const mint = createMint(svm, payer, { permanentDelegate: delegate });
const logs = expectFail(svm, [initVaultIx(payer.publicKey, mint)], [payer]);
expect(logs).toContain("ForbiddenExtension");
```
Covered: `PermanentDelegate` (issuer drains the vault), `DefaultAccountState=Frozen` (deposits silently fail), `TransferHook` (arbitrary CPI / reentrancy each transfer). The unsafe token can never even be deposited — the gate is at init, before any token moves.

## Running

```sh
cd examples/guard
anchor build --ignore-keys   # produces target/deploy/guard.so at the source declare_id
                             # (keypair isn't committed; Anchor 1.0 errors on id mismatch without this)
npm test              # or: bun run test  → vitest run, 6 passing
```
If `loadGuard` throws on a missing `.so`, you skipped `anchor build`. If a transfer fails with an owner mismatch, a spl-token builder is missing its trailing `TOKEN_2022_PROGRAM_ID`.

## DO / DON'T

- **DO** ship a footgun test that fails the naive assumption WITHOUT your program, and a guard test on the same scenario that passes.
- **DO** assert on the error variant string (`ForbiddenExtension`) for negative tests, not just "it threw".
- **DO** add the trailing `TOKEN_2022_PROGRAM_ID` to every spl-token builder; pass kit `address(...)`/`bigint` lamports to LiteSVM.
- **DON'T** `addProgramFromFile` Token-2022, ATA, or SPL Token — `new LiteSVM()` preloads them.
- **DON'T** assert `credited === sent` for a fee mint — delta-measure the recipient balance.
- **DON'T** reorder mint init: extension-init ix must come BEFORE `InitializeMint`, and the mint must co-sign.
- **DON'T** assume web3.js v1 LiteSVM APIs; 1.2.0 is kit-native — bridge via `getTransactionDecoder().decode(tx.serialize())`.
