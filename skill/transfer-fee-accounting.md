# transfer-fee-accounting

> Covers the #1 silent integrator bug: a Token-2022 transfer fee is withheld from the **recipient**, so **credited < sent**. Read this before you write any deposit/escrow/share-mint path that trusts the `amount` you passed to `transfer_checked`.

## The bug in one sentence

`TransferFeeConfig` (mint extension) deducts a fee on every transfer and parks it on the **destination** account as withheld balance. The recipient receives `amount − fee`. Your `amount` argument is what the sender *debited*, **not** what the vault *received**. Any 1:1 accounting that credits the `amount` argument over-issues shares/escrow and goes insolvent the moment someone withdraws.

Run-verified in [../examples/guard/tests/footgun.test.ts](../examples/guard/tests/footgun.test.ts): a raw `createTransferCheckedInstruction` of `sent = 100_000_000` at 500 bps credits the recipient exactly `95_000_000`. `credited !== sent`.

## WRONG vs RIGHT

### WRONG — trust the `amount` argument

```rust
// Over-credits by `fee`. With a 5% fee, the user gets 100 shares for 95 tokens.
transfer_checked(cpi_ctx, amount, mint.decimals)?;
position.deposited += amount;          // ← LIE. amount was debited, not received.
vault.total_deposited += amount;       // ← vault is now insolvent by `fee`.
```

This compiles, passes happy-path tests against a vanilla SPL mint (fee = 0), and silently drains the vault the first time it custodies a fee-bearing mint. The fee is **mutable per-epoch up to 100% (10000 bps)** — a mint that ships at 0 bps today can be raised tomorrow. **Handle it even when it is currently 0.**

### RIGHT — measure the balance delta (from the real `deposit()`)

From [../examples/guard/programs/guard/src/lib.rs](../examples/guard/programs/guard/src/lib.rs):

```rust
let before = ctx.accounts.vault_token_account.amount;

transfer_checked(
    CpiContext::new(
        ctx.accounts.token_program.key(),   // anchor-spl 1.0.2: Pubkey via .key(), NOT AccountInfo
        TransferChecked {
            from: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    ),
    amount,
    ctx.accounts.mint.decimals,
)?;

// MANDATORY after a CPI that mutates this account; the cached `.amount` is stale.
ctx.accounts.vault_token_account.reload()?;
let after = ctx.accounts.vault_token_account.amount;
let credited = after.checked_sub(before).ok_or(GuardError::Underflow)?;
require!(credited > 0, GuardError::NothingReceived);   // a 100% fee credits nothing

position.deposited = position.deposited.checked_add(credited).ok_or(GuardError::Overflow)?;
vault.total_deposited = vault.total_deposited.checked_add(credited).ok_or(GuardError::Overflow)?;
```

The three load-bearing moves:

1. **`before`** — snapshot the destination balance *before* the CPI.
2. **`reload()`** — `InterfaceAccount<TokenAccount>` caches `.amount` at instruction entry. After the transfer CPI mutates the on-chain account, the in-memory copy is stale. Without `reload()`, `after == before` and `credited == 0`. **This is the most common way the "right" pattern is still wrong.**
3. **`credited = after − before`** — the only number you may credit. It already nets the fee, the withheld amount, and any rounding. You never compute the fee to do accounting.

Verified by [../examples/guard/tests/guard.test.ts](../examples/guard/tests/guard.test.ts): a 500-bps mint deposit of `requested = 100_000_000` credits the position exactly `95_000_000` — `received`, not `requested`. The same test confirms a clean (no-extension) mint credits the full amount, so delta-measurement is correct in **both** cases. Make it your only path.

> Delta-measurement is the source of truth. The fee-prediction helpers below are for *validation, UX preview, and gross-up* — never for the credit you record.

## Predicting the fee (validation / preview only)

### On-chain (Rust) — current-epoch fee

The epoch must come from the **Clock sysvar**, not a passed account. `calculate_epoch_fee` returns `Option` (`None` = overflow), not `Result`.

```rust
use anchor_spl::token_2022::spl_token_2022::extension::transfer_fee::TransferFeeConfig;

/// Fee charged on `amount` THIS epoch. Ok(0) if no transfer-fee extension.
pub fn current_epoch_transfer_fee(mint_ai: &AccountInfo, amount: u64) -> Result<u64> {
    let data = mint_ai.try_borrow_data()?;
    let state = StateWithExtensions::<SplMint>::unpack(&data)
        .map_err(|_| error!(GuardError::NotAToken2022Mint))?;
    let cfg = match state.get_extension::<TransferFeeConfig>() {
        Ok(c) => c,
        Err(_) => return Ok(0),                 // extension absent → no fee
    };
    let epoch = Clock::get()?.epoch;            // sysvar, NOT a passed account
    cfg.calculate_epoch_fee(epoch, amount)
        .ok_or(error!(GuardError::FeeOverflow))
}
```

