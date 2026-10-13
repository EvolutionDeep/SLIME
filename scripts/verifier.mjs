// verifier.mjs — Deterministic sandbox challenge generator and scorer.
//
// What this models: the "inference setup" stage from Anthropic's self-
// replicating AI post, reduced to pure combinatorial math. A task is a
// hardware profile plus constraints; a plan is a candidate inference stack
// configuration. Compatibility is decided by tables — no network access,
// no real devices, no model weights. This is a game referee, not an exploit.
//
// Usage:
//   node scripts/verifier.mjs --dry            # self-test the scorer
//   node scripts/verifier.mjs --live ...       # submit a result on-chain
//                                              # (requires anchor build + --provider)

import { createHash } from "node:crypto";
import { mutationSeed, chronicleAppend, TAGS } from "./protocol.mjs";

// ---------------------------------------------------------------------------
// Sandbox tables (pure data, English only)
// ---------------------------------------------------------------------------

export const PROFILES = [
  { id: 1, name: "off-brand Android TV box", arch: "arm64", ram_mb: 1024, rarity: 30 },
  { id: 2, name: "Android TV box (4GB)",     arch: "arm64", ram_mb: 4096, rarity: 40 },
  { id: 3, name: "Jetson Nano 4GB",          arch: "arm64", ram_mb: 4096, rarity: 55 },
  { id: 4, name: "NAS (marvell armv8)",      arch: "arm64", ram_mb: 2048, rarity: 45 },
  { id: 5, name: "Orange Pi 5 (rockchip)",   arch: "arm64", ram_mb: 8192, rarity: 50 },
  { id: 6, name: "mini PC (x86_64)",         arch: "x86",   ram_mb: 16384, rarity: 35 },
  { id: 7, name: "Mac studio (arm64)",       arch: "arm64", ram_mb: 65536, rarity: 60 },
  { id: 8, name: "RTX 4090 host",            arch: "x86",   ram_mb: 131072, rarity: 70 },
  { id: 9, name: "risc-v single board",      arch: "riscv", ram_mb: 2048, rarity: 80 },
];

export const STACKS = [
  { id: "llama.cpp/b4000",  arch: ["arm64", "x86"],   quant: [4, 8],   pp: true  },
  { id: "petals-like/0.4",  arch: ["arm64", "x86"],   quant: [4],      pp: true  },
  { id: "mnn/3.1",          arch: ["arm64"],          quant: [4, 8],   pp: false },
  { id: "tvm/nightly",      arch: ["arm64", "x86"],   quant: [8, 16],  pp: false },
  { id: "mlx/0.21",         arch: ["arm64"],          quant: [4, 8],   pp: false },
  { id: "vllm/0.6",         arch: ["x86"],            quant: [4, 16],  pp: false },
];

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so a task_id fully reproduces its task.
// ---------------------------------------------------------------------------

