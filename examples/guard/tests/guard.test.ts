import { describe, it, expect } from "vitest";
import {
  newSvm,
  loadGuard,
  fund,
  send,
  createMint,
  createAtaAndMint,
  ata,
  vaultPda,
  positionPda,
  initVaultIx,
  openPositionIx,
  depositIx,
  withdrawIx,
  readAccountAmount,
  readPositionDeposited,
  Keypair,
} from "./helpers.js";

describe("guard: safe consumption of a Token-2022 mint", () => {
  it("clean mint: deposit + withdraw keep exact accounting", () => {
    const svm = newSvm();
    loadGuard(svm);
    const payer = Keypair.generate();
    fund(svm, payer);

    const mint = createMint(svm, payer, { decimals: 6 }); // no extensions
    send(svm, [initVaultIx(payer.publicKey, mint)], [payer]);

    const user = Keypair.generate();
    fund(svm, user);
    createAtaAndMint(svm, payer, mint, user.publicKey, 1_000_000n);
    send(svm, [openPositionIx(user.publicKey, mint)], [user]);

    send(svm, [depositIx(user.publicKey, mint, 1_000_000n)], [user]);

    const [vault] = vaultPda(mint);
    const [position] = positionPda(vault, user.publicKey);
    expect(readPositionDeposited(svm, position)).toBe(1_000_000n);
    expect(readAccountAmount(svm, ata(mint, vault))).toBe(1_000_000n);

    send(svm, [withdrawIx(user.publicKey, mint, 400_000n)], [user]);
    expect(readPositionDeposited(svm, position)).toBe(600_000n);
    expect(readAccountAmount(svm, ata(mint, vault))).toBe(600_000n);
    expect(readAccountAmount(svm, ata(mint, user.publicKey))).toBe(400_000n);
  });

  it("transfer-fee mint: credits the RECEIVED amount, not the requested amount", () => {
    const svm = newSvm();
    loadGuard(svm);
    const payer = Keypair.generate();
    fund(svm, payer);

    const feeBps = 500; // 5%
    const mint = createMint(svm, payer, {
      decimals: 6,
      transferFee: { bps: feeBps, maxFee: 1_000_000_000n },
    });
    send(svm, [initVaultIx(payer.publicKey, mint)], [payer]); // fee is ALLOWED (handled)

    const user = Keypair.generate();
    fund(svm, user);
    createAtaAndMint(svm, payer, mint, user.publicKey, 1_000_000_000n);
    send(svm, [openPositionIx(user.publicKey, mint)], [user]);

    const requested = 100_000_000n;
    send(svm, [depositIx(user.publicKey, mint, requested)], [user]);

    const fee = (requested * BigInt(feeBps)) / 10_000n; // 5_000_000
    const received = requested - fee; // 95_000_000

    const [vault] = vaultPda(mint);
    const [position] = positionPda(vault, user.publicKey);
    // The guard credits what actually arrived, NOT the 100_000_000 requested.
    expect(readPositionDeposited(svm, position)).toBe(received);
    expect(readPositionDeposited(svm, position)).not.toBe(requested);
    expect(readAccountAmount(svm, ata(mint, vault))).toBe(received);
  });
});
