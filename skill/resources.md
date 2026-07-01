# Resources — Token-2022 integrator (cited)

> Covers: the canonical docs, SDKs, threat models, and **production DEX/aggregator policies** that justify this skill's default-deny stance. Read when you need an authoritative URL to back a verdict, or want to see how shipped protocols (Jupiter, Orca, Raydium, RugCheck) actually gate Token-2022 mints. Dates and URLs are cited inline; treat any third-party $ figure as an estimate.

The short version: **every production venue that has shipped Token-2022 support converged on the same design this skill ships** — read extensions on-chain, default-deny, allowlist a narrow set, special-case transfer fee. The links below are the receipts.

---

## 1. Official docs (Solana / SPL)

| What | Use it for |
|---|---|
| **Solana Token Extensions** — `solana.com/solutions/token-extensions` | Marketing-level map of every extension. Good first orientation; not precise enough for accounting. |
| **Token Extensions guides** — `solana.com/developers/guides/token-extensions` | Per-extension how-to (transfer fee, transfer hook, default state, etc.). Issuer-oriented — read it to understand what a hostile issuer *can* configure against you. |
| **SPL Token-2022 program docs** — `solana-program.com/docs/token-2022` (the old `spl.solana.com/token-2022` 308-redirects here) | Canonical extension semantics. The extensions page is the source of truth for transfer-fee-on-recipient, default-frozen, hook CPI behavior. |
| **`spl-token` CLI** — `solana-program.com/docs/token` | `spl-token display <mint>` dumps extensions from a terminal — a quick manual cross-check against [scanning.md](scanning.md). |

> The two load-bearing facts an integrator must internalize live in the SPL extensions page: **transfer fee is deducted from the recipient's credited amount** (not the sender), and **transfer hooks execute issuer code inside your transfer CPI**. Everything in [transfer-fee-accounting.md](transfer-fee-accounting.md) and [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md) follows from those two.

---

## 2. SDKs & tools (pinned 2026 stack)

| Package / tool | Version | Integrator-relevant surface |
|---|---|---|
| **`@solana/spl-token`** (JS) | `0.4.14` | `getMint(conn, addr, commitment?, programId?)`, `getExtensionTypes(mint.tlvData)`, per-extension getters (`getTransferFeeConfig`, `getTransferHook`, `getPermanentDelegate`, `getDefaultAccountState`, `getPausableConfig`, `getNonTransferable`, …), `calculateEpochFee`. **Must pass `TOKEN_2022_PROGRAM_ID`** or it defaults to legacy Token. See [scanning.md](scanning.md). |
| **`spl-token-2022-interface`** (Rust crate) | `2.1.0` | `StateWithExtensions::<Mint>::unpack`, `BaseStateWithExtensions::get_extension_types`, `TransferFeeConfig::calculate_epoch_fee`. This is what `anchor-spl` re-aliases as `spl_token_2022`. |
| **`anchor-spl`** | `1.0.2` (pulls `spl-token-2022-interface 2.1.0`) | `token_interface::{Mint, TokenAccount, TokenInterface, transfer_checked, TransferChecked}`, `token_2022_extensions::transfer_fee::{transfer_checked_with_fee, TransferCheckedWithFee}`. **Anchor 1.0 change: `CpiContext::new` / `new_with_signer` take the program **`Pubkey`** via `.key()`, not an `AccountInfo` (verified against the working program).** |
| **`anchor-lang`** | `1.0.x` | `ctx.bumps.<pda>` is a struct field (not a HashMap); `InterfaceAccount<'info, Mint>` works for classic Token *and* Token-2022. |
| **`litesvm`** | `1.2.0` | **kit-native** (`@solana/kit` 6.10.0, not web3.js v1). Token-2022 + ATA **preloaded** — do not `addProgramFromFile` them. See [testing.md](testing.md). |
| **The scanner this skill ships** | — | [`../tools/t22-scan`](../tools/t22-scan) — `t22-scan <mint> --profile=vault` → per-extension verdict + CI exit code. Logic in [`src/scan.ts`](../tools/t22-scan/src/scan.ts) / [`src/risk.ts`](../tools/t22-scan/src/risk.ts). |
| **The guard program** | — | [`../examples/guard/programs/guard/src/lib.rs`](../examples/guard/programs/guard/src/lib.rs) — on-chain allowlist + delta-measured deposit + reentrancy-aware withdraw. |

> Pin these exact versions. `anchor-spl` 1.0.x dropped its dependency on `spl-token-2022` in favor of `spl-token-2022-interface ^2` — the old `spl_token_2022::…` import path no longer resolves from your crate; go through `anchor_spl::token_2022::spl_token_2022::…`. See [extension-allowlist-pattern.md](extension-allowlist-pattern.md).

---

## 3. Threat models & audits

