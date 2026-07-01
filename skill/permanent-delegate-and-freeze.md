# Permanent Delegate & Freeze — authority-capture extensions

What this covers: the three Token-2022 extensions that hand the *issuer* standing power over tokens you custody — **PermanentDelegate** (clawback/rug), **DefaultAccountState=Frozen** (deposits born dead + later-freeze), and **Pausable** (issuer halts all transfers). When to read: you're deciding whether to accept a third-party mint into a vault/AMM/lending/escrow, or wiring detection into [../tools/t22-scan](../tools/t22-scan). Sibling reading: [extension-allowlist-pattern.md](extension-allowlist-pattern.md), [transfer-hook-reentrancy.md](transfer-hook-reentrancy.md), [transfer-fee-accounting.md](transfer-fee-accounting.md).

## The core lie: "mint + freeze revoked = safe"

The single most common integrator mistake. Checking only the SPL `mintAuthority` and `freezeAuthority` (the classic Token fields) tells you nothing about Token-2022 extensions. A mint with **mint authority renounced, freeze authority renounced, and LP locked** can *still* drain every holder via a permanent delegate. RugCheck reports this is mass-weaponized — flagging a large share of new tokens (RugCheck/DEV trend writeups, Q1-2026; dollar figures are third-party estimates). **You must inspect the extension fields independently.**

| Extension | The standing power it grants the issuer | Integrator impact | Verdict (custody) |
|---|---|---|---|
| **PermanentDelegate** (=12) | A fixed key can `transfer`/`burn` from ANY account — including your vault — forever. Unrevocable. | Clawback / rug. Your books stop reflecting reality. | **REJECT** unless the delegate IS your protocol |
| **DefaultAccountState=Frozen** (=6) | New ATAs are born `Frozen`; freeze authority controls thaw/freeze. | Vault ATA deposits silently revert; issuer can freeze you later. | **REJECT** (or guarantee thaw) |
| **Pausable / PausableConfig** (=26) | Authority globally halts transfer/mint/burn. | Liveness: withdrawals & liquidations blocked at will. | **REJECT** for custody/lending |

---

## 1. PermanentDelegate — unrevocable clawback

The delegate key has the standing authority of an approved delegate on *every* account of the mint, and it cannot be removed once set. From [../tools/t22-scan/src/risk.ts](../tools/t22-scan/src/risk.ts):

> "A permanent delegate can transfer or burn tokens from ANY account — including your vault — at any time." → breaks custody; the issuer can drain deposited collateral.

Why renouncing other authorities doesn't help: clawback flows through the delegate field, which is *separate* from mint/freeze authority. A "clean" token by classic checks can still rug.

### Detection — guard against `PublicKey.default`

The field is always present in the TLV once the extension exists; an *inert* delegate is `None`, which deserializes to the all-zero pubkey. Treat zero as inert, anything else as ACTIVE. From [../tools/t22-scan/src/scan.ts](../tools/t22-scan/src/scan.ts):

```ts
case "PermanentDelegate": {
  const d = call<any>((token as any).getPermanentDelegate, mint);
  const del = d?.delegate ? new PublicKey(d.delegate) : null;
  const set = !!del && !del.equals(PublicKey.default);   // None => PublicKey.default => inert
  return {
    detail: set ? `delegate=${del!.toBase58()} (ACTIVE)` : "delegate is None (inert)",
    active: set,
  };
}
```

The `call()` wrapper returns `null` instead of crashing if `getPermanentDelegate` is missing or throws under `@solana/spl-token` 0.4.14 version drift. **Caveat (be honest about the posture):** for the `PermanentDelegate` and `DefaultAccountState` cases a `null` read collapses to the *inert* branch (`delegate === None`, state ≠ `Frozen`) → `active: false` → downgraded to ALLOW. So the scanner does **not** fail safe on these specific getters — a missing getter reads as "inert", not "dangerous". The on-chain guard's presence-based reject (below) is the real backstop; treat the scanner as an advisory pre-flight, not the last line of defense.

> Note: an inert (`None`) permanent delegate is downgraded to ALLOW with a note in the scanner, because the *capability* requires re-setting the authority — which the mint config may or may not permit. For a custody profile, prefer the on-chain program's blanket reject (below): the extension's mere presence is the signal.

---

## 2. DefaultAccountState=Frozen — deposits born dead

