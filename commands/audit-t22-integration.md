---
description: Audit a Solana program's source for Token-2022 integration bugs (fee math, missing extension checks, transfer vs transfer_checked).
argument-hint: [path-to-program-or-repo]
---

# /audit-t22-integration

Audit a program that moves SPL/Token-2022 tokens for the integrator footguns this skill
covers. Scope: `${1:-the current repo}`.

## What to check (report each as a finding with file:line, severity, and the fix)

1. **Amount-trusting accounting (critical).** Any place that credits shares / balances /
   escrow on the transfer *amount* instead of the **received delta**. Grep for `amount`
   used right after a transfer CPI without a `reload()` + balance-diff.
   ```bash
   rg -n "transfer" --type rust | rg -i "amount"
   rg -n "\.amount" --type rust          # check each read is post-reload after a CPI
   ```
   Fix → [skill/transfer-fee-accounting.md](../skill/transfer-fee-accounting.md).

2. **`transfer` instead of `transfer_checked` (high).** Deprecated and unsafe for
   Token-2022. Grep `rg -n "token(_interface)?::transfer\b" --type rust`.

3. **Missing extension allowlist (high).** Does the program read the mint's extensions
   and reject dangerous ones? If it accepts arbitrary mints with no
   `get_extension_types` / allowlist, flag it.
   Fix → [skill/extension-allowlist-pattern.md](../skill/extension-allowlist-pattern.md).

4. **Unpinned token program (high).** Account structs that take a token program / token
   accounts without `token::token_program` / `associated_token::token_program` constraints
   (lets an attacker mix classic-Token and Token-2022). Grep the `#[derive(Accounts)]` structs.

5. **Missing `reload()` after a token CPI (high).** Reading `.amount` post-CPI without
   `reload()` returns stale data.

6. **No reentrancy posture on withdraw/settlement (medium).** If hooks aren't rejected,
   is there a checks-effects-interactions ordering + lock? → [skill/transfer-hook-reentrancy.md](../skill/transfer-hook-reentrancy.md).

7. **Decimals/UI-amount confusion (medium).** Interest-bearing / scaled-UI mints: math
   must use raw base units, never UI amounts.

## Output

A short report: findings (severity + file:line + one-line fix), then the 2-3 highest-impact
changes. If you can, scan any mint addresses the program hardcodes with `/scan-mint`.
Recommend adding a LiteSVM test that fails on the bug and passes after the fix
([skill/testing.md](../skill/testing.md)).
