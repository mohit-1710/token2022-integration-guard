# Extension Risk Matrix

> What/when: the canonical per-extension verdict table for an **integrator** consuming a third-party Token-2022 mint. Read this to decide ALLOW / HANDLE / REJECT for a specific extension and profile. This mirrors the scanner's `RISK_MATRIX` in [`../tools/t22-scan/src/risk.ts`](../tools/t22-scan/src/risk.ts) and the `analyze()` active/inert logic in [`../tools/t22-scan/src/scan.ts`](../tools/t22-scan/src/scan.ts).

You are a **consumer**, not an issuer. A third-party mint is **untrusted input**. Verdicts below are deliberately conservative for custody profiles. Related: [transfer-fee-accounting.md](transfer-fee-accounting.md), [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md), [extension-allowlist-pattern.md](extension-allowlist-pattern.md).

## Verified ExtensionType numeric values (`@solana/spl-token` 0.4.14)

| # | Name | # | Name |
|--|------|--|------|
| 1 | TransferFeeConfig | 12 | PermanentDelegate |
| 2 | TransferFeeAmount (acct) | 14 | TransferHook |
| 3 | MintCloseAuthority | 15 | TransferHookAccount (acct) |
| 4 | ConfidentialTransferMint | 16 | ConfidentialTransferFeeConfig\* |
| 5 | ConfidentialTransferAccount (acct) | 17 | ConfidentialTransferFeeAmount (acct)\* |
| 6 | DefaultAccountState | 18 | MetadataPointer |
| 7 | ImmutableOwner (acct) | 19 | TokenMetadata |
| 8 | MemoTransfer (acct) | 20 | GroupPointer |
| 9 | NonTransferable | 21 | TokenGroup |
| 10 | InterestBearingConfig | 22 | GroupMemberPointer |
| 11 | CpiGuard (acct) | 25 | ScaledUiAmountConfig |
| | | 26 | PausableConfig |

\* Types 16/17 are **omitted from the JS 0.4.14 `ExtensionType` reverse-map**. The scanner backfills them via `EXTRA_EXTENSION_NAMES` in `scan.ts`; anything else unknown becomes `Unknown(n)` and falls through to `UNKNOWN_EXTENSION` (severity high, HANDLE). Do NOT trust the JS enum for these — hand-parse raw TLV if you must classify them.

Rust variant spelling is expected to differ from JS for two (likely `ExtensionType::Pausable` for JS `PausableConfig`, `ExtensionType::ScaledUiAmount` for JS `ScaledUiAmountConfig`) — confirm the exact variant compiles against your `spl-token-2022-interface` before matching on it. The guard program deliberately does **not** name these: they fall through its default-deny `UnsupportedExtension` arm, so the allowlist never depends on the exact spelling (see [`../examples/guard/programs/guard/src/lib.rs`](../examples/guard/programs/guard/src/lib.rs)).

## Active vs inert — the nuance that drives the verdict

The matrix verdict is the **worst case if the extension is active**. The scanner downgrades a *present-but-inert* extension to ALLOW with a note (`scan.ts` → `verdict = active ? baseVerdict : "ALLOW"`). An extension is **inert** when:

| Extension | Inert when | Detected by (`analyze()` in scan.ts) |
|-----------|-----------|--------------------------------------|
| TransferHook | `programId` is unset / `PublicKey.default` | `getTransferHook(mint).programId` equals `PublicKey.default` |
| PermanentDelegate | `delegate` is `None` / `PublicKey.default` | `getPermanentDelegate(mint).delegate` equals `PublicKey.default` |
| DefaultAccountState | state is `Initialized`, not `Frozen` | `getDefaultAccountState(mint).state !== AccountState.Frozen` |

Caveat baked into the scanner: **TransferFeeConfig is always treated as active** even at 0 bps — `analyze()` returns `active: true` and notes "currently zero, but the fee authority can raise it." A mutable fee authority is a standing risk; do not whitelist a fee mint just because today's fee is 0. Everything else not special-cased in `analyze()` defaults to `active: true`.

