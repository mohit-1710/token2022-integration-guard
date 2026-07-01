---
description: Safety rules when Rust program code consumes SPL/Token-2022 mints.
globs: ["**/*.rs"]
---

# Token-2022 Integration Rules (Rust)

Apply these whenever the program moves SPL tokens or accepts a mint it does not control.
Full rationale + tested code: [skill/SKILL.md](../skill/SKILL.md).

## Always

- **`transfer_checked`, never `transfer`.** Pass the mint and `mint.decimals`.
- **Credit the received delta, not the `amount` arg.** After the transfer CPI:
  `account.reload()?; let credited = after.checked_sub(before)?;` — credit `credited`.
  A transfer-fee mint makes `credited < amount`. (See `transfer-fee-accounting.md`.)
- **Default-deny extensions.** Read the mint's extensions
  (`StateWithExtensions::<Mint>::unpack(..).get_extension_types()`) and reject
  `TransferHook`, `PermanentDelegate`, `NonTransferable`, `DefaultAccountState`,
  `ConfidentialTransferMint`, `Pausable`, and anything not explicitly handled.
  (See `extension-allowlist-pattern.md`.)
- **Pin the token program.** In `#[derive(Accounts)]`, set `token::token_program` and
  `associated_token::token_program`, and use `InterfaceAccount`/`Interface` (not the
  classic `Account<Mint>`/`Program<Token>`).
- **Checked math everywhere** (`checked_add`/`checked_sub`); no `unwrap()`/`expect()` in program code.
- **Withdraw/settlement uses checks-effects-interactions** + a reentrancy lock if hooks
  are ever allowed. (See `transfer-hook-reentrancy.md`.)

## Never

- Treat a Token-2022 mint like a classic SPL token.
- Trust "mint + freeze authority revoked" as proof a mint is safe — check the
  **permanent delegate** field independently.
- Read `.amount` after a CPI without `reload()`.
- Use UI/scaled amounts (interest-bearing, scaled-UI) for accounting — use raw base units.

## Anchor 1.0 note

`CpiContext::new(...)` takes the program **`Pubkey`** (`token_program.key()`), not an
`AccountInfo`. Use `anchor_spl::token_interface::{transfer_checked, TransferChecked}`.
