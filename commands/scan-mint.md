---
description: Scan a Token-2022 mint and report integrator risk for a chosen profile (amm/vault/lending/escrow).
argument-hint: <mint-address> [profile]
---

# /scan-mint

Scan a Token-2022 mint **before** integrating it and report the per-extension risk and
an overall `ALLOW` / `HANDLE` / `REJECT` verdict for the chosen integration profile.

## Inputs
- `$1` — the mint address (base58). Required.
- `$2` — profile: `amm` | `vault` | `lending` | `escrow` | `generic` (default `generic`).

## Steps

1. Prefer the runnable scanner if present in the repo:
   ```bash
   cd tools/t22-scan && (bun install >/dev/null 2>&1 || npm install) \
     && bun run scan "$1" --profile="${2:-generic}" --cluster=mainnet
   ```
   It prints each extension with impact / what-it-breaks / mitigation, an overall
   verdict, and exits `2` on `REJECT` (CI-gateable). Use `--json` for machine output,
   `--cluster=devnet` or `--url=<rpc>` for other clusters.

2. If the scanner isn't available, fetch the mint with `@solana/spl-token`
   (`getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID)`), enumerate extensions with
   `getExtensionTypes(mint.tlvData)`, and classify each using
   [skill/extension-risk-matrix.md](../skill/extension-risk-matrix.md). Guard hook/delegate
   fields against `PublicKey.default` (inert).

3. Report: the detected extensions, the worst verdict, and the concrete mitigation for
   anything `HANDLE` (e.g. delta-measured deposits for a transfer fee). If `REJECT`, say
   exactly which extension and why, and whether the user's profile could ever accept it.

Then point the user to the right hardening file:
[transfer-fee-accounting.md](../skill/transfer-fee-accounting.md) ·
[permanent-delegate-and-freeze.md](../skill/permanent-delegate-and-freeze.md) ·
[transfer-hook-reentrancy.md](../skill/transfer-hook-reentrancy.md).
