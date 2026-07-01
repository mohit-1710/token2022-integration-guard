# Threat model

You are integrating an **arbitrary, untrusted Token-2022 mint** into a program that
custodies value (AMM, vault, lending, escrow). The mint author is treated as adversarial.
This document maps every attack the skill defends against to the test that proves it.

## Two layers

1. **Off-chain pre-flight** (`t22-scan`). Reads the mint's TLV extensions and returns a
   per-profile verdict. It models **armed vs inert**: a `TransferHook` with no program set,
   or a `None` permanent delegate, is downgraded to `ALLOW`. Use it to gate listings in CI.
2. **On-chain guard** (the Anchor program). Fails **closed** on extension *presence*, which
   is deliberately stricter than the scanner. An inert delegate today can be re-armed
   tomorrow, so custody code rejects the capability, not just its current state. The guard is
   the enforcement; the scanner is advice.

## Attack → footgun → defense → proof

| # | Attacker capability | If you integrate naively | Defense | Proven by |
|---|---|---|---|---|
| 1 | Issuer sets (or later raises) a **transfer fee** | Fee is withheld from the recipient, so credited < sent. Crediting the `amount` arg over-issues shares and the vault goes **insolvent**. | Delta-measured deposit: credit `post − pre` balance after `reload()`, never the `amount`. | [`tests/footgun.test.ts`](examples/guard/tests/footgun.test.ts) proves the bug (credited 95M ≠ sent 100M); [`tests/guard.test.ts`](examples/guard/tests/guard.test.ts) proves the guard credits the received amount. |
| 2 | Issuer holds a **permanent delegate** | The delegate can transfer or burn tokens from your vault at any time. "Mint + freeze revoked" is not enough. | Extension allowlist rejects the mint at `init_vault`. | [`tests/guard-rejects.test.ts`](examples/guard/tests/guard-rejects.test.ts) |
| 3 | Issuer sets **DefaultAccountState = Frozen** | Your fresh vault ATA is born frozen. Deposits silently fail, and the freeze authority can re-freeze later. | Allowlist rejects the mint at `init_vault`. | [`tests/guard-rejects.test.ts`](examples/guard/tests/guard-rejects.test.ts) |
| 4 | Issuer sets a **transfer hook** | Issuer code runs on every transfer: reentrancy, DoS, extra-account injection. | Allowlist rejects hook mints. Withdraw also uses checks-effects-interactions + a lock, as defense in depth. | [`tests/guard-rejects.test.ts`](examples/guard/tests/guard-rejects.test.ts) |
| 5 | Issuer enables **confidential transfers** | Visible balances no longer equal true balances, so your accounting is blind. | Allowlist rejects (presence-based). | scanner + `enforce_extension_allowlist` (rejected on presence) |
| 6 | Benign mint, correctness under load | — | Exact deposit/withdraw accounting on a clean mint. | [`tests/guard.test.ts`](examples/guard/tests/guard.test.ts) (clean-mint round trip) |

## Limitations / non-goals (honest calibration)

- The scanner reads **mint-level** extensions. It does not inspect the depositor's
  **account-level** state (`CpiGuard`, `MemoTransfer`) or do **second-hop** transfer-hook
  upgrade-authority analysis. Those are out of scope by design.
- The guard program is a **teaching reference**, not an audited production vault. Use the
  patterns, not the exact program, in production.
- `HANDLE` (transfer fee) still requires the integrator to write the delta accounting. The
  guard shows how; it does not remove the obligation.
- The guard is **stricter than the scanner** on purpose (fail-closed on presence). If your
  protocol has a reason to accept an inert-capability mint, relax the allowlist deliberately.
- Reentrancy is defended primarily by **rejecting hook mints**, so in practice the withdraw
  path is never re-entered. The lock + ordering are defense in depth.
