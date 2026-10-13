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
const CHRONICLE_KEEP = 80;
const FEEDS_KEEP = 2000;
const CATCHUP_CAP = 400; // max ticks computed in one request

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
// View: the JSON the whole world renders from.
// ---------------------------------------------------------------------------

export async function worldView(env: WorldEnv, since = -1) {
  const now = Date.now();
  const { colony, snap, meta } = await getWorld(env);
  const claims = await getClaims(env);
  const feeds = await readJson<Feed[]>(env, FEEDS_KEY, []);

  // Feed boosts: 1 epoch of energy per recent feed, capped like on-chain.
  const feedCount: Record<number, number> = {};
  const lastFeed: Record<number, number> = {};
  for (const f of feeds) {
    if (colony.epoch - f.epoch <= 10) feedCount[f.agent] = (feedCount[f.agent] ?? 0) + 1;
    if (lastFeed[f.agent] === undefined || f.epoch > lastFeed[f.agent]) lastFeed[f.agent] = f.epoch;
  }

  const guardianCount: Record<string, number> = {};
  for (const c of Object.values(claims)) guardianCount[c.a] = (guardianCount[c.a] ?? 0) + 1;

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
    agents.push({
      id: a.id, gen: a.gen, parent: a.parent, status: a.status,
      energy: Math.min(160, a.energy + Math.min(50, (feedCount[a.id] ?? 0) * 10)),
      genome: a.genome, notesDepth: a.notesDepth,
      wins: a.wins, losses: a.losses, birthEpoch: a.birthEpoch,
      guardian: g ? g.a : null,
      feeds: feedCount[a.id] ?? 0,
      fedThisEpoch: lastFeed[a.id] === colony.epoch,
    });
  }

  const leaderboard = Object.entries(guardianCount)
    .sort((x, y) => y[1] - x[1]).slice(0, 12)
    .map(([address, slimes]) => ({ address, slimes }));

  return {
    seed: meta.seed,
    t0: meta.t0,
    epochSeconds: EPOCH_SECONDS,
    epoch: colony.epoch,
    nextEpochIn: EPOCH_SECONDS - Math.floor((now - meta.t0) / 1000) % EPOCH_SECONDS,
    r0ema: Number(colony.r0ema.toFixed(3)),
    maxGen: colony.maxGen,
    totalEver: colony.totalEver,
    stats: { alive, eggs, quarantined, pop, claimed },
    firstTry: [...colony.firstTry.entries()],
    agents,
    chronicle: snap.log.filter((e) => e.i > since),
    chronicleHead: snap.log.length ? snap.log[snap.log.length - 1].i : 0,
    leaderboard,
  };
}
