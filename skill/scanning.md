# Scanning a mint with `t22-scan`

> Covers the `t22-scan` CLI and the `scanMint()` programmatic API. Read this **before** you integrate any third-party Token-2022 mint, and wire it into CI as a gate.

A third-party mint is **untrusted input**. Its extensions decide whether your AMM/vault/lending/escrow can safely consume it. `t22-scan` (../tools/t22-scan) reads the mint on-chain, classifies every mint-level extension against an integrator risk matrix, and returns a single verdict + an exit code you can gate on.

## Install

The tool lives at `../tools/t22-scan`. It is pure web3.js + `@solana/spl-token` 0.4.14 — no build needed to run via `tsx`.

```bash
cd ../tools/t22-scan
bun install            # or: npm install
# run without building:
bun run scan -- <MINT> --profile=vault
# or via npx/tsx directly:
npx tsx src/index.ts <MINT> --profile=vault
# build a real bin (dist/index.js -> t22-scan):
npm run build && node dist/index.js <MINT> --profile=vault
```

## Usage

```
t22-scan <MINT_ADDRESS> [--profile=amm|vault|lending|escrow|generic]
                        [--cluster=mainnet|devnet|testnet|localnet]
                        [--url=<rpc>] [--json]
```

| Flag | Default | Notes |
|------|---------|-------|
| `--profile` | `generic` | Picks the per-extension verdict column. Unknown values fall back to `generic`. |
| `--cluster` | `mainnet` | `mainnet`/`mainnet-beta`, `devnet`, `testnet`, `localnet`/`local` (127.0.0.1:8899). |
| `--url` | — | Raw RPC URL; **overrides** `--cluster`. Use your own RPC for mainnet (the public endpoint is rate-limited). |
| `--json` | off | Machine-readable output for CI/programmatic consumers. |

### Exit codes (CI gating)

The CLI's exit code **is** the verdict — see `../tools/t22-scan/src/index.ts`:

| Exit | Meaning |
|------|---------|
| `0` | Overall verdict is `ALLOW` or `HANDLE` — safe to integrate (apply the listed mitigations for `HANDLE`). |
| `2` | Overall verdict is `REJECT` — do not integrate this mint for this profile. |
| `1` | Usage error: missing/invalid mint, or RPC/lookup failure (mint not found on cluster). |

Note `HANDLE` exits `0`, not a distinct code. `HANDLE` means "integrable **if** you apply the mitigation" (e.g. measure received deltas for a transfer fee). It is not a free pass — read the `mitigation` line. If your CI wants to force-review `HANDLE`, parse `--json` and branch on `.overall` instead of relying on the exit code alone.

## Real example: PYUSD (`2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo`)

PYUSD is a live mainnet Token-2022 mint. It carries `PermanentDelegate`, `ConfidentialTransferMint`, `TransferHook`, plus metadata extensions.

```bash
t22-scan 2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo --profile=vault
```

Result for a **vault**: **REJECT** (exit `2`). The driver:

- **`PermanentDelegate` [critical] → REJECT** — `delegate=<...> (ACTIVE)`. A permanent delegate can transfer/burn from *any* account, including your vault. Custody is not yours.
- **`ConfidentialTransferMint` [high] → REJECT** for vault/amm/lending — visible balances may not equal true balances; accounting and collateral valuation break.
- **`TransferHook` [critical]** is present but **inert** — the scanner reads `getTransferHook(mint)`, sees no program set (`PublicKey.default`), marks it `active: false`, and **downgrades it to ALLOW** with the note `no hook program set (inert) — inert; would be REJECT if activated`. The hook does not drive the verdict *today*, but the note warns you it could if the issuer sets a program later.

Because **overall = worst per-extension verdict**, the active `PermanentDelegate`/`ConfidentialTransferMint` REJECTs win and the scan exits `2`. The same mint under `--profile=escrow` softens `ConfidentialTransferMint` to `HANDLE`, but `PermanentDelegate` is `REJECT` for *all* profiles, so the overall stays `REJECT`.

This is the core lesson: **"has a scary extension" is not the same as "the scary extension is armed."** The scanner distinguishes the two (active vs inert) so you neither over-reject inert config nor trust an armed delegate.

## How the verdict is computed

See `../tools/t22-scan/src/scan.ts` and `../tools/t22-scan/src/risk.ts`.

