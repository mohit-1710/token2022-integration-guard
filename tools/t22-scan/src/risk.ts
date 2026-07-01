// Integrator-side risk model for Token-2022 (Token Extensions) mints.
//
// This encodes what each *mint-level* extension means for a program that CONSUMES
// the mint — an AMM, vault, lending market, or escrow — NOT for the issuer.
// Verdicts are deliberately conservative: a third-party mint is untrusted input.

export type Profile = "amm" | "vault" | "lending" | "escrow" | "generic";
export type Verdict = "ALLOW" | "HANDLE" | "REJECT";
export type Severity = "critical" | "high" | "medium" | "low";

export interface RiskEntry {
  /** Why this matters to an integrator. */
  impact: string;
  /** What it concretely breaks if you ignore it. */
  breaks: string;
  /** Default severity for an integrator. */
  severity: Severity;
  /** Per-profile verdict. Falls back to `default` when a profile is absent. */
  verdict: Partial<Record<Profile, Verdict>> & { default: Verdict };
  /** Concrete mitigation an integrator should apply. */
  mitigation: string;
}

// Keyed by ExtensionType enum *name* (see @solana/spl-token ExtensionType).
export const RISK_MATRIX: Record<string, RiskEntry> = {
  TransferFeeConfig: {
    impact:
      "A fee is withheld from every transfer, so the amount credited to your account is LESS than the amount sent.",
    breaks:
      "share/LP math, escrow accounting, 1:1 invariants — anything that trusts the instruction `amount`",
    severity: "high",
    verdict: { default: "HANDLE" },
    mitigation:
      "Never trust the transfer `amount`. Measure the credited delta (pre/post balance + reload) OR read TransferFeeConfig and subtract the epoch fee. Mint shares on the *received* amount.",
  },
  TransferHook: {
    impact:
      "Every transfer makes a CPI into an issuer-controlled program with attacker-chosen extra accounts.",
    breaks:
      "atomicity & reentrancy assumptions; the hook can fail (DoS your withdrawals), re-enter your program, or read/write injected accounts",
    severity: "critical",
    verdict: { amm: "REJECT", vault: "REJECT", lending: "REJECT", escrow: "REJECT", default: "REJECT" },
    mitigation:
      "Reject unknown hook programs. If you must support one, allowlist the specific hook program id, apply checks-effects-interactions, set a reentrancy/transferring flag, and resolve extra accounts safely.",
  },
  PermanentDelegate: {
    impact:
      "A permanent delegate can transfer or burn tokens from ANY account — including your vault — at any time.",
    breaks:
      "custody — the issuer (or whoever holds the delegate) can drain deposited collateral; your books no longer reflect reality",
    severity: "critical",
    verdict: { amm: "REJECT", vault: "REJECT", lending: "REJECT", escrow: "REJECT", default: "REJECT" },
    mitigation:
      "Reject by default. Only allow if the delegate is provably benign (e.g. burned/None) or a governance you trust. Treat balances as adversarially mutable otherwise.",
  },
  DefaultAccountState: {
    impact:
      "New token accounts can be created Frozen by default; the freeze authority controls thaw/freeze.",
    breaks:
      "deposits & withdrawals — your freshly-created vault ATA may be frozen, and the issuer can freeze it later",
    severity: "high",
    verdict: { amm: "HANDLE", vault: "REJECT", lending: "REJECT", escrow: "HANDLE", default: "HANDLE" },
    mitigation:
      "Detect Frozen default; require the account be thawed before relying on it. Treat issuer freeze authority as a liveness risk for custody profiles.",
  },
  MintCloseAuthority: {
    impact: "The mint account itself can be closed (when supply is zero).",
    breaks: "long-lived references to the mint; edge cases in pools that assume the mint persists",
    severity: "medium",
    verdict: { default: "HANDLE" },
    mitigation: "Usually low impact for live tokens; note it and avoid assuming the mint is immortal.",
  },
  ConfidentialTransferMint: {
    impact: "Balances/amounts can be encrypted; on-chain reads of token amounts may not reflect confidential balances.",
    breaks: "accounting that reads visible balances; oracle/price and collateral valuation",
    severity: "high",
    verdict: { amm: "REJECT", vault: "REJECT", lending: "REJECT", escrow: "HANDLE", default: "HANDLE" },
    mitigation:
      "Avoid unless you explicitly support confidential transfers. Do not assume visible balance == true balance.",
  },
  ConfidentialTransferFeeConfig: {
    impact: "Confidential-transfer fee config; pairs with confidential transfers.",
    breaks: "fee accounting under confidential transfers",
    severity: "high",
    verdict: { default: "HANDLE" },
    mitigation: "Same posture as ConfidentialTransferMint.",
  },
  NonTransferable: {
    impact: "Tokens cannot be transferred (soulbound).",
    breaks: "ANY protocol that needs to move the token out — deposits stick, withdrawals impossible",
    severity: "critical",
    verdict: { amm: "REJECT", vault: "REJECT", lending: "REJECT", escrow: "REJECT", default: "REJECT" },
    mitigation: "Reject for any transfer-based protocol; funds would be permanently locked.",
  },
  InterestBearingConfig: {
    impact: "The UI amount grows over time via a rate; the raw amount (what transfers move) is unchanged.",
    breaks: "display vs accounting confusion; using amount_to_ui_amount for math instead of raw amounts",
    severity: "medium",
    verdict: { default: "HANDLE" },
    mitigation: "Account in RAW base units only. Use UI amount strictly for display. Never settle on UI amounts.",
  },
  PausableConfig: {
    impact: "An authority can pause all transfers of the mint.",
    breaks: "liveness — your withdrawals/liquidations can be frozen by the issuer at will",
    severity: "high",
    verdict: { amm: "HANDLE", vault: "REJECT", lending: "REJECT", escrow: "HANDLE", default: "HANDLE" },
    mitigation: "Treat as a custody/liveness risk. For lending, a pause can block liquidations — price in or reject.",
  },
  ScaledUiAmountConfig: {
    impact: "A multiplier scales the UI amount; the raw amount is unchanged and the multiplier can change.",
    breaks: "display vs accounting; using scaled UI amounts in math; assuming a fixed multiplier",
    severity: "medium",
    verdict: { default: "HANDLE" },
    mitigation: "Account in RAW units. Re-read the multiplier when displaying; never persist a scaled value as truth.",
  },
  // Informational / metadata extensions — no transfer-path impact.
  MetadataPointer: { impact: "Points to a metadata account/self.", breaks: "nothing transfer-related", severity: "low", verdict: { default: "ALLOW" }, mitigation: "Informational." },
  TokenMetadata: { impact: "On-mint metadata.", breaks: "nothing transfer-related", severity: "low", verdict: { default: "ALLOW" }, mitigation: "Informational." },
  GroupPointer: { impact: "Points to a token-group config.", breaks: "nothing transfer-related", severity: "low", verdict: { default: "ALLOW" }, mitigation: "Informational." },
  TokenGroup: { impact: "Token-group config.", breaks: "nothing transfer-related", severity: "low", verdict: { default: "ALLOW" }, mitigation: "Informational." },
  GroupMemberPointer: { impact: "Points to group-member config.", breaks: "nothing transfer-related", severity: "low", verdict: { default: "ALLOW" }, mitigation: "Informational." },
  TokenGroupMember: { impact: "Group-member config.", breaks: "nothing transfer-related", severity: "low", verdict: { default: "ALLOW" }, mitigation: "Informational." },
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

export function verdictForProfile(entry: RiskEntry, profile: Profile): Verdict {
  return entry.verdict[profile] ?? entry.verdict.default;
}

/** Overall verdict = worst per-extension verdict for the profile. */
export function worstVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("REJECT")) return "REJECT";
  if (verdicts.includes("HANDLE")) return "HANDLE";
  return "ALLOW";
}

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/** An extension present on the mint but unknown to this matrix is suspicious. */
export const UNKNOWN_EXTENSION: RiskEntry = {
  impact: "Unknown/unmodeled extension present on the mint.",
  breaks: "unknown — an extension this tool does not recognize may alter transfer behavior",
  severity: "high",
  verdict: { default: "HANDLE" },
  mitigation: "Investigate the extension manually before integrating; treat as untrusted until understood.",
};
