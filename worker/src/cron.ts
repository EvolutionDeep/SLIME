// cron.ts — Heartbeat worker driven by Cloudflare Cron Triggers.
//
// Responsibilities (mirrors the murmu​r/GOOD6 worker pattern):
//   1. Compute the current epoch from the slot clock.
//   2. tick_agent for every due, non-dead agent (bounded per invocation).
//   3. advance_epoch once when the epoch boundary is crossed.
//   4. Stay a no-op when VERIFIER_KEY is absent (safe-by-default deploys).
//
// Cost guards (lessons from the 2026-10-01 chronicle freeze):
//   - hard wall-clock deadline for the whole run;
//   - hard cap on transactions sent per invocation;
//   - every RPC read is awaited with its own timeout so one hung call
//     cannot starve the tick loop.

import {
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { SlimeChain } from "./rpc";
import { discriminator, le8, concatBytes, type AgentView } from "./decode";

const MAX_TX_PER_RUN = 12;          // send at most this many txs per cron fire
const RUN_DEADLINE_MS = 25_000;     // wall-clock budget for the whole run
const RPC_TIMEOUT_MS = 8_000;       // per-RPC-call guard

export interface CronResult {
  skipped: string | null;
  ticks: number;
  epochAdvanced: boolean;
  errors: string[];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout: ${label}`)), ms),
    ),
  ]);
}

async function ixData(name: string, args: Uint8Array[] = []): Promise<Buffer> {
  const disc = await discriminator("global", name);
  return Buffer.from(concatBytes([disc, ...args]));
}

export async function runCron(
  env: { RPC_URL: string; PROGRAM_ID: string; VERIFIER_KEY?: string },
): Promise<CronResult> {
  const result: CronResult = { skipped: null, ticks: 0, epochAdvanced: false, errors: [] };
  if (!env.VERIFIER_KEY) {
    result.skipped = "VERIFIER_KEY not configured: cron is a no-op";
    return result;
  }

  const chain = new SlimeChain(env.RPC_URL, env.PROGRAM_ID);
  const started = Date.now();
  const budgetLeft = () => started + RUN_DEADLINE_MS - Date.now();

  const cfg = await withTimeout(chain.fetchConfig(), RPC_TIMEOUT_MS, "fetchConfig");
  if (!cfg) {
    result.skipped = "config account missing (program not initialized/deployed)";
    return result;
  }

  const slot = await withTimeout(chain.conn.getSlot(), RPC_TIMEOUT_MS, "getSlot");
  const epoch = Math.floor(slot / cfg.epochLenSlots);

  const verifier = Keypair.fromSecretKey(bs58ToBytes(env.VERIFIER_KEY));
  let sent = 0;

  // 1) tick_agent for due agents (eggs hatch, metabolism burns, dead die).
  const agents: AgentView[] = await withTimeout(
    chain.fetchAgents(50),
    RPC_TIMEOUT_MS,
    "fetchAgents",
  );
  for (const a of agents) {
    if (sent >= MAX_TX_PER_RUN || budgetLeft() < 3_000) break;
    if (a.status === "Dead" || a.lastTickEpoch >= epoch) continue;

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: verifier.publicKey, isSigner: true, isWritable: true },
        { pubkey: chain.configPda(), isSigner: false, isWritable: false },
        { pubkey: chain.agentPda(a.id), isSigner: false, isWritable: true },
        {
          pubkey: chain.strainPda(a.strainRoot),
          isSigner: false,
          isWritable: true,
        },
      ],
      programId: chain.pid,
      data: await ixData("tick_agent", [le8(a.id)]),
    });
    try {
      await send(chain, verifier, ix);
      result.ticks += 1;
      sent += 1;
    } catch (e) {
      result.errors.push(`tick ${a.id}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 2) advance_epoch once per boundary (single strain root 0 in MVP).
  if (epoch > cfg.currentEpoch && sent < MAX_TX_PER_RUN && budgetLeft() > 3_000) {
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: verifier.publicKey, isSigner: true, isWritable: true },
        { pubkey: chain.configPda(), isSigner: false, isWritable: true },
        { pubkey: chain.strainPda(0), isSigner: false, isWritable: true },
      ],
      programId: chain.pid,
      data: await ixData("advance_epoch"),
    });
    try {
      await send(chain, verifier, ix);
      result.epochAdvanced = true;
    } catch (e) {
      result.errors.push(`advance_epoch: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  return result;
}

async function send(
  chain: SlimeChain,
  signer: Keypair,
  ix: TransactionInstruction,
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await chain.conn.getLatestBlockhash()).blockhash;
  tx.sign(signer);
  return chain.conn.sendRawTransaction(await tx.serialize(), {
    skipPreflight: false,
  });
}

/** Base58 decode (no dependency; used only for the verifier secret key). */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58ToBytes(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = BigInt(B58.indexOf(ch));
    if (i < 0n) throw new Error("bad base58 char");
    n = n * 58n + i;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}
