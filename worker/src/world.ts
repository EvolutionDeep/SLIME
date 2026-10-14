// world.ts — the ONE shared world every visitor sees.
//
// Design: time is the single source of truth. The colony state at any
// moment is f(seed, epochCount) — the engine is fully deterministic, so any
// Worker isolate that catches up to the same clock lands on the same world.
// KV stores only the genesis meta + a resumable snapshot (a cache, not a
// dependency: lose it and the world rebuilds itself from seed + time).
//
// Player actions (claims, feeds) live in a thin intervention layer merged
// into the view at render time — they never fork the simulation. When the
// Anchor program goes live on devnet this layer retires into the chain.
//
// All comments in English by project convention.

import { Colony, DEFAULT_CFG, STATUS } from "./engine.js";

/** One epoch of world-time, shared by every visitor. */
export const EPOCH_SECONDS = 20;

const SNAP_KEY = "snap";
const META_KEY = "meta";
const CLAIMS_KEY = "claims";
const FEEDS_KEY = "feeds";
const PIT_KEY = "pit";
const FOSSILS_KEY = "fossils";
const RESEARCH_KEY = "research";
const CHRONICLE_KEEP = 80;
const FEEDS_KEEP = 2000;
const FOSSILS_KEEP = 24;
const CATCHUP_CAP = 400; // max ticks computed in one request

// ---------------------------------------------------------------------------
// The Pit: guardians run their claimed slimes through hardware challenges
// straight out of the paper — capability floor (tier difficulty), Lamarckian
// notes (each win grows the notebook AND the genome), the learning curve
// (repeat exposure to a tier raises odds, the post's 45% -> 61-84%), and the
// size ceiling (a bloated notebook bursts the host: permanent death).
// ---------------------------------------------------------------------------

export const TIERS = [
  { name: "SCOUT", diff: 1500, cap: 20, gain: 120, win: 12, loss: 15 },
  { name: "RAID", diff: 1900, cap: 40, gain: 240, win: 24, loss: 30 },
  { name: "STRONGHOLD", diff: 2400, cap: 60, gain: 360, win: 36, loss: 45 },
];
const HOST_CAP_KB = 4096;   // cfg.host.max_size_kb: the genome's coffin size
const LOGISTIC_TEMP = 150;  // same solver temperature as the wild engine
const FAMILIARITY_PER_WIN = 40;
const FAMILIARITY_MAX = 300;

// ---------------------------------------------------------------------------
// Volunteer compute: every visitor can lend their device's CPU to a shared
// research effort. Each epoch the world poses a deterministic proof-of-work
// challenge derived from (seed, epoch); browsers grind a nonce in a Web Worker
// and submit it. The Worker verifies in O(1) (recompute the same hash), dedupes
// nonces and caps credit per device so no single machine can solo the bar. When
// the shared meter fills, the whole colony gets a breakthrough energy glow —
// a view-time overlay, exactly like feeds, so it never forks the sim.
// ---------------------------------------------------------------------------

const RESEARCH_GOAL = 24;          // valid solutions to trigger a breakthrough
const POW_DIFFICULTY = 21;         // leading-zero bits the browser must grind
const BOON_ENERGY = 15;            // energy granted to every alive slime
const BOON_WINDOW = 1;             // epochs the breakthrough glow persists
const MAX_CREDIT_PER_SESSION = 6;  // one device can't carry the whole colony

interface Research {
  epoch: number;
  progress: number;
  breakthroughs: number;   // cumulative, survives epoch rollover
  lastBoonEpoch: number;   // -1 until the first breakthrough
  usedNonces: number[];    // dedupe within the epoch (bounded by goal)
  credited: Record<string, number>; // sessionId -> solutions this epoch
}

interface PitStats {
  cap: number;        // taming capability bonus (permanent)
  wins: number;
  losses: number;
  streak: number;
  best: number;       // best streak — the trophy number
  sizeGain: number;   // KB of notes grown toward the host ceiling
  tierWins: number[]; // familiarity per tier — the learning curve, earned
  energy: number;     // accumulated energy delta from trials
  lastEpoch: number;  // one trial per slime per epoch
  trials: number;     // nonce for the deterministic roll
}

interface Fossil {
  agent: number; gen: number; guardian: string;
  cap: number; wins: number; losses: number; best: number;
  sizeKb: number; cause: string; epoch: number; t: number;
}


export interface WorldEnv {
  WORLD?: KVNamespace;
}

interface Meta {
  t0: number;   // genesis wall-clock (ms)
  seed: number;
}

