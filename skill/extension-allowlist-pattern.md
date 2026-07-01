# Extension Allowlist Pattern (default-deny)

> Covers the signature on-chain guard: read a third-party mint's extensions and **fail closed** on anything you don't explicitly support. Read this when you custody or move an *arbitrary* Token-2022 mint (vault / AMM / lending / escrow). Companion: [transfer-fee-accounting.md](transfer-fee-accounting.md), [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md).

A third-party mint is **untrusted input**. Its extensions can rug you (`PermanentDelegate`), brick you (`NonTransferable`, `DefaultAccountState=Frozen`), or run attacker code on every transfer (`TransferHook`). An *issuer* picks safe extensions; an *integrator* must assume the worst and verify on-chain. The rule: **enumerate the mint's TLV extensions and reject everything not on a small allow set** — not a blocklist (blocklists miss the next extension Solana ships).

Working artifact: [../examples/guard/programs/guard/src/lib.rs](../examples/guard/programs/guard/src/lib.rs) (LiteSVM-tested in [../examples/guard/tests/](../examples/guard/tests/)). TS-side mirror of the same risk model: [../tools/t22-scan/src/risk.ts](../tools/t22-scan/src/risk.ts).

---

## 1. Cargo.toml (exact, pinned 2026 stack)

```toml
# programs/guard/Cargo.toml — [dependencies]
[dependencies]
anchor-lang = "1.0.1"
anchor-spl  = "1.0.2"   # pulls spl-token-2022-interface 2.1.0, re-aliased internally
```

That's it — no extra features needed for **reading** extensions. `anchor-spl 1.0.2` re-exports the interface crate as `anchor_spl::token_2022::spl_token_2022`, so you import `StateWithExtensions` / `ExtensionType` through that path with no direct `spl-token-2022-interface` dependency.

> **The 0.31 → 1.0 trap:** `anchor-spl` no longer depends on `spl-token-2022`. It depends on `spl-token-2022-interface ^2`, re-aliased as `pub use spl_token_2022_interface as spl_token_2022;`. A bare `spl_token_2022::...` path will **not** resolve from your crate — always go through `anchor_spl::token_2022::spl_token_2022::...`. Add the interface crate directly **only** if you also need transfer-fee CPI helpers (`anchor-spl = { version = "1.0.2", features = ["token_2022_extensions"] }` + `spl-token-2022-interface = "2.1"`); the `^2` bound means **2.x, never 3.x**.

---

## 2. Imports (the exact alias path)

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;