## Mint-level extensions (transfer/custody path)

Columns: Rust enum · TS detection · impact · what it breaks · verdict by profile · severity. Verdicts taken verbatim from `RISK_MATRIX`.

| Extension | Rust enum | TS detection | Impact / what breaks | AMM | Vault | Lending | Escrow | Sev |
|-----------|-----------|--------------|----------------------|-----|-------|---------|--------|-----|
| **TransferFeeConfig** | `TransferFeeConfig` | `getTransferFeeConfig(mint)` → `.newerTransferFee` | Recipient credited `amount − fee`, not `amount`. Breaks share/LP math, escrow 1:1 invariants. | HANDLE | HANDLE | HANDLE | HANDLE | high |
| **TransferHook** | `TransferHook` | `getTransferHook(mint)` → `.programId` (default = inert) | Every transfer CPIs issuer code w/ injected accounts. Reentrancy, DoS, extra-account injection. | REJECT | REJECT | REJECT | REJECT | critical |
| **PermanentDelegate** | `PermanentDelegate` | `getPermanentDelegate(mint)` → `.delegate` (default = inert) | A key can transfer/burn ANY account incl. your vault. Unrevocable clawback; books lie. | REJECT | REJECT | REJECT | REJECT | critical |
| **DefaultAccountState** | `DefaultAccountState` | `getDefaultAccountState(mint)` → `.state === AccountState.Frozen` (=2) | New ATAs born Frozen; deposits/withdrawals revert until thawed; issuer can re-freeze. | HANDLE | REJECT | REJECT | HANDLE | high |
| **NonTransferable** | `NonTransferable` | `getNonTransferable(mint)` (`{}` marker) | Soulbound. Deposits stick, withdrawals impossible. | REJECT | REJECT | REJECT | REJECT | critical |
| **PausableConfig** | `Pausable` | `getPausableConfig(mint)` → `.authority`, `.paused` (no `getPausable`) | Authority halts all transfers. Blocks withdrawals & liquidations. | HANDLE | REJECT | REJECT | HANDLE | high |
| **ConfidentialTransferMint** | `ConfidentialTransferMint` | **No getter** — `getExtensionTypes(mint.tlvData).includes(ExtensionType.ConfidentialTransferMint)` (=4) | Encrypted balances; on-chain reads ≠ true balance. Breaks delta-measure & collateral valuation. | REJECT | REJECT | REJECT | HANDLE | high |
| **ConfidentialTransferFeeConfig** | (types 16/17) | Backfilled in scanner; hand-parse TLV | Confidential + fee; opaque fee accounting. | HANDLE | HANDLE | HANDLE | HANDLE | high |
| **InterestBearingConfig** | `InterestBearingConfig` | `getInterestBearingMintConfigState(mint)` | UI amount drifts; raw amount constant. Footgun: using `amount_to_ui_amount` for math. | HANDLE | HANDLE | HANDLE | HANDLE | medium |
| **ScaledUiAmountConfig** | `ScaledUiAmount` | `getScaledUiAmountConfig(mint)` → `.multiplier` | Multiplier rescales display; raw constant; authority can reprice. Same math footgun. | HANDLE | HANDLE | HANDLE | HANDLE | medium |
| **MintCloseAuthority** | `MintCloseAuthority` | `getMintCloseAuthority(mint)` → `.closeAuthority` | Mint closable at zero supply; close+reinit bypasses cached assumptions. | HANDLE | HANDLE | HANDLE | HANDLE | medium |
| **MetadataPointer** | `MetadataPointer` | `getMetadataPointerState(mint)` | Repointable pointer. No transfer impact. Never authorize on it. | ALLOW | ALLOW | ALLOW | ALLOW | low |
| **TokenMetadata** | `TokenMetadata` | `getTokenMetadata(conn, mint)` (async) | Mutable on-mint strings. No custody impact. | ALLOW | ALLOW | ALLOW | ALLOW | low |
| **Group\*/Member\*** | `GroupPointer` etc. | `getGroupPointerState` / `getTokenGroupState` / `getGroupMemberPointerState` / `getTokenGroupMemberState` | Organizational metadata only. | ALLOW | ALLOW | ALLOW | ALLOW | low |

