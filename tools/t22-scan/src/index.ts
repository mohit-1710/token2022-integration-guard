#!/usr/bin/env node
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { scanMint } from "./scan.js";
import type { Profile, Verdict } from "./risk.js";

const PROFILES: Profile[] = ["amm", "vault", "lending", "escrow", "generic"];

function arg(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

function resolveUrl(): string {
  const url = arg("--url");
  if (url) return url;
  const cluster = (arg("--cluster") ?? "mainnet").toLowerCase();
  if (cluster === "mainnet" || cluster === "mainnet-beta") return clusterApiUrl("mainnet-beta");
  if (cluster === "devnet") return clusterApiUrl("devnet");
  if (cluster === "testnet") return clusterApiUrl("testnet");
  if (cluster === "localnet" || cluster === "local") return "http://127.0.0.1:8899";
  return cluster; // treat as a raw URL
}

const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function colorVerdict(v: Verdict): string {
  if (v === "REJECT") return C.red(C.bold(v));
  if (v === "HANDLE") return C.yellow(C.bold(v));
  return C.green(C.bold(v));
}

function usage(): void {
  console.log(`t22-scan — Token-2022 integrator risk scanner

Usage:
  t22-scan <MINT_ADDRESS> [--profile=amm|vault|lending|escrow|generic] [--cluster=mainnet|devnet] [--url=<rpc>] [--json]

Examples:
  t22-scan 2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo --profile=vault
  t22-scan <mint> --cluster=devnet --json

Exit codes: 0 = ALLOW/HANDLE, 2 = REJECT (so CI can gate on it).`);
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const mintStr = positional[0];
  if (!mintStr || process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    process.exit(mintStr ? 0 : 1);
  }

  const profileArg = (arg("--profile") ?? "generic") as Profile;
  const profile: Profile = PROFILES.includes(profileArg) ? profileArg : "generic";
  const asJson = process.argv.includes("--json");

  let mint: PublicKey;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    console.error(`Invalid mint address: ${mintStr}`);
    process.exit(1);
  }

  const connection = new Connection(resolveUrl(), "confirmed");
  const result = await scanMint(connection, mint, profile);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ...result,
          extensions: result.extensions.map((e) => ({
            name: e.name,
            severity: e.entry.severity,
            verdict: e.verdict,
            active: e.active,
            impact: e.entry.impact,
            breaks: e.entry.breaks,
            mitigation: e.entry.mitigation,
            detail: e.detail ?? null,
          })),
        },
        null,
        2,
      ),
    );
    process.exit(result.overall === "REJECT" ? 2 : 0);
  }

  console.log("");
  console.log(C.bold(`Token-2022 Integration Scan`));
  console.log(`  mint     ${result.mint}`);
  console.log(`  program  ${result.programId}${result.isToken2022 ? "" : C.gray("  (classic SPL Token — no extensions)")}`);
  console.log(`  decimals ${result.decimals}`);
  console.log(`  profile  ${result.profile}`);
  console.log("");

  if (result.extensions.length === 0) {
    console.log(C.green("  No risky extensions detected.") + C.gray("  Treat like a classic SPL token."));
  } else {
    for (const e of result.extensions) {
      console.log(`  ${colorVerdict(e.verdict)}  ${C.bold(e.name)} ${C.gray(`[${e.entry.severity}]`)}`);
      console.log(`        impact:     ${e.entry.impact}`);
      console.log(`        breaks:     ${e.entry.breaks}`);
      if (e.detail) console.log(`        detail:     ${e.detail}`);
      console.log(`        mitigation: ${e.entry.mitigation}`);
      console.log("");
    }
  }

  console.log(`  ${C.bold("OVERALL")}: ${colorVerdict(result.overall)} for a ${C.bold(result.profile)} integration`);
  console.log("");
  process.exit(result.overall === "REJECT" ? 2 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
