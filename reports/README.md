# Live-mainnet scan reports

Committed output from `t22-scan` against real mainnet mints. Reproduce any of them:

```bash
cd ../tools/t22-scan && bun install
bun run scan <MINT> --profile=vault
```

| File | Mint | Program | Verdict |
|---|---|---|---|
| [`pyusd-vault.txt`](pyusd-vault.txt) | PYUSD `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 | **REJECT** (active PermanentDelegate + ConfidentialTransfer; TransferHook inert) |
| [`usdc-vault.txt`](usdc-vault.txt) | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | classic SPL | **ALLOW** (no extensions) |

The contrast is the point: a hostile-by-configuration mint is refused, a benign one passes.