### Off-chain (TS, `@solana/spl-token` 0.4.14)

`calculateEpochFee(cfg, epoch, amount)` = `getEpochFee` + `calculateFee`. The **current** epoch is load-bearing because the fee can differ between `olderTransferFee` and `newerTransferFee`.

```ts
import { getTransferFeeConfig, calculateEpochFee } from "@solana/spl-token";

const cfg = getTransferFeeConfig(mint);   // null if no TransferFeeConfig extension
if (cfg) {
  const { epoch } = await connection.getEpochInfo();
  const fee = calculateEpochFee(cfg, BigInt(epoch), amount); // bigint
  const received = amount - fee;          // what the destination will actually get
}
// VERIFIED impl: calculateFee = ceil((pre*bps + 9999)/10000) capped at maximumFee; 0 if bps==0 || pre==0.
// getEpochFee = epoch >= newerTransferFee.epoch ? newerTransferFee : olderTransferFee.
```

`getTransferFeeConfig(mint)` exposes `{ transferFeeConfigAuthority, withdrawWithheldAuthority, withheldAmount, olderTransferFee, newerTransferFee }`. The withheld fee parked on a recipient account is read with `getTransferFeeAmount(acct)?.withheldAmount`.

## Net vs gross — pick the model, do not mix

| Model | You want… | How |
|---|---|---|
| **Net** (default for vaults/escrow) | Credit whatever arrives | Delta-measure (above). Recorded balance == on-chain balance. |
| **Gross-up** | Recipient must receive an exact target `T` | Send `pre` where `cfg.get_epoch_fee(epoch).calculate_pre_fee_amount(T)` (Rust) gives the pre-fee amount; sender pays `pre = T + fee`. |
| **Exact wire fee** | Pin the fee the program asserts, reject if mismatched | `anchor_spl::token_2022_extensions::transfer_fee::transfer_checked_with_fee(ctx, amount, decimals, fee)` with `TransferCheckedWithFee { token_program_id, source, mint, destination, authority }`. The runtime rejects the transfer if the passed `fee` ≠ the fee it would compute — defends against a mid-tx fee change. |

Even with `transfer_checked_with_fee`, **still delta-measure the credit**: the fee you pin is what leaves the sender as withheld; the *received* amount is the delta. Pinning the fee makes the transfer fail-closed on a surprise; it does not let you skip `reload()`.

## Why not just block fee mints?

You can — Jupiter blocks transfer-tax tokens from Limit/Recurring orders because mutable fees break deterministic future settlement. But the guard program **allows** `TransferFeeConfig`/`TransferFeeAmount` precisely because the delta pattern handles them correctly and safely (see the allowlist in [extension-allowlist-pattern.md](extension-allowlist-pattern.md)). Block when your math *requires* a fixed wire amount you cannot reconcile; otherwise handle. The dangerous extensions (`TransferHook`, `PermanentDelegate`, `NonTransferable`, `DefaultAccountState`, `ConfidentialTransferMint`) are a separate, hard block — the reference guard default-denies the entire `DefaultAccountState` extension (it doesn't inspect the state value), and fee handling does not cover any of these.

## DO / DON'T

- **DO** credit `after − before` after `reload()`. It is the only honest number.
- **DO** call `reload()` after every transfer CPI before reading `.amount`.
- **DO** treat a currently-0 fee as a fee that can become 100% next epoch — keep the delta path always-on.
- **DO** use `transfer_checked_with_fee` when you need to fail-closed on a mid-tx fee change.
- **DON'T** credit, mint shares, or update escrow from the `amount` argument.
- **DON'T** use `calculateEpochFee` / `current_epoch_transfer_fee` to compute the *credit* — those are for preview/validation only; the on-chain delta wins.
- **DON'T** assume the happy-path test (vanilla mint, fee = 0) proves correctness — add a fee-mint test like [guard.test.ts](../examples/guard/tests/guard.test.ts).

See also: [extension-allowlist-pattern.md](extension-allowlist-pattern.md) · [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md) · scanner: [../tools/t22-scan](../tools/t22-scan)