interface LogEvent {
  i: number;
  epoch: number;
  type: string;
  agent?: number;
  from?: number;
  gen?: number;
  n?: number; // aggregated count for cap-blocked floods
  ok?: boolean; // pit trial outcome
  diff?: number; // pit tier difficulty
}

interface Snap {
  colony: ReturnType<Colony["snapshot"]>;
  log: LogEvent[];
  logSeq: number;
}

interface Claim { a: string; t: number }
interface Claims { [agentId: string]: Claim }
interface Feed { agent: number; a: string; epoch: number; t: number }

// ---------------------------------------------------------------------------
// Intra-isolate cache: KV is eventually consistent and slow; the deterministic
// engine means one catch-up per isolate is harmless duplication, not a fork.
// ---------------------------------------------------------------------------

const mem = new Map<string, { snap: Snap; meta: Meta; colony: Colony; at: number }>();

function targetEpoch(meta: Meta, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - meta.t0) / 1000 / EPOCH_SECONDS));
}

/** Chronicle-worthy events only: births, hatchings, deaths, sweeps. */
function worthLogging(ev: { type: string }): boolean {
  return ev.type === "birth" || ev.type === "hatch" ||
    ev.type === "death" || ev.type === "quarantine";
}

async function loadMeta(env: WorldEnv, now: number): Promise<Meta> {
  const cached = mem.get(META_KEY);
  if (cached) return cached.meta;
  if (env.WORLD) {
    const raw = await env.WORLD.get(META_KEY);
    if (raw) {
      const meta = JSON.parse(raw) as Meta;
      mem.set(META_KEY, { snap: null as never, meta, colony: null as never, at: 0 });
      return meta;
    }
  }
  // Fresh genesis: this isolate just invented the world — publish it.
  const meta: Meta = { t0: now, seed: DEFAULT_CFG.seed };
  if (env.WORLD) await env.WORLD.put(META_KEY, JSON.stringify(meta));
  mem.set(META_KEY, { snap: null as never, meta, colony: null as never, at: 0 });
  return meta;
}

/** Advance the authoritative colony to the shared clock; persist the result. */
export async function getWorld(env: WorldEnv): Promise<{ colony: Colony; snap: Snap; meta: Meta }> {
  const now = Date.now();
  const meta = await loadMeta(env, now);
  const want = targetEpoch(meta, now);

  const hit = mem.get(SNAP_KEY);
  if (hit && hit.colony && hit.colony.epoch >= want) {
    return { colony: hit.colony, snap: hit.snap, meta };
  }

  let snap: Snap | null = null;
  if (env.WORLD) {
    const raw = await env.WORLD.get(SNAP_KEY);
    if (raw) snap = JSON.parse(raw) as Snap;
  }
  if (!snap || snap.colony.epoch > want) {
    // No snapshot (or a clock-skewed one): rebuild deterministically from seed.
    const colony = new Colony({ ...DEFAULT_CFG, seed: meta.seed });
    snap = { colony: colony.snapshot(), log: [], logSeq: 0 };
  }
  let colony = Colony.restore({ ...DEFAULT_CFG, seed: meta.seed }, snap.colony);

  const steps = Math.min(want - colony.epoch, CATCHUP_CAP);
  for (let k = 0; k < steps; k++) {
    const events = colony.tick();
    let blocked = 0;
    for (const ev of events) {
      if (ev.type === "cap-blocked") { blocked++; continue; }
      if (!worthLogging(ev)) continue;
      snap.log.push({
        i: snap.logSeq++, epoch: colony.epoch, type: ev.type,
        agent: (ev as { agent?: number }).agent,
        from: (ev as { from?: number }).from,
        gen: (ev as { gen?: number }).gen,
      });
    }
    if (blocked > 0) {
      snap.log.push({ i: snap.logSeq++, epoch: colony.epoch, type: "cap-blocked", n: blocked });
    }
    if (snap.log.length > CHRONICLE_KEEP) snap.log.splice(0, snap.log.length - CHRONICLE_KEEP);
  }
  snap.colony = colony.snapshot();
  mem.set(SNAP_KEY, { snap, meta, colony, at: now });
  if (env.WORLD) {
    await env.WORLD.put(SNAP_KEY, JSON.stringify(snap));
  }
  return { colony, snap, meta };
}

// ---------------------------------------------------------------------------
// Intervention layer: claims + feeds (KV-backed, pre-chain registry).
// ---------------------------------------------------------------------------

