---
name: token2022-integration-guard
description: >-
  CONSUMER-side Token-2022 safety: how a Solana program safely ACCEPTS an arbitrary,
  possibly-hostile Token-2022 / Token Extensions mint without getting drained or bricked —
  for an AMM, vault, lending market, escrow, or payments flow. Ships a compiling, LiteSVM-tested
  GUARD VAULT you paste into your protocol: an on-chain extension allowlist that rejects
  dangerous mints (transfer hook, permanent delegate, default-frozen, confidential, pausable,
  non-transferable), delta-measured fee-safe deposits, and reentrancy-aware withdraws — plus a
  scan CLI as a pre-flight/CI gate. Use when your program must accept/custody/pool/lend-against a
  third-party token, vetting whether a specific mint is safe to integrate, or debugging "shares
  don't add up / my vault is short / deposit credited too much." NOT for issuing tokens with
  extensions (that's the issuer side) — this is the complementary consumer guard.
user-invocable: true
---

# Token-2022 Integration Guard

> **Author/inspector vs consumer.** The kit's `token-2022` material and the broad
> token-extensions skills (`solana-token-extensions`, `token-2022-extensions`) are for the
> token's **author** — choosing extensions, creating the mint, and a read-only mint *inspector*.
> This skill is the opposite side: how a program **safely consumes** a third-party mint it does
> **not** control. A mint is untrusted input. Where those skills say *"integrators should use the
> net amount,"* this skill **enforces and tests** it — a guard vault that proves the
> share-insolvency footgun and blocks it on-chain. Strictly complementary; install alongside them.

## When to use this skill

Use it when the user is on the **consuming** side of a Token-2022 mint:

- Adding Token-2022 support to an AMM, vault, lending market, escrow, staking, or payments flow.
- Deciding whether to list / pool / accept a specific token ("is this mint safe to integrate?").
- Debugging share/LP/escrow math that "doesn't add up" (almost always a transfer-fee bug).
- Reviewing an Anchor/native program that moves SPL tokens for Token-2022 safety.
- Writing tests that prove your integration survives hostile mints.

If the user wants to *create* a token with extensions, that's the issuer side — defer
to the core token-2022 skill.

## The one-paragraph threat model

A Token-2022 mint can carry **extensions** that change transfer behavior. As an
integrator you must assume the mint author is adversarial. The dangerous ones:
a **transfer fee** makes the credited amount less than the sent amount (breaks
1:1 share math); a **transfer hook** runs issuer-controlled code on every transfer
(reentrancy, DoS, account injection); a **permanent delegate** can move/burn tokens
from *your* vault at any time; **default-account-state = frozen** makes your fresh
token accounts unusable; **confidential transfers** hide the real balance from your
accounting; **pausable** lets the issuer freeze your withdrawals. Default-deny.

## Operating procedure

1. **Scan first.** Identify every extension on the mint and its integrator impact.
   → [scanning.md](scanning.md) (runnable `t22-scan` CLI) and
   [extension-risk-matrix.md](extension-risk-matrix.md) (what each extension means).
2. **Decide per profile.** AMM, vault, lending, and escrow tolerate different
   extensions. Use the matrix verdicts (`ALLOW` / `HANDLE` / `REJECT`).
3. **Harden the program.** Apply the patterns for whatever you choose to support:
   - Transfer fee → [transfer-fee-accounting.md](transfer-fee-accounting.md)
   - Transfer hook → [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md)
   - Permanent delegate / freeze → [permanent-delegate-and-freeze.md](permanent-delegate-and-freeze.md)
   - Enforce a default-deny allowlist on-chain → [extension-allowlist-pattern.md](extension-allowlist-pattern.md)
4. **Prove it with tests.** Write LiteSVM tests that load the real Token-2022
   program and assert your guards block the attack. → [testing.md](testing.md)
5. **Cite sources / go deeper.** → [resources.md](resources.md)

## Routing table

| The user is dealing with… | Read |
|---|---|
| "Is this mint safe to integrate?" / scan a token | [scanning.md](scanning.md), [extension-risk-matrix.md](extension-risk-matrix.md) |
| Shares/LP/escrow amounts wrong, "fee eating my deposits" | [transfer-fee-accounting.md](transfer-fee-accounting.md) |
| Transfer hooks, reentrancy, ExtraAccountMetaList, CPI on transfer | [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md) |
| Permanent delegate, freeze authority, default-frozen, clawback | [permanent-delegate-and-freeze.md](permanent-delegate-and-freeze.md) |
| "How do I reject dangerous mints in my program?" | [extension-allowlist-pattern.md](extension-allowlist-pattern.md) |
| Writing/running tests for Token-2022 edge cases | [testing.md](testing.md) |
| Which extensions exist and how risky each is | [extension-risk-matrix.md](extension-risk-matrix.md) |
| Sources, audits, DEX policies, further reading | [resources.md](resources.md) |

## What ships in this skill

| Artifact | Path | What it is |
|---|---|---|
| Scanner CLI | [`tools/t22-scan/`](../tools/t22-scan/) | `t22-scan <mint> --profile=vault` → per-extension risk verdict + exit code for CI. Verified against live mainnet mints. |
| Guard program | [`examples/guard/`](../examples/guard/) | A real Anchor 1.0 vault: on-chain extension allowlist + delta-measured fee-safe deposit + reentrancy-aware withdraw. |
| Attack tests | [`examples/guard/tests/`](../examples/guard/tests/) | LiteSVM tests loading the real `spl_token_2022` program, proving the footgun and that the guard blocks it. |

## Commands & agent

| Trigger | What it does |
|---|---|
| [`/scan-mint`](../commands/scan-mint.md) | Scan a mint address and report integrator risk for a chosen profile. |
| [`/audit-t22-integration`](../commands/audit-t22-integration.md) | Audit a program's source for Token-2022 integration bugs. |
| Agent: [`token2022-integration-auditor`](../agents/token2022-integration-auditor.md) | Spawns a focused reviewer that scans configured mints and greps the program for `transfer` vs `transfer_checked`, amount-trusting math, and missing extension checks. |

## Non-negotiable rules (apply on every integration)

- **Default-deny.** Reject any extension you don't explicitly handle. Unknown TLV = reject.
- **Never trust the `amount` argument** for crediting value. Measure the received delta
  (`reload()` + balance diff) or read the fee config; credit the received amount.
- **Always `transfer_checked`** (mint + decimals), never the deprecated `transfer`.
- **Pin the token program.** Set `token::token_program` / `associated_token::token_program`
  so an attacker can't mix a classic-Token account into a Token-2022 CPI.
- **Re-validate at use**, not just at listing — a mint's transfer-hook program and fees can change.
- **Prove it.** Ship a LiteSVM test that fails without your guard and passes with it.