Notes on profile splits:
- **DefaultAccountState / PausableConfig / ConfidentialTransferMint**: AMM and escrow get **HANDLE** (a pool can route around frozen/paused states, or the flow is short-lived), but **vault/lending REJECT** because they hold custody for an indefinite term and a freeze/pause is a liveness-loss of user funds.
- **TransferFeeConfig**: HANDLE for everyone — fees are tractable if you delta-measure. See [transfer-fee-accounting.md](transfer-fee-accounting.md).
- **TransferHook / PermanentDelegate / NonTransferable**: REJECT across the board. There is no safe generic handling; for hooks you need an explicit per-program allowlist of verifiably-built code, not a profile relaxation.

## Account-level extensions on the USER's source account (deposit path)

These live on the depositor's token account, not the mint. They affect the **owner-signed transfer into your protocol**. A mint scan won't catch them — inspect the source account at deposit time.

| Extension | Rust enum | TS detection | Impact / what breaks | Verdict | Sev |
|-----------|-----------|--------------|----------------------|---------|-----|
| **MemoTransfer** | `MemoTransfer` | `getMemoTransfer(account)` → `.requireIncomingTransferMemos` | Destination requiring memos rejects transfers with no preceding top-level Memo ix. CPI-only deposit flows can't inject one. | HANDLE — don't enable on your own accounts; prepend a Memo ix when depositing to a memo-required dest | medium |
| **CpiGuard** | `CpiGuard` | `getCpiGuard(account)` → `.lockCpi` | A user's source account with CpiGuard **on** blocks owner-signed CPI transfers (your `transfer_checked` via CPI fails). Cannot be toggled via CPI. | HANDLE — use a delegate-approval or top-level (non-CPI) transfer deposit pattern | medium |
| **ImmutableOwner** | `ImmutableOwner` | `getImmutableOwner(account)` | Prevents owner reassignment. ATA default. Strictly positive/benign. | ALLOW | low |

## How the scanner combines verdicts

- Per-extension verdict: `verdictForProfile(entry, profile)` (in `risk.ts`) falls back to `entry.verdict.default` when a profile is absent; then `scanMint()` (in `scan.ts`) forces the result to `ALLOW` if `active === false`.
- Overall mint verdict: `worstVerdict(...)` — any REJECT ⇒ REJECT; else any HANDLE ⇒ HANDLE; else ALLOW.
- Unknown/unmodeled extension ⇒ `UNKNOWN_EXTENSION` (severity high, HANDLE) — treat as untrusted until investigated. Never silently ALLOW an extension you don't recognize.

Run it:
```bash
cd ../tools/t22-scan && bun install
bun run scan <MINT> --profile=vault     # or: npx tsx src/index.ts <MINT> --profile=vault
```

## DO / DON'T

- **DO** re-read the mint at point of use — `MintCloseAuthority` enables close+reinit, so cached per-mint trust is unsound.
- **DO** treat `TransferFeeConfig` as active even at 0 bps; the fee authority can raise it next epoch.
- **DO** account in **raw base units**; use UI amount (Interest/Scaled) only for display.
- **DO** check `programId`/`delegate`/`state` to distinguish inert from active before rejecting — an unset hook or `None` delegate is genuinely safe *today* (but note it can be set later if the authority lives).
- **DON'T** trust the instruction `amount` as the credited amount — delta-measure (see [transfer-fee-accounting.md](transfer-fee-accounting.md)).
- **DON'T** rely on "mint+freeze authority revoked" as proof of safety — `PermanentDelegate` and `TransferHook` are orthogonal and can still rug/clawback.
- **DON'T** relax `TransferHook`/`PermanentDelegate`/`NonTransferable` by profile. Allowlist specific hook program ids instead.
- **DON'T** ALLOW an `Unknown(n)` extension — investigate first.