// Extension-READING types — NOT in token_interface's public surface. Go through the alias.
// BaseStateWithExtensions is the TRAIT that carries get_extension_types(); it MUST be in scope.
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint as SplMint,
};
// CPI builders + InterfaceAccount inner types:
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
```

---

## 3. Reading the extensions: `read_mint_extension_types()`

You **cannot** call `get_extension_types()` on `InterfaceAccount<Mint>` — that derefs to the base `Mint` state with no TLV. You must unpack the **raw account bytes**.

```rust
/// Read every ExtensionType present on a mint's TLV data.
pub fn read_mint_extension_types(mint_ai: &AccountInfo) -> Result<Vec<ExtensionType>> {
    let data = mint_ai.try_borrow_data()?;
    let state = StateWithExtensions::<SplMint>::unpack(&data)
        .map_err(|_| error!(GuardError::NotAToken2022Mint))?;
    state
        .get_extension_types()                         // method lives on trait BaseStateWithExtensions
        .map_err(|_| error!(GuardError::CorruptExtensionData))
}
```

Call it with `&ctx.accounts.mint.to_account_info()`. It works for **both** classic SPL Token and Token-2022 mints (a classic mint unpacks with an empty extension list, so the allowlist passes it cleanly).

---

## 4. The allowlist: `enforce_extension_allowlist()`

This is the heart of the pattern. Two layers: an **explicit forbid arm** (known-dangerous → precise error) and **default-deny** (anything not in `ALLOWED` → reject). Copied verbatim from the working program:

```rust
/// Default-deny allowlist. Explicitly forbids the known-dangerous extensions for
/// better errors, and rejects ANY extension not on the small allow set.
pub fn enforce_extension_allowlist(mint_ai: &AccountInfo) -> Result<()> {
    const ALLOWED: &[ExtensionType] = &[
        ExtensionType::TransferFeeConfig,  // handled via delta-measured deposit
        ExtensionType::TransferFeeAmount,
        ExtensionType::MetadataPointer,
        ExtensionType::TokenMetadata,
        ExtensionType::ImmutableOwner,
    ];
    for ext in read_mint_extension_types(mint_ai)? {
        match ext {
            ExtensionType::TransferHook
            | ExtensionType::PermanentDelegate
            | ExtensionType::NonTransferable
            | ExtensionType::DefaultAccountState
            | ExtensionType::ConfidentialTransferMint => {
                return err!(GuardError::ForbiddenExtension)
            }
            ExtensionType::Uninitialized => {}
            other if !ALLOWED.contains(&other) => return err!(GuardError::UnsupportedExtension),
            _ => {}
        }
    }
    Ok(())
}
```

### Why each arm

| Arm | Extensions | Why |
|---|---|---|
| **Forbid** (`ForbiddenExtension`) | `TransferHook`, `PermanentDelegate`, `NonTransferable`, `DefaultAccountState`, `ConfidentialTransferMint` | Each can rug or brick a custodian. Listed explicitly only for a **precise error message** — default-deny would catch them anyway. |
| **Ignore** | `Uninitialized` | TLV padding / zero-type entries; not a real extension. |
| **Default-deny** (`UnsupportedExtension`) | anything not in `ALLOWED` | The safety net. A future Solana extension you've never seen is rejected by default — you opt in deliberately, never accidentally. |
| **Allow** | `TransferFeeConfig` + `TransferFeeAmount`, `MetadataPointer`, `TokenMetadata`, `ImmutableOwner` | Fees are handled by delta-measured deposits (see [transfer-fee-accounting.md](transfer-fee-accounting.md)); the rest are display/safety-only with no transfer-path impact. |

> **Forbid vs default-deny is intentional redundancy.** Remove the forbid arm and the program is still safe (those extensions aren't in `ALLOWED`). Keep it so an integrator sees `ForbiddenExtension` ("we will never support this") vs `UnsupportedExtension` ("not modeled yet") — different operational signals.

> `Pausable` / `ScaledUiAmount` / `InterestBearing` / `ConfidentialTransferFeeConfig` aren't named in the `match` because **default-deny already rejects them**. Add them to the explicit forbid arm only if you want a tailored error.

---

## 5. Re-validate at *use*, not just at listing

`init_vault` is **not** the only checkpoint. Mint authorities are mutable: a transfer-hook authority or fee config can change after your vault exists, and `MintCloseAuthority` enables a close-and-reinit that swaps the mint's properties under a cached pubkey. So the working program calls the allowlist **on every state-changing path**:

```rust
pub fn init_vault(ctx: Context<InitVault>) -> Result<()> {
    enforce_extension_allowlist(&ctx.accounts.mint.to_account_info())?;   // at creation
    /* ... */
}
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    // Re-validate: a mint's transfer-hook authority can change after init.
    enforce_extension_allowlist(&ctx.accounts.mint.to_account_info())?;   // at every use
    /* ... */
}
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    enforce_extension_allowlist(&ctx.accounts.mint.to_account_info())?;   // even on the way out
    /* ... */
}
```

Never cache "this mint is safe" in a PDA. Re-read the TLV each time. This is the lesson from `MintCloseAuthority` (Neodyme): close+reinit bypasses any KYC / non-transferable / fee assumption you cached at first sight.

---

## 6. The mint account must be bound and program-safe

The allowlist is worthless if an attacker can pass a *different* mint, or pair a classic-Token account with a Token-2022 CPI. The `Accounts` struct closes both holes:

```rust
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(address = vault.mint)]                       // (1) bind to the vault's mint — no swap
    pub mint: InterfaceAccount<'info, Mint>,              //     InterfaceAccount = classic OR 2022
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,  // (2) ties ATA owner to the CPI'd program
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user,
        token::token_program = token_program,             // (2) same on the user side
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    /* position / owner ... */
    pub token_program: Interface<'info, TokenInterface>,  // resolves to whichever program owns the mint
}
```

- **`#[account(address = vault.mint)]`** — the mint can't be substituted after `init_vault` pinned it.
- **`token::token_program` / `associated_token::token_program`** — without these, an attacker mixes a classic-Token account into a Token-2022 transfer (or vice-versa). Always set them on every token account (see §6 above).
- **`InterfaceAccount` + `Interface<TokenInterface>`** — one code path for classic Token and Token-2022; the program is resolved from the mint's owner, not hardcoded.