When a mint sets `DefaultAccountState = Frozen`, every newly created ATA — *including the vault ATA your `init_vault` just created* — comes into existence `Frozen`. `mintTo` and `transfer` into it revert until someone with freeze authority thaws it. And because the freeze authority persists, the issuer can re-freeze your vault at any later time (Neodyme Token-2022 writeup; SPL issue #3789).

The trap: **"the instruction didn't revert" is not proof of a deposit.** A frozen target makes the transfer fail; if you don't verify the balance delta you may credit a deposit that never landed. Verify by balance delta, never by absence of error — see [transfer-fee-accounting.md](transfer-fee-accounting.md) for the delta-measure pattern the guard's `deposit` uses.

### Detection — compare against `AccountState.Frozen`

```ts
case "DefaultAccountState": {
  const s = call<any>((token as any).getDefaultAccountState, mint);
  const st = s?.state;
  const frozen = st === (token as any).AccountState?.Frozen;   // Frozen === 2
  return {
    detail: st !== undefined ? `defaultState=${frozen ? "Frozen" : "Initialized"}` : undefined,
    active: !!frozen,
  };
}
```

`AccountState`: `Uninitialized=0, Initialized=1, Frozen=2`. Only `Frozen` is dangerous; a `DefaultAccountState` extension set to `Initialized` is inert.

---

## 3. Pausable — issuer halts all transfers

An authority can globally pause transfer/mint/burn for the mint. For a lending market this is the worst case: a pause can block *liquidations* while collateral keeps moving against you. For a vault it blocks withdrawals on demand. From risk.ts:

> "An authority can pause all transfers of the mint." → breaks liveness; withdrawals/liquidations frozen by the issuer at will.

### Detection — `getPausableConfig`, NOT `getPausable`

There is no `getPausable` in 0.4.14. Use `getPausableConfig(mint)` → `{ authority, paused }`. The JS enum name is `PausableConfig` (=26); the Rust variant in `spl-token-2022-interface` is `Pausable`. A non-default `authority` means the issuer retains the power to pause even if `paused === false` right now.

```ts
const c = call<any>((token as any).getPausableConfig, mint);
const auth = c?.authority ? new PublicKey(c.authority) : null;
const canPause = !!auth && !auth.equals(PublicKey.default);  // authority retained => liveness risk
```

---

## Why the guard rejects all three (custody profile)

The reference vault [../examples/guard/programs/guard/src/lib.rs](../examples/guard/programs/guard/src/lib.rs) is **default-deny**: it allowlists only inert/handleable extensions and rejects everything else, including these three by name for a precise error:

```rust
match ext {
    ExtensionType::TransferHook
    | ExtensionType::PermanentDelegate
    | ExtensionType::NonTransferable
    | ExtensionType::DefaultAccountState
    | ExtensionType::ConfidentialTransferMint => {
        return err!(GuardError::ForbiddenExtension)
    }
    ExtensionType::Uninitialized => {}
    other if !ALLOWED.contains(&other) => return err!(GuardError::UnsupportedExtension),
    _ => {}
}
```

This runs in `init_vault` (so the unsafe mint can never get a vault), and **re-runs in `deposit` and `withdraw`** — because a mint's authorities can change after init. The check is on the *presence* of the extension, deliberately stricter than the scanner's inert-downgrade: for custody, a delegate that is `None` today can be re-set tomorrow, and a default state can flip. Fail closed.

> Opinionated note on `Pausable`: the on-chain allowlist relies on the catch-all `UnsupportedExtension` arm for `Pausable` rather than naming it — the Rust variant spelling (`Pausable` vs the JS `PausableConfig`) varies and isn't worth pinning when default-deny already rejects it. You just get the generic error instead of a tailored one. The scanner names it explicitly via `PausableConfig`.

### Proof — [../examples/guard/tests/guard-rejects.test.ts](../examples/guard/tests/guard-rejects.test.ts)

LiteSVM tests build real mints with these extensions and assert `init_vault` fails closed:

```ts
it("rejects a PermanentDelegate mint (issuer could drain the vault)", () => {
  const delegate = Keypair.generate().publicKey;
  const mint = createMint(svm, payer, { decimals: 6, permanentDelegate: delegate });
  const logs = expectFail(svm, [initVaultIx(payer.publicKey, mint)], [payer]);
  expect(logs).toContain("ForbiddenExtension");
});

it("rejects a DefaultAccountState=Frozen mint (deposits would silently fail)", () => {
  const mint = createMint(svm, payer, { decimals: 6, defaultFrozen: true });
  const logs = expectFail(svm, [initVaultIx(payer.publicKey, mint)], [payer]);
  expect(logs).toContain("ForbiddenExtension");
});
```

The mint builders ([../examples/guard/tests/helpers.ts](../examples/guard/tests/helpers.ts)) use the real SPL instructions — `createInitializePermanentDelegateInstruction`, `createInitializeDefaultAccountStateInstruction(mint, AccountState.Frozen, …)` — and a `DefaultAccountState=Frozen` mint *requires* a freeze authority at init, so the frozen-by-default behavior is genuinely reproduced.

---

## How real integrators handle these (precedent)

Industry precedent (production venues that ship Token-2022 support):

| Integrator | Policy on these extensions |
|---|---|
| **Orca Whirlpools** | PermanentDelegate "poses more risks than benefits." Per-config **TokenBadge** PDA allowlist; transfer hooks need public + Verifiable Build. The read-on-chain + allowlist pattern. |
| **Raydium** | Allows TransferFee + Metadata; **blocks PermanentDelegate, TransferHook, and freeze**. SPL freeze authority must be disabled for pools. |
| **Jupiter** | Transfer-tax / T-2022 tokens blocked from Limit & Recurring orders (Instant only). |
| **RugCheck** | PermanentDelegate mass-weaponized; "mint+freeze revoked + LP locked" can STILL rug via delegate burn — check the field independently. |

The throughline: **read the extension fields on-chain and allowlist by policy.** Don't trust classic mint/freeze checks.

---

## DO / DON'T

- **DO** inspect `getPermanentDelegate`, `getDefaultAccountState`, `getPausableConfig` directly — classic `mintAuthority`/`freezeAuthority` being `None` proves nothing.
- **DO** treat `PublicKey.default` (all-zero) as the inert/None sentinel for delegate & pause authority; anything else is a live capability.
- **DO** re-run the extension check on every state-changing instruction, not just at onboarding — authorities can change after you accept a mint.
- **DO** verify deposits by balance delta + `reload()`, never by "the instruction didn't revert" (frozen-default makes silent failures possible).
- **DON'T** assume "mint revoked + freeze revoked + LP locked" means safe. PermanentDelegate is a separate, unrevocable field.
- **DON'T** downgrade `PermanentDelegate`/`DefaultAccountState=Frozen` to ALLOW for custody profiles just because they're inert *right now*.
- **DON'T** call `getPausable` — it doesn't exist in 0.4.14; use `getPausableConfig`.
- **DON'T** assume `ExtensionType::Pausable` compiles in your pinned `spl-token-2022-interface`; rely on default-deny's catch-all to reject it.
