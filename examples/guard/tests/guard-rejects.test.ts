import { describe, it, expect } from "vitest";
import {
  newSvm,
  loadGuard,
  fund,
  expectFail,
  createMint,
  initVaultIx,
  Keypair,
} from "./helpers.js";

// The guard fails CLOSED: a mint carrying a custody-dangerous extension is
// rejected at init_vault, so the unsafe token can never be deposited.
describe("guard: rejects custody-dangerous mints at init", () => {
  it("rejects a PermanentDelegate mint (issuer could drain the vault)", () => {
    const svm = newSvm();
    loadGuard(svm);
    const payer = Keypair.generate();
    fund(svm, payer);

    const delegate = Keypair.generate().publicKey;
    const mint = createMint(svm, payer, { decimals: 6, permanentDelegate: delegate });

    const logs = expectFail(svm, [initVaultIx(payer.publicKey, mint)], [payer]);
    expect(logs).toContain("ForbiddenExtension");
  });

  it("rejects a DefaultAccountState=Frozen mint (deposits would silently fail)", () => {
    const svm = newSvm();
    loadGuard(svm);
    const payer = Keypair.generate();
    fund(svm, payer);

    const mint = createMint(svm, payer, { decimals: 6, defaultFrozen: true });

    const logs = expectFail(svm, [initVaultIx(payer.publicKey, mint)], [payer]);
    expect(logs).toContain("ForbiddenExtension");
  });

  it("rejects a TransferHook mint (arbitrary CPI / reentrancy on every transfer)", () => {
    const svm = newSvm();
    loadGuard(svm);
    const payer = Keypair.generate();
    fund(svm, payer);

    const hookProgram = Keypair.generate().publicKey;
    const mint = createMint(svm, payer, { decimals: 6, transferHook: hookProgram });

    const logs = expectFail(svm, [initVaultIx(payer.publicKey, mint)], [payer]);
    expect(logs).toContain("ForbiddenExtension");
  });
});