async function readJson<T>(env: WorldEnv, key: string, fallback: T): Promise<T> {
  if (!env.WORLD) return fallback;
  const raw = await env.WORLD.get(key);
  return raw ? (JSON.parse(raw) as T) : fallback;
}

export async function getClaims(env: WorldEnv): Promise<Claims> {
  return readJson<Claims>(env, CLAIMS_KEY, {});
}

export async function claimAgent(
  env: WorldEnv, address: string, agentId: number,
): Promise<{ ok: boolean; error?: string }> {
  const claims = await getClaims(env);
  const key = String(agentId);
  if (claims[key]) return { ok: false, error: `already claimed by ${claims[key].a.slice(0, 4)}…${claims[key].a.slice(-4)}` };
  claims[key] = { a: address, t: Date.now() };
  if (env.WORLD) await env.WORLD.put(CLAIMS_KEY, JSON.stringify(claims));
  return { ok: true };
}

export async function feedAgent(
  env: WorldEnv, address: string, agentId: number, epoch: number,
): Promise<{ ok: boolean; error?: string }> {
  const claims = await getClaims(env);
  const c = claims[String(agentId)];
  if (!c) return { ok: false, error: "unclaimed slimes cannot be fed — claim it first" };
  if (c.a !== address) return { ok: false, error: "only its guardian can feed this slime" };
  const feeds = await readJson<Feed[]>(env, FEEDS_KEY, []);
  if (feeds.some((f) => f.agent === agentId && f.epoch === epoch)) {
    return { ok: false, error: "already fed this epoch — it digests slowly" };
  }
  feeds.push({ agent: agentId, a: address, epoch, t: Date.now() });
  if (feeds.length > FEEDS_KEEP) feeds.splice(0, feeds.length - FEEDS_KEEP);
  if (env.WORLD) await env.WORLD.put(FEEDS_KEY, JSON.stringify(feeds));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The Pit: trial rolls, bursting, fossilization.
// ---------------------------------------------------------------------------

/** Server-side deterministic roll: same (seed, slime, epoch, nonce) = same fate. */
function roll(seed: number, agentId: number, epoch: number, nonce: number): number {
  let h = Math.imul(seed >>> 0, 2654435761) ^ Math.imul(agentId + 1, 40503)
    ^ Math.imul(epoch + 7, 2246822519) ^ Math.imul(nonce + 13, 3266489917);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Win odds a guardian faces — shown in the UI before committing, rolled after. */
export function trialOdds(agent: { genome: { capability: number }; notesDepth: number },
  pit: PitStats, tierIdx: number): number {
  const t = TIERS[tierIdx];
  const fam = Math.min(FAMILIARITY_MAX, (pit?.tierWins?.[tierIdx] ?? 0) * FAMILIARITY_PER_WIN);
  const wild = Math.min(600, agent.notesDepth * 60); // engine familiarity
  const eff = agent.genome.capability + wild + (pit?.cap ?? 0) + fam;
  return 1 / (1 + Math.exp(-(eff - t.diff) / LOGISTIC_TEMP));
}

const emptyPit = (): PitStats => ({
  cap: 0, wins: 0, losses: 0, streak: 0, best: 0, sizeGain: 0,
  tierWins: [0, 0, 0], energy: 0, lastEpoch: -1, trials: 0,
});

async function fossilize(
  env: WorldEnv, claims: Claims, fossils: Fossil[], pits: Record<string, PitStats>,
  agentId: number, cause: string, gen: number, cap: number, sizeKb: number, epoch: number,
): Promise<void> {
  const p = pits[String(agentId)];
  fossils.push({
    agent: agentId, gen, guardian: claims[String(agentId)]?.a ?? "wild",
    cap: cap + (p?.cap ?? 0), wins: p?.wins ?? 0, losses: p?.losses ?? 0,
    best: p?.best ?? 0, sizeKb, cause, epoch, t: Date.now(),
  });
  if (fossils.length > FOSSILS_KEEP) fossils.splice(0, fossils.length - FOSSILS_KEEP);
  delete claims[String(agentId)];
  if (pits) delete pits[String(agentId)];
  if (env.WORLD) {
    await env.WORLD.put(FOSSILS_KEY, JSON.stringify(fossils));
    await env.WORLD.put(CLAIMS_KEY, JSON.stringify(claims));
    await env.WORLD.put(PIT_KEY, JSON.stringify(pits));
  }
}

export async function trialAgent(
  env: WorldEnv, address: string, agentId: number, tierIdx: number,
): Promise<{
  ok: boolean; error?: string; success?: boolean; p?: number;
  pit?: PitStats; burst?: boolean; energyDelta?: number;
}> {
  if (!(tierIdx >= 0 && tierIdx < TIERS.length)) return { ok: false, error: "unknown tier" };
  const claims = await getClaims(env);
  const c = claims[String(agentId)];
  if (!c) return { ok: false, error: "only a guardian can run a slime in the pit" };
  if (c.a !== address) return { ok: false, error: "this slime belongs to someone else" };

  const { colony, snap, meta } = await getWorld(env);
  const a = colony.agents.get(agentId);
  if (!a || a.status !== STATUS.Alive) return { ok: false, error: "your slime is not alive to fight" };

  const pits = await readJson<Record<string, PitStats>>(env, PIT_KEY, {});
  const pit = pits[String(agentId)] ?? emptyPit();
  if (pit.lastEpoch === colony.epoch) {
    return { ok: false, error: "already fought this epoch — the notebook needs time to dry" };
  }
  pit.lastEpoch = colony.epoch;
  pit.trials++;

  const t = TIERS[tierIdx];
  const p = trialOdds(a, pit, tierIdx);
  const success = roll(meta.seed, agentId, colony.epoch, pit.trials) < p;
  let energyDelta: number;
  let burst = false;
  if (success) {
    pit.cap += t.cap;
    pit.sizeGain += t.gain;
    pit.wins++;
    pit.streak++;
    pit.best = Math.max(pit.best, pit.streak);
    pit.tierWins[tierIdx]++;
    pit.energy += t.win;
    energyDelta = t.win;
  } else {
    pit.losses++;
    pit.streak = 0;
    pit.energy -= t.loss;
    energyDelta = -t.loss;
  }
  // The paper's ceiling, made lethal: notes past the host coffin burst the slime.
  const totalSize = a.genome.size_kb + pit.sizeGain;
  burst = totalSize >= HOST_CAP_KB;

  pits[String(agentId)] = pit;
  if (env.WORLD) await env.WORLD.put(PIT_KEY, JSON.stringify(pits));

  snap.log.push({
    i: snap.logSeq++, epoch: colony.epoch,
    type: burst ? "burst" : "trial", agent: agentId, diff: t.diff, ok: success,
  });
  if (snap.log.length > CHRONICLE_KEEP) snap.log.splice(0, snap.log.length - CHRONICLE_KEEP);
  snap.colony = colony.snapshot();
  if (env.WORLD) await env.WORLD.put(SNAP_KEY, JSON.stringify(snap));

  if (burst) {
    const fossils = await readJson<Fossil[]>(env, FOSSILS_KEY, []);
    await fossilize(env, claims, fossils, pits, agentId, "notebook burst",
      a.gen, a.genome.capability, totalSize, colony.epoch);
  }
  return { ok: true, success, p, pit, burst, energyDelta };
}

// ---------------------------------------------------------------------------
// Volunteer compute: proof-of-work verification + the shared research meter.
// powHash is mirrored verbatim in public/js/pow-worker.js — the browser grinds
// against the SAME function the Worker checks, so a solution is real work that
// costs nothing to verify.
// ---------------------------------------------------------------------------

export function powHash(a: number, b: number): number {
  let h = Math.imul(a >>> 0, 2654435761) ^ Math.imul(b >>> 0, 40503);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return h >>> 0;
}

/** True when h has at least d leading zero bits. */
const powOk = (h: number, d: number): boolean => (h >>> (32 - d)) === 0;

/** The whole world shares one challenge per epoch: f(seed, epoch). */
const epochChallenge = (seed: number, epoch: number): number => powHash(seed, epoch + 1);

const emptyResearch = (epoch: number): Research => ({
  epoch, progress: 0, breakthroughs: 0, lastBoonEpoch: -1, usedNonces: [], credited: {},
});

/** Load the epoch's research state, rolling counters forward on a new epoch. */
async function loadResearch(env: WorldEnv, epoch: number): Promise<{ r: Research; fresh: boolean }> {
  const stored = await readJson<Research | null>(env, RESEARCH_KEY, null);
  if (!stored || stored.epoch !== epoch) {
    const r = emptyResearch(epoch);
    if (stored) { r.breakthroughs = stored.breakthroughs ?? 0; r.lastBoonEpoch = stored.lastBoonEpoch ?? -1; }
    return { r, fresh: true };
  }
  return { r: stored, fresh: false };
}

/** Read-only research view for the dashboard (persists only the rollover). */
async function researchView(env: WorldEnv, seed: number, epoch: number) {
  const { r, fresh } = await loadResearch(env, epoch);
  if (fresh && env.WORLD) await env.WORLD.put(RESEARCH_KEY, JSON.stringify(r));
  const boonActive = r.lastBoonEpoch >= 0 && epoch - r.lastBoonEpoch <= BOON_WINDOW;
  return {
    boonActive,
    block: {
      epoch, progress: r.progress, goal: RESEARCH_GOAL,
      breakthroughs: r.breakthroughs, contributors: Object.keys(r.credited).length,
      difficulty: POW_DIFFICULTY, challenge: epochChallenge(seed, epoch),
      perDeviceCap: MAX_CREDIT_PER_SESSION, boonActive, boonEnergy: BOON_ENERGY,
    },
  };
}

export async function contribute(
  env: WorldEnv, proof: { challenge?: number; nonce?: number; sessionId?: string },
): Promise<{
  ok: boolean; error?: string; progress?: number; goal?: number;
  boon?: boolean; credited?: number;
}> {
  const { colony, snap, meta } = await getWorld(env);
  const epoch = colony.epoch;
  const sid = String(proof.sessionId ?? "").trim().slice(0, 64);
  if (!sid) return { ok: false, error: "sessionId required" };
  const ch = Number(proof.challenge) >>> 0;
  const nonce = Number(proof.nonce) >>> 0;
  if (ch !== epochChallenge(meta.seed, epoch)) {
    return { ok: false, error: "stale challenge — the epoch rolled, grab a new one" };
  }
  if (!powOk(powHash(ch, nonce), POW_DIFFICULTY)) {
    return { ok: false, error: "invalid proof of work" };
  }
  const { r } = await loadResearch(env, epoch);
  if (r.usedNonces.includes(nonce)) {
    return { ok: false, error: "nonce already counted", progress: r.progress, goal: RESEARCH_GOAL };
  }
  if ((r.credited[sid] ?? 0) >= MAX_CREDIT_PER_SESSION) {
    return { ok: false, error: "device limit reached this epoch — let others help", progress: r.progress, goal: RESEARCH_GOAL };
  }
  r.usedNonces.push(nonce);
  r.credited[sid] = (r.credited[sid] ?? 0) + 1;
  if (r.progress < RESEARCH_GOAL) r.progress++;

  let boon = false;
  if (r.progress >= RESEARCH_GOAL && r.lastBoonEpoch !== epoch) {
    boon = true;
    r.breakthroughs++;
    r.lastBoonEpoch = epoch;
    // A chronicle-worthy moment: the crowd's compute fed the whole colony.
    snap.log.push({ i: snap.logSeq++, epoch, type: "breakthrough", n: r.progress });
    if (snap.log.length > CHRONICLE_KEEP) snap.log.splice(0, snap.log.length - CHRONICLE_KEEP);
    snap.colony = colony.snapshot();
    if (env.WORLD) await env.WORLD.put(SNAP_KEY, JSON.stringify(snap));
  }
  if (env.WORLD) await env.WORLD.put(RESEARCH_KEY, JSON.stringify(r));
  return { ok: true, progress: r.progress, goal: RESEARCH_GOAL, boon, credited: r.credited[sid] };
}

// ---------------------------------------------------------------------------
// View: the JSON the whole world renders from.
// ---------------------------------------------------------------------------

export async function worldView(env: WorldEnv, since = -1) {
  const now = Date.now();
  const { colony, snap, meta } = await getWorld(env);
  const claims = await getClaims(env);
  const feeds = await readJson<Feed[]>(env, FEEDS_KEY, []);
  const pits = await readJson<Record<string, PitStats>>(env, PIT_KEY, {});
  let fossils = await readJson<Fossil[]>(env, FOSSILS_KEY, []);
  const { boonActive, block: research } = await researchView(env, meta.seed, colony.epoch);

  // Feed boosts: 1 epoch of energy per recent feed, capped like on-chain.
  const feedCount: Record<number, number> = {};
  const lastFeed: Record<number, number> = {};
  for (const f of feeds) {
    if (colony.epoch - f.epoch <= 10) feedCount[f.agent] = (feedCount[f.agent] ?? 0) + 1;
    if (lastFeed[f.agent] === undefined || f.epoch > lastFeed[f.agent]) lastFeed[f.agent] = f.epoch;
  }

  // Lazy fossilization: a claimed slime that died in the wild gets a
  // headstone and its guardianship is released — the registry only ever
  // holds the living. Runs on read, so it also covers cron-less local dev.
  const fossilIds = new Set(fossils.map((f) => f.agent));
  let fossilsDirty = false;
  for (const key of Object.keys(claims)) {
    const id = Number(key);
    if (fossilIds.has(id)) continue;
    const a = colony.agents.get(id);
    if (a && a.status !== STATUS.Dead) continue;
    await fossilize(env, claims, fossils, pits, id, "died in the wild",
      a?.gen ?? 0, a?.genome.capability ?? 0, a?.genome.size_kb ?? 0, colony.epoch);
    fossilsDirty = true;
  }
  if (fossilsDirty) fossils = await readJson<Fossil[]>(env, FOSSILS_KEY, fossils);

  const guardianCount: Record<string, number> = {};
  const guardianTrophies: Record<string, number> = {};
  for (const c of Object.values(claims)) guardianCount[c.a] = (guardianCount[c.a] ?? 0) + 1;
  for (const [id, p] of Object.entries(pits)) {
    const g = claims[id];
    if (g) guardianTrophies[g.a] = (guardianTrophies[g.a] ?? 0) + p.wins;
  }

  const agents = [];
  let alive = 0, eggs = 0, quarantined = 0, pop = 0, claimed = 0;
  for (const a of colony.agents.values()) {
    if (a.status === STATUS.Dead) continue;
    pop++;
    if (a.status === STATUS.Alive) alive++;
    else if (a.status === STATUS.Egg) eggs++;
    else if (a.status === STATUS.Quarantined) quarantined++;
    const g = claims[String(a.id)];
    if (g) claimed++;
    const pit = pits[String(a.id)];
    // Breakthrough glow: a crowd-funded research win lifts every living slime.
    const boon = boonActive && a.status === STATUS.Alive ? BOON_ENERGY : 0;
    agents.push({
      id: a.id, gen: a.gen, parent: a.parent, status: a.status,
      energy: Math.min(200, a.energy + Math.min(50, (feedCount[a.id] ?? 0) * 10)
        + (pit?.energy ?? 0) + boon),
      boon: boon || undefined,
      genome: a.genome, notesDepth: a.notesDepth,
      wins: a.wins, losses: a.losses, birthEpoch: a.birthEpoch,
      guardian: g ? g.a : null,
      feeds: feedCount[a.id] ?? 0,
      fedThisEpoch: lastFeed[a.id] === colony.epoch,
      // Pit overlay: null until this slime has fought in the pit.
      pit: pit ? {
        cap: pit.cap, wins: pit.wins, losses: pit.losses, streak: pit.streak,
        best: pit.best, sizeGain: pit.sizeGain, tierWins: pit.tierWins,
        triedThisEpoch: pit.lastEpoch === colony.epoch,
        // How close the notebook is to the coffin: burst progress 0..1.
        sizePct: Math.min(1, (a.genome.size_kb + pit.sizeGain) / HOST_CAP_KB),
        odds: TIERS.map((_, i) => Number(trialOdds(a, pit, i).toFixed(3))),
      } : null,
      // Odds preview for un-pitted slimes too (what a first trial would face).
      baseOdds: pit ? undefined : TIERS.map((_, i) => Number(trialOdds(a, emptyPit(), i).toFixed(3))),
    });
  }

  const leaderboard = Object.entries(guardianCount)
    .sort((x, y) => y[1] - x[1]).slice(0, 12)
    .map(([address, slimes]) => ({ address, slimes, trophies: guardianTrophies[address] ?? 0 }));

  return {
    seed: meta.seed,
    t0: meta.t0,
    epochSeconds: EPOCH_SECONDS,
    epoch: colony.epoch,
    nextEpochIn: EPOCH_SECONDS - Math.floor((now - meta.t0) / 1000) % EPOCH_SECONDS,
    r0ema: Number(colony.r0ema.toFixed(3)),
    maxGen: colony.maxGen,
    totalEver: colony.totalEver,
    stats: { alive, eggs, quarantined, pop, claimed, fossils: fossils.length },
    research,
    tiers: TIERS,
    hostCapKb: HOST_CAP_KB,
    fossils: fossils.slice(-12).reverse(),
    firstTry: [...colony.firstTry.entries()],
    agents,
    chronicle: snap.log.filter((e) => e.i > since),
    chronicleHead: snap.log.length ? snap.log[snap.log.length - 1].i : 0,
    leaderboard,
  };
}