1. **Resolve owner program.** `getAccountInfo(mint).owner`; if it isn't `TOKEN_2022_PROGRAM_ID`, it's a classic SPL token with no extensions → no risky extensions, `ALLOW`.
2. **Enumerate extensions.** `getMint(connection, mint, undefined, programId)` then `getExtensionTypes(mint.tlvData)`. Names come from `ExtensionType[ext]` (with a small fill-in map for enum values `@solana/spl-token` 0.4.14 omits, e.g. confidential-fee types). `Uninitialized` is skipped.
3. **Look up each extension** in `RISK_MATRIX` (`risk.ts`). Unknown extensions fall back to `UNKNOWN_EXTENSION` (severity `high`, `HANDLE` — investigate manually).
4. **Pick the profile verdict:** `verdictForProfile(entry, profile)` = `entry.verdict[profile] ?? entry.verdict.default`.
5. **Inert downgrade.** `analyze(name, mint)` inspects live state via the typed getters (`getPermanentDelegate`, `getTransferHook`, `getTransferFeeConfig`, `getDefaultAccountState`, `getInterestBearingMintConfigState`). If the dangerous capability is **not armed** (delegate is `None`/default, hook program unset, default state not `Frozen`), `active=false` and the per-extension verdict is forced to `ALLOW` with an explanatory note. If armed, the matrix verdict stands.
6. **Overall = `worstVerdict(...)`** over per-extension verdicts: any `REJECT` ⇒ `REJECT`; else any `HANDLE` ⇒ `HANDLE`; else `ALLOW`. Extensions are sorted most-severe-first for display.

### Caveats baked into the model

- **`TransferFeeConfig` is always `active: true`** even at 0 bps — the fee authority can raise it later. The detail line says so. Don't treat a zero fee as permanently zero (see [transfer-fee-accounting.md](transfer-fee-accounting.md)).
- **Inert ≠ safe forever.** An inert hook/delegate can be armed post-integration if the corresponding authority still exists. For custody profiles, treat the *existence* of an authority as a liveness/custody risk, not just its current value.

## Programmatic API

`scanMint(connection, mint, profile)` returns a structured `ScanResult` — use it inside tests, bots, or an admin "list-a-market" guard.

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { scanMint } from "../tools/t22-scan/src/scan.js";

const connection = new Connection(process.env.RPC_URL!, "confirmed");
const mint = new PublicKey("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo");

const result = await scanMint(connection, mint, "vault");
// result.overall: "ALLOW" | "HANDLE" | "REJECT"
// result.extensions[]: { name, entry, verdict, active, detail }
if (result.overall === "REJECT") {
  throw new Error(`Refusing to list ${result.mint}: ${
    result.extensions.filter((e) => e.verdict === "REJECT").map((e) => e.name).join(", ")
  }`);
}
```

`ScanResult` fields: `mint`, `programId`, `isToken2022`, `decimals`, `profile`, `extensions[]`, `overall`. Each `extensions[]` item carries the full `RiskEntry` (`impact`, `breaks`, `severity`, `mitigation`) plus the live `detail` string and `active` flag.

## Wire it into CI

Fail the build if a mint your protocol must support flips to `REJECT` (e.g. an issuer arms a permanent delegate after listing). Gate on the exit code:

```yaml
# .github/workflows/t22-guard.yml
- name: Token-2022 integration guard
  run: |
    cd tools/t22-scan && bun install
    # Each mint your protocol lists, with the profile it's used under:
    bun run scan -- 2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo --profile=vault --url="$RPC_URL"
  # exit 2 (REJECT) fails the step; exit 0 (ALLOW/HANDLE) passes.
```

For nightly drift detection on already-listed mints, run the scan against each supported mint on a schedule and alert on any transition to `REJECT`. Pair the CLI gate with the on-chain check in [extension-allowlist-pattern.md](extension-allowlist-pattern.md) (implemented in [../examples/guard/programs/guard/src/lib.rs](../examples/guard/programs/guard/src/lib.rs)) — the scanner is your off-chain pre-flight; the guard program is the on-chain backstop.

## DO / DON'T

- **DO** scan every third-party mint with the *exact profile* it will be used under, before integrating.
- **DO** gate CI on exit code `2`, and re-scan listed mints on a schedule — extensions can be armed after listing.
- **DO** read the `HANDLE` mitigations; `HANDLE` exits `0` but still requires code (delta accounting, raw-unit math, thaw checks).
- **DON'T** assume a present extension is armed — or that an inert one stays inert. Check `active` and the `detail` note.
- **DON'T** use the public RPC for production mainnet scans; pass `--url=<your RPC>`.
- **DON'T** treat the scan as sufficient on its own — combine with on-chain validation and the per-extension accounting in the sibling skill files.
