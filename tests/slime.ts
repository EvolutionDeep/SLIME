// slime.ts — Unit tests for the SLIME program (happy path + guard rails).
// Requires `anchor build` and a local validator (`anchor localnet` or Docker).
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import type { Slime } from "../target/types/slime";

describe("slime", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Slime as Program<Slime>;
  const authority = provider.wallet as anchor.Wallet;

  const le8 = (n: number | bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const agentPda = (id: number | bigint) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), le8(id)],
      program.programId,
    )[0];
  const strainPda = (root: number | bigint) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("strain"), le8(root)],
      program.programId,
    )[0];

  const caps = { daily: new anchor.BN(100_000), perAgent: new anchor.BN(10_000), perTxn: new anchor.BN(2_000) };
  const genome = { capability: 4500, sizeKb: 1200 };
  const host = { maxSizeKb: 4096, tokRateX100: 39 };
  const notes = Array.from(new Uint8Array(32).fill(7));

  it("initializes config", async () => {
    await program.methods
      .initialize(authority.publicKey, caps, new anchor.BN(300))
      .accounts({ authority: authority.publicKey, config: configPda })
      .rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.isFalse(cfg.breaker);
    assert.equal(cfg.nextAgentId.toNumber(), 1);
    assert.equal(cfg.chronicleSeq.toNumber(), 0);
  });

  it("creates patient zero via genesis", async () => {
    await program.methods
      .genesis(genome, host, notes)
      .accounts({
        authority: authority.publicKey,
        config: configPda,
        agent: agentPda(0),
        strain: strainPda(0),
      })
      .rpc();
    const a = await program.account.agent.fetch(agentPda(0));
    assert.equal(a.generation, 0);
    assert.equal(a.status, "Alive"); // Anchor enum deserializes as { Alive: {} } or string
    const s = await program.account.strain.fetch(strainPda(0));
    assert.equal(s.alive, 1);
    assert.equal(s.population, 1);
    const cfg = await program.account.config.fetch(configPda);
    assert.isAbove(cfg.chronicleSeq.toNumber(), 0);
  });

  it("quarantine toggles status and appends the chronicle", async () => {
    const before = await program.account.config.fetch(configPda);
    await program.methods
      .quarantine(new anchor.BN(0), true)
      .accounts({ authority: authority.publicKey, config: configPda, agent: agentPda(0) })
      .rpc();
    const a = await program.account.agent.fetch(agentPda(0));
    assert.deepEqual(Object.keys(a.status)[0], "quarantined");
    await program.methods
      .quarantine(new anchor.BN(0), false)
      .accounts({ authority: authority.publicKey, config: configPda, agent: agentPda(0) })
      .rpc();
    const after = await program.account.config.fetch(configPda);
    assert.isAbove(after.chronicleSeq.toNumber(), before.chronicleSeq.toNumber());
  });

  it("breaker blocks spawning but not the chronicle", async () => {
    await program.methods
      .setBreaker(true)
      .accounts({ authority: authority.publicKey, config: configPda })
      .rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.isTrue(cfg.breaker);
    await program.methods
      .setBreaker(false)
      .accounts({ authority: authority.publicKey, config: configPda })
      .rpc();
  });
});
