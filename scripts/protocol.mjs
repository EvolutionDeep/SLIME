// protocol.mjs — Off-chain mirror of the SLIME on-chain math.
// Every function here is a 1:1 port of programs/slime/src/lib.rs so the
// verifier and the simulator stay bit-compatible with the program.
// All comments in English by project convention.

import { createHash } from "node:crypto";

export const DAY_SLOTS = 432_000n;
export const MAX_DRIFT_PCT = 5;
export const WIN_BUMP = 400;
export const LOSE_CUT = 150;
export const GENESIS_ENERGY = 100n;
export const HATCH_ENERGY = 10n;
export const NO_PARENT = 0xffffffffffffffffn;

// Value-layer constants (mirrors lib.rs): fees accrue to the vault ledger.
// NOTE: the program is token-agnostic by design — the protocol never mints
// or holds a tradable token; credits are an internal ledger. Community
// token issuance happens externally (pump.fun), outside this program.
export const PROPOSAL_FEE = 500;
export const FOSSIL_FEE = 1000;
export const VOTE_QUORUM = 5000;      // per-mille weight units
export const RELAX_MAX_PCT = 25;      // max cap loosening per passed vote
export const GRANT_MAX_DIVISOR = 10n; // grant <= gross/10
export const FOSSIL_MIN_WINS = 10;
export const FOSSIL_MIN_GEN = 5;

// Keeper economy (value layer 4) — mirrors the Rust constants. The program
// still never mints: it only recognizes one externally launched token.
export const TOKEN_UNIT = 1_000_000;          // 6 decimals (pump.fun convention)
export const FEED_MIN_TOKENS = 1;
export const FEED_ENERGY_CAP = 50;            // 1 whole token = 1 energy, capped
export const MEAL_BURN_TOKENS = 200;          // burn prices for interventions
export const APPEAL_BURN_TOKENS = 500;
export const POTION_BURN_TOKENS = 1_000;
export const ACCELERATE_BURN_TOKENS = 300;
export const MEAL_ENERGY = 50;
export const POTION_DRIFT_PCT = 25;           // potion widens drift one birth
export const BET_MIN_TOKENS = 10;             // R0 over/under staking floor
export const HOLDER_QUORUM_TOKENS = 50_000;   // lower chamber quorum
export const FOSSIL_MIN_TOKENS = 100;         // holder gate once token is live

/** Credit price of a spawn (integer floor divisions, matching Rust). */
export function spawnCost(sizeKb, capability) {
  return 100 + Math.trunc((50 * sizeKb) / 512) + Math.trunc((100 * capability) / 50);
}

/** Bounded +/-driftPct mutation seeded by sha256(seed) (potion can widen). */
export function mutate(genome, seed, driftPct = MAX_DRIFT_PCT) {
  const d = createHash("sha256").update(seed).digest();
  const apply = (v, k) => {
    const pct = (d[k] % (driftPct * 2 + 1)) - driftPct;
    return Math.max(1, Math.trunc((v * (100 + pct)) / 100));
  };
  return { capability: apply(genome.capability, 0), size_kb: apply(genome.size_kb, 1) };
}

/** Mutation seed = sha256(chronicle_head || le64(agent_id)). */
export function mutationSeed(headBytes, agentId) {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(BigInt(agentId));
  return createHash("sha256").update(Buffer.concat([Buffer.from(headBytes), id])).digest();
}

/** Gestation in epochs, clamped to [1, 64]. */
export function gestationEpochs(sizeKb, tokRateX100) {
  const rate = Math.max(1, tokRateX100);
  return Math.min(64, Math.max(1, Math.ceil(sizeKb / rate)));
}

/** Append to the chronicle hash chain: sha256(head || seq_le64 || tag || payload_le64). */
export function chronicleAppend(headBytes, seq, tag, payload) {
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64LE(BigInt(seq));
  const pay = Buffer.alloc(8);
  pay.writeBigUInt64LE(BigInt(payload));
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from(headBytes), seqBuf, Buffer.from([tag]), pay]))
    .digest();
}

export const TAGS = {
  GENESIS: 1,
  BIRTH: 2,
  EPOCH: 3,
  DEATH: 4,
  QUARANTINE: 5,
  RELEASE: 6,
  PROPOSAL: 7,
  FOSSIL: 8,
  GRANT: 9,
};
