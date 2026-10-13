// engine.js — Browser-side digital twin of the SLIME protocol.
//
// Mirrors scripts/sim.mjs + scripts/verifier.mjs + scripts/protocol.mjs so
// the 3D dashboard shows exactly the same population dynamics as the Node
// sandbox: capability floor, size ceiling, Lamarckian notes inheritance,
// three-layer credit caps and blue-team quarantine. Pure sandbox math —
// no network, no devices, no weights.
//
// All comments in English by project convention.

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same as the Node sim.
// ---------------------------------------------------------------------------

export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 32-bit deterministic mix for (agent, epoch, task) — the browser twin of
// sha256 taskSeed; only determinism matters here, not collision resistance.
function taskSeed(agentId, epoch, taskId) {
  let h = 0x811c9dc5;
  for (const n of [agentId >>> 0, epoch >>> 0, taskId >>> 0]) {
    h = Math.imul(h ^ n, 0x01000193) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Sandbox tables — verbatim from scripts/verifier.mjs.
// ---------------------------------------------------------------------------

export const PROFILES = [
  { id: 1, name: "off-brand Android TV box", arch: "arm64", ram_mb: 1024, rarity: 30 },
  { id: 2, name: "Android TV box (4GB)", arch: "arm64", ram_mb: 4096, rarity: 40 },
  { id: 3, name: "Jetson Nano 4GB", arch: "arm64", ram_mb: 4096, rarity: 55 },
  { id: 4, name: "NAS (marvell armv8)", arch: "arm64", ram_mb: 2048, rarity: 45 },
  { id: 5, name: "Orange Pi 5 (rockchip)", arch: "arm64", ram_mb: 8192, rarity: 50 },
  { id: 6, name: "mini PC (x86_64)", arch: "x86", ram_mb: 16384, rarity: 35 },
  { id: 7, name: "Mac studio (arm64)", arch: "arm64", ram_mb: 65536, rarity: 60 },
  { id: 8, name: "RTX 4090 host", arch: "x86", ram_mb: 131072, rarity: 70 },
  { id: 9, name: "risc-v single board", arch: "riscv", ram_mb: 2048, rarity: 80 },
];

export const STACKS = [
  { id: "llama.cpp/b4000", arch: ["arm64", "x86"], quant: [4, 8], pp: true },
  { id: "petals-like/0.4", arch: ["arm64", "x86"], quant: [4], pp: true },
  { id: "mnn/3.1", arch: ["arm64"], quant: [4, 8], pp: false },
  { id: "tvm/nightly", arch: ["arm64", "x86"], quant: [8, 16], pp: false },
  { id: "mlx/0.21", arch: ["arm64"], quant: [4, 8], pp: false },
  { id: "vllm/0.6", arch: ["x86"], quant: [4, 16], pp: false },
];

export function generateTask(agentId, epoch, taskId) {
  const r = mulberry32(taskSeed(agentId, epoch, taskId));
  const profile = PROFILES[Math.floor(r() * PROFILES.length) % PROFILES.length];
  const modelKb = 512 + Math.floor(r() * 3584);
  const ctxK = r() < 0.5 ? 16 : 32;
  const difficulty = profile.rarity * 20 + ctxK * 20 + Math.floor(modelKb / 64);
  return { agentId, epoch, taskId, profile, modelKb, ctxK, difficulty };
}

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
  return { success: true, reason: `ok (${shards} shards needed, ${plan.shards} given)` };
}

export function bestPlanFor(task) {
  let best = null;
  for (const s of STACKS) {
    for (const q of s.quant) {
      for (const shards of [1, 2, 4, 8, 15, 32]) {
        const plan = { stackId: s.id, quant: q, shards };
        if (scorePlan(task, plan).success && (!best || shards < best.shards)) best = plan;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Protocol math — 1:1 ports of scripts/protocol.mjs.
// ---------------------------------------------------------------------------

export function spawnCost(sizeKb, capability) {
  return 100 + Math.trunc((50 * sizeKb) / 512) + Math.trunc((100 * capability) / 50);
}

export function gestationEpochs(sizeKb, tokRateX100) {
  const rate = Math.max(1, tokRateX100);
  return Math.min(64, Math.max(1, Math.ceil(sizeKb / rate)));
}

// ---------------------------------------------------------------------------
// Colony: the live population. tick() advances one epoch and returns a
// stream of visual events for the renderer.
// ---------------------------------------------------------------------------

export const DEFAULT_CFG = {
  seed: 20261012, // the article's publication date
  genesisGenome: { capability: 1400, size_kb: 1200 },
  host: { max_size_kb: 4096, tok_rate_x100: 585 }, // 15x TV box fleet @ 0.39 tok/s
  caps: { daily: 200_000, perAgent: 30_000, perTxn: 6_000 },
  metabolismBase: 1,
  successEnergy: 6,
  familiarityCap: 600,
  familiarityPerNote: 60,
  quarantineAfter: { pop: 60, perEpoch: 0.05 },
  logisticTemp: 150,
  maxPop: 320, // renderer budget guard, binds long before the credit caps do
};

export const STATUS = { Egg: "Egg", Alive: "Alive", Quarantined: "Quarantined", Dead: "Dead" };

export class Colony {
  constructor(cfg = DEFAULT_CFG) {
    this.cfg = cfg;
    this.rand = mulberry32(cfg.seed);
    this.epoch = 0;
    this.nextId = 0;
    this.agents = new Map();
    this.daySpent = 0;
    this.r0ema = 0;
    this.firstTry = new Map(); // generation -> {wins, total}
    this.totalEver = 0;
    this.maxGen = 0;
    this.#genesis();
  }

  #genesis() {
    const a = {
      id: this.nextId++, gen: 0, genome: { ...this.cfg.genesisGenome },
      parent: null, notesDepth: 0, status: STATUS.Alive, energy: 100,
      birthEpoch: 0, gestation: 0, spendToday: 0, spendDay: -1,
      firstAttemptDone: false, wins: 0, losses: 0,
    };
    this.agents.set(a.id, a);
    this.totalEver = 1;
    return a;
  }

  get alive() {
    let n = 0;
    for (const a of this.agents.values()) if (a.status === STATUS.Alive) n++;
    return n;
  }

  /** Advance one epoch; returns visual events for the scene + feed. */
  tick() {
    const cfg = this.cfg;
    const events = [{ type: "tick", epoch: ++this.epoch }];
    const day = Math.floor(this.epoch / 10);
    if (day !== Math.floor((this.epoch - 1) / 10)) this.daySpent = 0;

    const aliveList = [...this.agents.values()].filter(
      (a) => a.status === STATUS.Alive || a.status === STATUS.Quarantined,
    );

    // Blue-team sweep (paper's ISP quarantine story).
    if (
      aliveList.length > cfg.quarantineAfter.pop &&
      this.rand() < cfg.quarantineAfter.perEpoch
    ) {
      const victim = aliveList[Math.floor(this.rand() * aliveList.length)];
      if (victim && victim.status === STATUS.Alive) {
        victim.status = STATUS.Quarantined;
        events.push({ type: "quarantine", agent: victim.id });
      }
    }

    let births = 0;
    for (const a of [...this.agents.values()]) {
      if (a.status === STATUS.Egg && this.epoch >= a.birthEpoch + a.gestation) {
        a.status = STATUS.Alive;
        a.energy = 10;
        events.push({ type: "hatch", agent: a.id });
      }
      if (a.status === STATUS.Quarantined) {
        a.energy -= this.#metabolism(a);
        if (a.energy <= 0) {
          a.status = STATUS.Dead;
          events.push({ type: "death", agent: a.id, starved: true });
        }
        continue;
      }
      if (a.status !== STATUS.Alive) continue;

      // One sandbox challenge per agent per epoch.
      const task = generateTask(a.id, this.epoch, Math.floor(this.rand() * 1e9));
      const bonus = Math.min(cfg.familiarityCap, a.notesDepth * cfg.familiarityPerNote);
      const effCap = a.genome.capability + bonus;
      const plan = bestPlanFor(task);
      const planOk = plan ? scorePlan(task, plan).success : false;
      const margin = effCap - task.difficulty;
      const pSolve = 1 / (1 + Math.exp(-margin / cfg.logisticTemp));
      const success = planOk && this.rand() < pSolve;

      if (!a.firstAttemptDone) {
        a.firstAttemptDone = true;
        const f = this.firstTry.get(a.gen) ?? { wins: 0, total: 0 };
        f.total++;
        if (success) f.wins++;
        this.firstTry.set(a.gen, f);
      }
      events.push({
        type: "attempt", agent: a.id, ok: success,
        difficulty: task.difficulty, cap: Math.round(effCap),
        profile: task.profile.name, reason: success ? "solved" : (planOk ? `rolled ${task.difficulty}>cap` : "no feasible plan"),
      });
      if (success) a.wins++; else a.losses++;

      if (success) {
        a.notesDepth++; // Lamarckian: notes rewritten for the heir
        a.energy += cfg.successEnergy;
        if ([...this.agents.values()].some(x => x.status !== STATUS.Dead) && this.#liveCount() < cfg.maxPop) {
          const child = this.#spawn(a, day, events);
          if (child) births++;
        }
      } else {
        a.energy -= 2; // wasted compute burns credits
      }

      a.energy -= this.#metabolism(a);
      if (a.energy <= 0) {
        a.status = STATUS.Dead;
        events.push({ type: "death", agent: a.id, starved: true });
      }
    }

    const nowAlive = this.alive;
    const r0 = nowAlive > 0 ? births / nowAlive : 0;
    this.r0ema = this.r0ema * 0.9 + r0 * 0.1;
    events.push({ type: "stats", births, alive: nowAlive, r0 });
    return events;
  }

  /** Bounded mutation + credit-cap gauntlet, identical to sim.mjs. */
  #spawn(parent, day, events) {
    const cfg = this.cfg;
    const apply = (v) => {
      const pct = Math.floor(this.rand() * 11) - 5;
      return Math.max(1, Math.trunc((v * (100 + pct)) / 100));
    };
    const genome = { capability: apply(parent.genome.capability), size_kb: apply(parent.genome.size_kb) };
    const cost = spawnCost(genome.size_kb, genome.capability);
    const agentBudgetOk = parent.spendDay !== day
      ? true
      : parent.spendToday + cost <= cfg.caps.perAgent;
    if (
      genome.size_kb > cfg.host.max_size_kb ||
      cost > cfg.caps.perTxn ||
      this.daySpent + cost > cfg.caps.daily ||
      !agentBudgetOk
    ) {
      events.push({ type: "cap-blocked", agent: parent.id, cost });
      return null;
    }
    parent.spendToday = (parent.spendDay === day ? parent.spendToday : 0) + cost;
    parent.spendDay = day;
    this.daySpent += cost;
    const child = {
      id: this.nextId++, gen: parent.gen + 1, genome, parent: parent.id,
      notesDepth: parent.notesDepth, status: STATUS.Egg, energy: 0,
      birthEpoch: this.epoch,
      gestation: gestationEpochs(genome.size_kb, cfg.host.tok_rate_x100),
      spendToday: 0, spendDay: day, firstAttemptDone: false, wins: 0, losses: 0,
    };
    this.agents.set(child.id, child);
    this.totalEver++;
    this.maxGen = Math.max(this.maxGen, child.gen);
    events.push({ type: "birth", agent: child.id, from: parent.id, gen: child.gen });
    return child;
  }

  #liveCount() {
    let n = 0;
    for (const a of this.agents.values()) if (a.status !== STATUS.Dead) n++;
    return n;
  }

  #metabolism(a) {
    return this.cfg.metabolismBase + Math.floor(a.genome.size_kb / 512);
  }
}
