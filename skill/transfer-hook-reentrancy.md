# Transfer Hooks & Reentrancy (integrator side)

What this covers: why a `TransferHook` mint runs **issuer-controlled code inside your transfer CPI**, the three attack classes that creates (reentrancy, CPI-depth DoS, ExtraAccountMetaList injection), and why the reference guard's default is to **REJECT hook mints outright**. Read this when a scan flags `TransferHook`, or before you decide to support one. Assumes you've read [SKILL.md](SKILL.md).

---

## The core problem

`TransferHook` (mint ext, `ExtensionType::TransferHook`, JS getter `getTransferHook(mint)`) registers a third-party program that **Token-2022 invokes on every `transfer_checked`**. When your vault does a transfer to/from a hook mint:

```
your_program  → CPI → token-2022 (transfer_checked)  → CPI → ISSUER'S HOOK PROGRAM
```

That last hop is **attacker-authored code, with attacker-chosen extra accounts**, executing *synchronously inside your instruction* before `transfer_checked` returns. You did not write it, you cannot audit it at integration time (the hook `authority` can repoint `programId` later), and it can do anything its account set allows.

Three concrete failure modes (reference §5 row 6 — Neodyme / Zealynx threat model; no single named on-chain exploit, but the design hazard is real and is why every major DEX allowlists hooks):

| Attack | Mechanism | Impact on your vault |
|---|---|---|
| **Reentrancy** | Hook calls back into *your* program (e.g. `withdraw`) before your first transfer's accounting settles | Double-spend / drain if you mutate state *after* the CPI |
| **CPI-depth griefing / DoS** | Solana CPI depth limit is 4; the hook consumes one level. Deep call stacks (your prog → token-2022 → hook → …) hit the cap | Your transfer reverts unpredictably; withdrawals/liquidations brick |
| **ExtraAccountMetaList injection** | Hook declares required extra accounts via an on-chain `ExtraAccountMetaList` PDA; the client must resolve & pass them. A malicious list forces accounts the hook then reads/writes | Hook reads/mutates injected accounts; conditional logic can selectively DoS or front-run |

A hook can also be **conditionally failing**: pass normally for months, then start reverting transfers for a target address — a withdrawal blackhole you can't fix.

---

## Default stance: REJECT (what the guard does)

The reference guard fails **closed**. `TransferHook` is on the forbidden list in `enforce_extension_allowlist`, so `init_vault` reverts before a hook mint can ever be custodied — see [`../examples/guard/programs/guard/src/lib.rs`](../examples/guard/programs/guard/src/lib.rs):

```rust
ExtensionType::TransferHook
| ExtensionType::PermanentDelegate
| ExtensionType::NonTransferable
| ExtensionType::DefaultAccountState
| ExtensionType::ConfidentialTransferMint => {
    return err!(GuardError::ForbiddenExtension)
}
```

This is proven by [`guard-rejects.test.ts`](../examples/guard/tests/guard-rejects.test.ts):

```ts
it("rejects a TransferHook mint (arbitrary CPI / reentrancy on every transfer)", () => {
  const hookProgram = Keypair.generate().publicKey;
  const mint = createMint(svm, payer, { decimals: 6, transferHook: hookProgram });
  const logs = expectFail(svm, [initVaultIx(payer.publicKey, mint)], [payer]);
  expect(logs).toContain("ForbiddenExtension");
});
```

> **Key point:** because the guard rejects hook mints at init, **reentrancy is structurally impossible** for this vault — no hook ever runs inside its CPIs. The reentrancy lock in `withdraw` (below) is therefore **defense-in-depth**, not the primary control. The primary control is the allowlist. See [extension-allowlist-pattern.md](extension-allowlist-pattern.md).

The scanner mirrors this stance — [`../tools/t22-scan/src/risk.ts`](../tools/t22-scan/src/risk.ts) flags `TransferHook` and recommends: *"Reject unknown hook programs. If you must support one, allowlist the specific hook program id, apply checks-effects-interactions, set a reentrancy/transferring flag, and resolve extra accounts safely."* Note it distinguishes a **set** hook from an **inert** one (`getTransferHook` present but no `programId` → `"no hook program set (inert)"`); an inert hook is harmless until the authority sets one, so don't cache that judgment (reference §5 row 8 — re-validate at use).

---

## The reentrancy lock (defense-in-depth)

Even with hooks rejected, the guard's `withdraw` is written as if a CPI *could* re-enter — this is the pattern to copy if you ever relax the allowlist. From [`../examples/guard/programs/guard/src/lib.rs`](../examples/guard/programs/guard/src/lib.rs), `withdraw`:

```rust
// 1) CHECK + LOCK.
require!(!ctx.accounts.vault.locked, GuardError::Reentrancy);
ctx.accounts.vault.locked = true;

// 2) EFFECTS — mutate accounting BEFORE the external CPI.
position.deposited = position.deposited
    .checked_sub(amount).ok_or(GuardError::InsufficientBalance)?;
ctx.accounts.vault.total_deposited =
    vault_total.checked_sub(amount).ok_or(GuardError::Underflow)?;

// 3) INTERACTION — PDA-signed transfer out (may invoke a hook, if allowed).
transfer_checked(
    CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),   // Pubkey via .key(), NOT AccountInfo
        TransferChecked { from, mint, to, authority },
        signer_seeds,
    ),
    amount,
    ctx.accounts.mint.decimals,
)?;

// 4) UNLOCK.
ctx.accounts.vault.locked = false;
```

Why each step matters:

- **Checks-Effects-Interactions (CEI):** state is debited *before* the transfer CPI. If a hook re-enters `withdraw`, the balance is already gone, so the re-entrant call sees the reduced `position.deposited` and the lock — it can't double-withdraw.
- **`locked` flag:** the re-entrant call hits `require!(!locked)` → `GuardError::Reentrancy` and reverts the whole tx. Belt-and-suspenders on top of CEI; CEI alone protects this function, the flag protects *cross-function* re-entry (e.g. hook calling a different mutating instruction).
- **`CpiContext::new_with_signer` takes a `Pubkey`** (`ctx.accounts.token_program.key()`), not an `AccountInfo` — this is the anchor-spl 1.0.2 / spl-token-2022-interface 2.1.0 signature. Do not pass `.to_account_info()` for the program id.

Contrast with `deposit` in the same file: it has no lock because it credits via **balance delta** (`after - before` after `reload()`), which is itself reentrancy-resistant for accounting — but it still re-runs `enforce_extension_allowlist` because a mint's hook authority can change after init. See [transfer-fee-accounting.md](transfer-fee-accounting.md) for the delta pattern.

---

## If you MUST support a specific hook

Only with a concrete, justified reason (e.g. a partner's verifiably-built hook). Required controls, all of them:

1. **Allowlist the exact `programId`**, not "has a hook." Read it on-chain and compare against a hardcoded/PDA-stored pubkey. Mirror Orca's TokenBadge pattern (reference §5 row 3): public source + **Verifiable Build** required before a hook is trusted.
2. **Re-validate at every use**, never cache. The hook `authority` can repoint `programId`; `MintCloseAuthority` close+reinit can swap assumptions (reference §5 row 8). The guard already re-calls `enforce_extension_allowlist` inside `deposit` and `withdraw` for exactly this reason.
3. **CEI + reentrancy lock** as shown above — non-negotiable once a CPI can run foreign code.
4. **Bound CPI depth.** Keep your own call stack shallow so `your_prog → token-2022 → hook` doesn't blow the depth-4 limit. Don't custody-transfer hook mints from inside another nested CPI.
5. **Resolve extra accounts safely on the client.** Don't hand-build the account list. Use the SDK resolver, which reads the on-chain `ExtraAccountMetaList` for you:

```ts
import { createTransferCheckedWithTransferHookInstruction } from "@solana/spl-token"; // 0.4.14

const ix = await createTransferCheckedWithTransferHookInstruction(
  connection, source, mint, destination, owner,
  amount, decimals,
  [],                       // extra signers
  "confirmed",
  TOKEN_2022_PROGRAM_ID,
);
```

   This appends precisely the extra accounts the hook declares — but remember those accounts are still **issuer-controlled inputs**; the on-chain program must not trust their contents for authorization.

---

## DO / DON'T

**DO**
- Default-deny: reject hook mints unless you have a vetted, allowlisted, verifiably-built hook program id.
- Write withdraws with CEI + a `locked` flag even when hooks are rejected (defense-in-depth).
- Re-read the mint's extensions on **every** privileged instruction; never cache trust.
- Resolve extra accounts with `createTransferCheckedWithTransferHookInstruction`, not by hand.

**DON'T**
- Treat "the transfer ix didn't revert" as proof of safety — a hook can conditionally fail or re-enter.
- Mutate accounting *after* the transfer CPI.
- Pass an `AccountInfo` as the program id to `CpiContext::new[_with_signer]` — it takes a `Pubkey`.
- Assume an inert hook (no `programId`) stays inert — the authority can set one later.