---

## 7. Parameterizing the allowlist per protocol

`ALLOWED` is a `const` here for clarity, but the *risk verdict depends on the profile* — a `vault` should reject `DefaultAccountState`, while an `amm` can `HANDLE` it (thaw on use). The TS scanner already encodes this as per-profile verdicts in [../tools/t22-scan/src/risk.ts](../tools/t22-scan/src/risk.ts) (`Profile = "amm" | "vault" | "lending" | "escrow" | "generic"`, `verdictForProfile`). Mirror that on-chain by either:

1. **Compile-time** — different `const ALLOWED` per program/feature flag. Simplest, fully auditable.
2. **Config-PDA** — store an allow-bitmask in a governance-owned PDA and check `ExtensionType` membership against it. Use only if you genuinely need runtime tunability; a mutable allowlist is itself an attack surface, so gate it behind a timelock.

Keep the set **small**. Every extension you allow is a correctness obligation (e.g. allowing `TransferFeeConfig` *requires* delta-measured deposits — never credit the instruction `amount`).

---

## 8. DEX precedents (this is the production pattern)

| Protocol | Mechanism | Source |
|---|---|---|
| **Orca Whirlpools** | `TokenBadge` PDA whitelists which mints/configs are usable; `PermanentDelegate` "poses more risks than benefits"; transfer hooks require a public **Verifiable Build**. | dev.orca.so — TokenExtensions Support |
| **Raydium** | Narrow allowlist: permits `TransferFee` + Metadata/Pointer; **blocks** `PermanentDelegate`, `TransferHook`, freeze. SPL freeze authority must be disabled for pools. | raydium.medium.com (2023-07-19) |
| **Jupiter** | Transfer-tax / T-2022 tokens blocked from Limit & Recurring orders (mutable fees break deterministic settlement). | support.jup.ag |

All three converge on the same shape this file teaches: **read extensions on-chain, allow a tiny known-safe set, default-deny the rest.** It is the battle-tested integrator posture, not a theoretical one.

---

## DO / DON'T

**DO**
- Unpack **raw mint bytes** via `StateWithExtensions::<SplMint>::unpack` — never `get_extension_types` on `InterfaceAccount`.
- Default-deny: reject any extension not in a small explicit `ALLOWED` set.
- Re-run `enforce_extension_allowlist` on **every** deposit/withdraw, not just init.
- Bind the mint (`address = vault.mint`) and set `token::token_program` on every token account.
- Keep `ALLOWED` minimal; each entry is a handling obligation.

**DON'T**
- Don't write a blocklist — it silently allows the next new extension.
- Don't cache "mint is safe" in a PDA (`MintCloseAuthority` defeats it).
- Don't import via bare `spl_token_2022::` — use `anchor_spl::token_2022::spl_token_2022::`.
- Don't allow `TransferFeeConfig` without delta-measured deposits ([transfer-fee-accounting.md](transfer-fee-accounting.md)).
- Don't trust an extension getter returning a default/system-program pubkey as "unset" without checking — verify the field.