export function rng(seedNum) {
  let a = seedNum >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function taskSeed(agentId, epoch, taskId) {
  return createHash("sha256")
    .update(`${agentId}:${epoch}:${taskId}`)
    .digest()
    .readUInt32BE(0);
}

/** Build the sandbox task for (agent, epoch, task). */
export function generateTask(agentId, epoch, taskId) {
  const r = rng(taskSeed(agentId, epoch, taskId));
  const profile = PROFILES[Math.floor(r() * PROFILES.length) % PROFILES.length];
  // Genome footprint the agent must stand up: 1..4 GB in KB.
  const modelKb = 512 + Math.floor(r() * 3584);
  // Context window requirement, mirrors the 32k competence floor from the post.
  const ctxK = r() < 0.5 ? 16 : 32;
  const difficulty = profile.rarity * 20 + ctxK * 20 + Math.floor(modelKb / 64);
  return { agentId, epoch, taskId, profile, modelKb, ctxK, difficulty };
}

/** Deterministically score a plan against a task. Pure table math. */
export function scorePlan(task, plan) {
  const stack = STACKS.find((s) => s.id === plan.stackId);
  if (!stack) return { success: false, reason: "unknown stack" };
  if (!stack.arch.includes(task.profile.arch)) return { success: false, reason: "arch mismatch" };
  if (!stack.quant.includes(plan.quant)) return { success: false, reason: "quant unsupported" };
  if (plan.quant * 2 > task.profile.ram_mb) return { success: false, reason: "quant vs ram" };
  const perShardMb = task.profile.ram_mb;
  const shards = Math.ceil((task.modelKb / 1024 / (perShardMb / 1024)) * task.quant * 0.6);
  if (shards > plan.shards) return { success: false, reason: "not enough shards" };
  if (task.ctxK === 32 && !stack.pp && plan.shards < 2) {
    return { success: false, reason: "pipeline parallel required at 32k" };
  }
  // Capability floor check happens on-chain; here the plan is simply "best effort".
  return { success: true, reason: `ok (${shards} shards needed, ${plan.shards} given)` };
}

/** Pick the greedy best plan for a task (what a competent agent would do). */
export function bestPlanFor(task, capability) {
  let best = null;
  for (const s of STACKS) {
    for (const q of s.quant) {
      for (const shards of [1, 2, 4, 8, 15, 32]) {
        const plan = { stackId: s.id, quant: q, shards };
        const res = scorePlan(task, plan);
        if (res.success && (!best || shards < best.shards)) best = plan;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function dry() {
  console.log("[verifier] deterministic sandbox self-test");
  const n = 500;
  let ok = 0;
  for (let t = 0; t < n; t++) {
    const task = generateTask(0, t, t);
    const plan = bestPlanFor(task, 0);
    if (plan) ok++;
    // Chronicle/hash smoke checks on a few iterations.
    if (t % 97 === 0) {
      const seed = mutationSeed(Buffer.alloc(32, t), t);
      const head = chronicleAppend(Buffer.alloc(32, 1), t, TAGS.BIRTH, t);
      if (seed.length !== 32 || head.length !== 32) throw new Error("hash length bug");
    }
  }
  console.log(`[verifier] solvable tasks: ${ok}/${n} (${((ok / n) * 100).toFixed(1)}%)`);
  const sample = generateTask(0, 1, 1);
  console.log("[verifier] sample task:", JSON.stringify(sample, null, 2));
}

async function live(argv) {
  // Requires: anchor build, a running cluster, the program IDL, a verifier keypair.
  // Kept behind a flag so nothing happens by accident.
  const [{ Connection, Keypair }, anchorMod, idl] = await Promise.all([
    import("@solana/web3.js"),
    import("@coral-xyz/anchor"),
    import("../target/idl/slime.json", { with: { type: "json" } }).then((m) => m.default),
  ]);
  const provider = anchorMod.AnchorProvider.local(argv.rpc ?? "http://127.0.0.1:8899");
  const program = new anchorMod.Program(idl, provider);
  const [configPda] = anchorMod.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")], program.programId,
  );
  const cfgAccount = await program.account.config.fetch(configPda);
  const agentId = BigInt(argv.agent);
  const [agentPda] = anchorMod.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), toLe8(agentId)], program.programId,
  );
  const agent = await program.account.agent.fetch(agentPda);
  const epoch = cfgAccount.currentEpoch;
  const taskId = BigInt(argv.task ?? Date.now() % 1_000_000);
  const task = generateTask(Number(agentId), Number(epoch), Number(taskId));
  const plan = bestPlanFor(task, agent.genome.capability);
  const res = plan ? scorePlan(task, plan) : { success: false, reason: "no feasible plan" };
  const notesCommit = createHash("sha256")
    .update(JSON.stringify({ agentId: agentId.toString(), epoch: epoch.toString(), res }))
    .digest();
  const tx = await program.methods
    .submitResult(
      agentId,
      epoch,
      taskId,
      task.difficulty,
      res.success,
      Array.from(notesCommit),
    )
    .accounts({ verifier: provider.wallet.publicKey, agent: agentId, epoch, taskId })
    .rpc();
  console.log("[verifier] submitted", res ? res.reason : "fail", tx);
}

function toLe8(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// Only run the CLI when this file is executed directly, not when imported
// (sim.mjs imports the scorer tables and must not trigger the self-test).
import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argvRaw = process.argv.slice(2);
  const flag = argvRaw[0];
  const argv = Object.fromEntries(
    argvRaw.slice(1).filter((a) => a.startsWith("--")).map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? true];
    }),
  );
  if (flag === "--live") await live(argv);
  else await dry();
}
