import { Connection, PublicKey } from "@solana/web3.js";
import * as token from "@solana/spl-token";
import {
  RISK_MATRIX,
  UNKNOWN_EXTENSION,
  verdictForProfile,
  worstVerdict,
  severityRank,
  type Profile,
  type Verdict,
  type RiskEntry,
} from "./risk.js";

export interface DetectedExtension {
  name: string;
  entry: RiskEntry;
  verdict: Verdict;
  active: boolean; // false => extension is present but in an inert/benign state
  detail?: string; // human-readable specifics (fee bps, hook program, delegate, ...)
}

// @solana/spl-token 0.4.14's ExtensionType reverse-map omits a few values; fill them in.
const EXTRA_EXTENSION_NAMES: Record<number, string> = {
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
};

export interface ScanResult {
  mint: string;
  programId: string;
  isToken2022: boolean;
  decimals: number;
  profile: Profile;
  extensions: DetectedExtension[];
  overall: Verdict;
}

/** Safely call an optional getter from @solana/spl-token without crashing on version drift. */
function call<T>(fn: unknown, ...args: unknown[]): T | null {
  if (typeof fn !== "function") return null;
  try {
    return (fn as (...a: unknown[]) => T)(...args);
  } catch {
    return null;
  }
}

/** Returns the human-readable detail plus whether the extension is in an *active* (dangerous) state. */
function analyze(name: string, mint: token.Mint): { detail?: string; active: boolean } {
  try {
    switch (name) {
      case "TransferFeeConfig": {
        const c = call<any>((token as any).getTransferFeeConfig, mint);
        if (!c) return { active: true };
        const nt = c.newerTransferFee ?? c.olderTransferFee;
        const bps = Number(nt?.transferFeeBasisPoints ?? 0);
        const max = nt?.maximumFee?.toString?.() ?? String(nt?.maximumFee ?? 0);
        const zero = bps === 0 && (max === "0" || max === "0n");
        // A fee authority can raise the fee later, so never fully clear it — but say so.
        return {
          detail: `feeBasisPoints=${bps} (${(bps / 100).toFixed(2)}%), maximumFee=${max}${zero ? " — currently zero, but the fee authority can raise it" : ""}`,
          active: true,
        };
      }
      case "TransferHook": {
        const h = call<any>((token as any).getTransferHook, mint);
        const prog = h?.programId ? new PublicKey(h.programId) : null;
        const set = !!prog && !prog.equals(PublicKey.default);
        return {
          detail: set ? `hookProgram=${prog!.toBase58()}` : "no hook program set (inert)",
          active: set,
        };
      }
      case "PermanentDelegate": {
        const d = call<any>((token as any).getPermanentDelegate, mint);
        const del = d?.delegate ? new PublicKey(d.delegate) : null;
        const set = !!del && !del.equals(PublicKey.default);
        return {
          detail: set ? `delegate=${del!.toBase58()} (ACTIVE)` : "delegate is None (inert)",
          active: set,
        };
      }
      case "DefaultAccountState": {
        const s = call<any>((token as any).getDefaultAccountState, mint);
        const st = s?.state;
        const frozen = st === (token as any).AccountState?.Frozen;
        return {
          detail: st !== undefined ? `defaultState=${frozen ? "Frozen" : "Initialized"}` : undefined,
          active: !!frozen,
        };
      }
      case "InterestBearingConfig": {
        const i = call<any>((token as any).getInterestBearingMintConfigState, mint);
        return { detail: i ? `currentRate=${i.currentRate}bps` : undefined, active: true };
      }
      default:
        return { active: true };
    }
  } catch {
    return { active: true };
  }
}

export async function scanMint(
  connection: Connection,
  mintAddress: PublicKey,
  profile: Profile = "generic",
): Promise<ScanResult> {
  // Determine owning program (classic Token vs Token-2022).
  const acct = await connection.getAccountInfo(mintAddress);
  if (!acct) throw new Error(`Mint ${mintAddress.toBase58()} not found on this cluster.`);
  const programId = acct.owner;
  const isToken2022 = programId.equals(token.TOKEN_2022_PROGRAM_ID);

  const mint = await token.getMint(connection, mintAddress, undefined, programId);

  const extensions: DetectedExtension[] = [];
  if (isToken2022 && mint.tlvData && mint.tlvData.length > 0) {
    const types = token.getExtensionTypes(mint.tlvData);
    for (const ext of types) {
      const name = token.ExtensionType[ext] ?? EXTRA_EXTENSION_NAMES[ext] ?? `Unknown(${ext})`;
      // Skip account-level / housekeeping types that don't apply to a mint scan.
      if (name === "Uninitialized") continue;
      const entry = RISK_MATRIX[name] ?? UNKNOWN_EXTENSION;
      const { detail, active } = analyze(name, mint);
      // Present-but-inert extensions (e.g. a TransferHook with no program, a None permanent
      // delegate, a non-Frozen default state) are downgraded to ALLOW with a note.
      const baseVerdict = verdictForProfile(entry, profile);
      const verdict: Verdict = active ? baseVerdict : "ALLOW";
      extensions.push({
        name,
        entry,
        verdict,
        active,
        detail: active ? detail : `${detail ?? "present"} — inert; would be ${baseVerdict} if activated`,
      });
    }
  }

  // Sort most-dangerous first.
  extensions.sort(
    (a, b) =>
      severityRank(b.entry.severity) - severityRank(a.entry.severity) ||
      a.name.localeCompare(b.name),
  );

  return {
    mint: mintAddress.toBase58(),
    programId: programId.toBase58(),
    isToken2022,
    decimals: mint.decimals,
    profile,
    extensions,
    overall: worstVerdict(extensions.map((e) => e.verdict)),
  };
}