| Source | Date | Covers | Why it matters |
|---|---|---|---|
| **Neodyme — "Token-2022 Security"** `neodyme.io/en/blog/token-2022/` | 2024-09-10 | Transfer fee, transfer hook, default-frozen, mint-close-authority, confidential transfer | **The canonical integrator threat model.** Source of the #1 footgun: *"fee is deducted from the recipient's received amount, not the sender's balance"* — naive `amount`-based crediting inflates share supply and becomes drainable. Read before anything else. |
| Neodyme — close+reinit note | 2024-09-10 | MintCloseAuthority | Close+reinit can bypass KYC / non-transferable / fee assumptions you cached at listing time → **re-validate at use**, never cache per-mint trust. |
| Neodyme + Zealynx | — | ConfidentialTransfer | `maximum_pending_balance_credit_counter` DoS; a non-zero auditor key is a decrypt backdoor. Most custody integrators should simply reject. |
| Neodyme / Zealynx (threat model; no confirmed named exploit) | — | TransferHook | Reentrancy loops, CPI-depth griefing (depth limit 4; the hook consumes one level), `ExtraAccountMetaList` injection. Justifies CEI + a reentrancy guard and default-denying unknown hooks → [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md). |
| SPL issue **#3789** + Neodyme | — | DefaultAccountState=Frozen | Vault ATAs can be born frozen so deposits silently fail; revoking freeze authority while default=Frozen can permanently strand funds. Verify by **balance delta**, never "the instruction didn't revert." |

> These map 1:1 to the matrix in [extension-risk-matrix.md](extension-risk-matrix.md) and the verdicts the scanner emits. When a judge asks "why BLOCK permanent delegate?", the answer is the Neodyme threat model plus the production policies below — not opinion.

---

## 4. Production DEX / aggregator policies

This is the strongest external validation that default-deny is correct: real venues with real TVL gate Token-2022 mints the same way.

| Venue | Policy | Source |
|---|---|---|
| **Jupiter** | Transfer-tax / Token-2022 tokens are **blocked from Limit & Recurring orders** (Instant swaps only). Rationale: mutable fees break deterministic future settlement — exactly why [transfer-fee-accounting.md](transfer-fee-accounting.md) treats fees as per-epoch and measures the delta. | `support.jup.ag` article `22634616157340` |
| **Orca (Whirlpools)** | Ships a **`TokenBadge`** PDA allowlist per pool config; transfer hooks must be **public + a Verifiable Build**; states PermanentDelegate *"poses more risks than benefits."* This is precisely the read-on-chain + allowlist pattern in [extension-allowlist-pattern.md](extension-allowlist-pattern.md). | `dev.orca.so` — Token Extensions Support |
| **Raydium** | Narrow allowlist by policy: supports **TransferFee + metadata**; flags/restricts **PermanentDelegate and TransferHook** for pools. Battle-tested allowlist-by-policy. (Check the article for the exact current rules.) | `raydium.medium.com` (2023-07-19) |
| **RugCheck** (abuse trend; $ figures are third-party estimates) | Flags PermanentDelegate aggressively (reported >40% of new tokens carry it); the takeaway: *"mint + freeze revoked, LP locked"* can **still** rug via a permanent-delegate burn → **check the permanent-delegate field independently**, never infer safety from revoked mint/freeze. | RugCheck / DEV trend writeups, Q1-2026 |

> Note the convergence: Raydium allows transfer fee but blocks hooks + permanent delegate; Orca allowlists per-config and demands verifiable hook builds; Jupiter quarantines fee tokens out of deferred-settlement order types. The guard program's default `ALLOWED` set (`TransferFeeConfig`/`TransferFeeAmount`, `MetadataPointer`, `TokenMetadata`, `ImmutableOwner`) mirrors Raydium's posture. See [permanent-delegate-and-freeze.md](permanent-delegate-and-freeze.md) for why "authorities revoked" is not sufficient.

---

## 5. Map: resource → skill file

| You want to… | Authority (above) | Skill file |
|---|---|---|
| Understand each extension's risk | Neodyme; SPL extensions docs | [extension-risk-matrix.md](extension-risk-matrix.md) |
| Detect extensions on a mint | `@solana/spl-token` 0.4.14 | [scanning.md](scanning.md) |
| Get fee accounting right | Neodyme; Jupiter policy | [transfer-fee-accounting.md](transfer-fee-accounting.md) |
| Survive transfer hooks | Neodyme/Zealynx; Orca verifiable-build rule | [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md) |
| Handle delegate / freeze / default-frozen | RugCheck trend; SPL #3789 | [permanent-delegate-and-freeze.md](permanent-delegate-and-freeze.md) |
| Enforce an on-chain allowlist | Orca TokenBadge; Raydium allowlist | [extension-allowlist-pattern.md](extension-allowlist-pattern.md) |
| Prove guards with tests | litesvm 1.2.0 | [testing.md](testing.md) |

---

## DO / DON'T

- **DO** cite Neodyme (2024-09-10) for the transfer-fee-on-recipient footgun — it is the load-bearing fact behind delta-measured deposits.
- **DO** point skeptics at Orca's TokenBadge + Verifiable Build rule and Raydium's allowlist as proof default-deny is the production norm, not paranoia.
- **DO** pin the exact versions in §2; mismatched `anchor-spl` / `spl-token-2022-interface` is the most common build break (see [extension-allowlist-pattern.md](extension-allowlist-pattern.md)).
- **DON'T** quote the third-party $ estimates (RugCheck "$50M+", ">40% of new tokens") as hard numbers — label them as estimates.
- **DON'T** infer a mint is safe from "mint + freeze revoked, LP locked" — a permanent delegate survives all three.
- **DON'T** treat a transfer-fee token as settleable in deferred order flows — Jupiter blocks it for a reason; re-read the fee config at execution.
