import { describe, it, expect } from "vitest";
import {
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import {
  newSvm,
  fund,
  send,
  createMint,
  createAtaAndMint,
  ata,
  readAccountAmount,
  Keypair,
} from "./helpers.js";

// The reason the guard exists. With NO guard program — just a raw Token-2022
// transfer — the amount credited to the recipient is LESS than the amount sent,
// because the transfer fee is withheld on the recipient side. Any integrator that
// credits shares on the *sent* amount over-issues and becomes insolvent.
describe("footgun: Token-2022 transfer fee breaks naive accounting", () => {
  it("credited != sent (fee is withheld from the recipient)", () => {
    const svm = newSvm();
    const payer = Keypair.generate();
    fund(svm, payer);

    const feeBps = 500; // 5%
    const mint = createMint(svm, payer, {
      decimals: 6,
      transferFee: { bps: feeBps, maxFee: 1_000_000_000n },
    });

    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const aliceAta = createAtaAndMint(svm, payer, mint, alice.publicKey, 1_000_000_000n);
    // Bob needs an ATA to receive into.
    createAtaAndMint(svm, payer, mint, bob.publicKey, 0n);
    const bobAta = ata(mint, bob.publicKey);

    const sent = 100_000_000n;
    send(
      svm,
      [
        createTransferCheckedInstruction(
          aliceAta,
          mint,
          bobAta,
          alice.publicKey,
          sent,
          6,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ],
      [payer, alice],
    );

    const credited = readAccountAmount(svm, bobAta);
    const expectedFee = (sent * BigInt(feeBps)) / 10_000n; // 5_000_000

    // The naive assumption `credited === sent` is FALSE.
    expect(credited).not.toBe(sent);
    // The delta-measured truth:
    expect(credited).toBe(sent - expectedFee); // 95_000_000
  });
});
