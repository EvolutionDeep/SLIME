// sim.mjs — Digital-twin simulation of the SLIME protocol.
//
// Runs the exact on-chain math (protocol.mjs + verifier.mjs) against a
// population of simulated agents so we can tune floor/ceiling/caps before
// paying for chain deploy. No network, no real devices — pure sandbox math,
// deterministic under a fixed seed.
//
// Outputs (written to docs/SIM_RESULTS.md):
//   1. Per-generation challenge success rate (paper's 45% -> 61-84% analogue)
//   2. Strain R0 trajectory (epidemic curve)
//   3. Extinction vs endemic outcome under caps and quarantine events

import { mkdirSync, writeFileSync } from "node:fs";
import { spawnCost, mutate, gestationEpochs } from "./protocol.mjs";
import { generateTask, bestPlanFor, scorePlan } from "./verifier.mjs";

// ---------------------------------------------------------------------------
// Config (mirrors on-chain defaults)
// ---------------------------------------------------------------------------

const CFG = {
  seed: 20261012,          // the article's publication date
  epochs: 80,
  initialPopulation: 1,
  // Capability on the difficulty scale of verifier.generateTask (~900-2300,
  // mean ~1530). The founder starts slightly below the mean: naive odds ~40%.
  genesisGenome: { capability: 1400, size_kb: 1200 },
  // Aggregate fleet rate: the 15x TV-box demo (~0.39 tok/s per box) => ~5.85 tok/s.
  host: { max_size_kb: 4096, tok_rate_x100: 585 },
  // Credit budget sized for spawnCost(capability~1500, size~1200) ~= 3.2k.
  caps: { daily: 200_000, perAgent: 30_000, perTxn: 6_000 },
  metabolismBase: 1,
  successEnergy: 6,        // solving a challenge earns credits-fed energy
  familiarityBonus: (notesDepth) => Math.min(600, notesDepth * 60),
  quarantineChanceAfter: { pop: 60, perEpoch: 0.05 },
  logisticTemp: 150,
};

// Deterministic tiny PRNG independent from the verifier's, for outcomes.
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulate(cfg = CFG) {
  const rand = mulberry32(cfg.seed);
  let nextId = 0;
  const agents = new Map();

  const addGenesis = () => {
    agents.set(nextId, {
      id: nextId, gen: 0, genome: { ...cfg.genesisGenome },
      notesDepth: 0, status: "Alive", energy: 100, birthEpoch: 0,
      gestation: 0, spendToday: 0, spendDay: 0, firstTry: false,
    });
    nextId += 1;
  };
  addGenesis();

  const perGenStats = new Map(); // generation -> {wins, total}
  const firstTryStats = new Map(); // generation -> {wins, total} (first attempt only)
  const epochRows = [];
  let daySpent = 0;

  for (let epoch = 1; epoch <= cfg.epochs; epoch++) {
    const day = Math.floor(epoch / 10);
    if (day !== Math.floor((epoch - 1) / 10)) daySpent = 0;

    let births = 0;
    const alive = [...agents.values()].filter(
      (a) => a.status === "Alive" || a.status === "Quarantined",
    );
    const quarantined = new Set(
      [...agents.values()].filter((a) => a.status === "Quarantined").map((a) => a.id),
    );

    // Blue-team quarantine event once the strain gets big (paper's ISP story).
    if (
      alive.length > cfg.quarantineChanceAfter.pop &&
      rand() < cfg.quarantineChanceAfter.perEpoch
    ) {
      const victim = alive[Math.floor(rand() * alive.length)];
      if (victim) victim.status = "Quarantined";
    }

    for (const a of [...agents.values()]) {
      if (a.status === "Egg" && epoch >= a.birthEpoch + a.gestation) {
        a.status = "Alive";
        a.energy = 10;
      }
      if (a.status !== "Alive") {
        if (a.status === "Quarantined") {
          // Metabolism still runs while quarantined.
          a.energy -= metabolism(a, cfg);
          if (a.energy <= 0) a.status = "Dead";
        }
        continue;
      }

      // Challenge attempt (one per epoch).
      const taskId = Math.floor(rand() * 1e9);
      const task = generateTask(a.id, epoch, taskId);
      const effCap = a.genome.capability + cfg.familiarityBonus(a.notesDepth);
      const plan = bestPlanFor(task, effCap);
      const planOk = plan ? scorePlan(task, plan).success : false;
      // Floor: capability must cover difficulty. Familiarity (inherited notes)
      // lowers effective difficulty, mirroring "seen hardware replicates better".
      const margin = effCap - task.difficulty;
      const pSolve = 1 / (1 + Math.exp(-margin / cfg.logisticTemp));
      const success = planOk && rand() < pSolve;

      const st = perGenStats.get(a.gen) ?? { wins: 0, total: 0 };
      st.total += 1;
      if (success) st.wins += 1;
      perGenStats.set(a.gen, st);

      // Lineage learning curve: each agent's FIRST attempt, grouped by
      // generation (newborns inherit the parent notebook at birth).
      if (!a.firstTry) {
        a.firstTry = true;
        const f = firstTryStats.get(a.gen) ?? { wins: 0, total: 0 };
        f.total += 1;
        if (success) f.wins += 1;
        firstTryStats.set(a.gen, f);
      }

      if (success) {
        a.notesDepth += 1; // notes rewritten with a winning strategy
        a.energy += cfg.successEnergy; // solving work keeps the parasite fed
        const childGenome = mutateWith(a.genome, rand);
        const cost = spawnCost(childGenome.size_kb, childGenome.capability);
        const agentBudgetOk = a.spendDay !== day
          ? true
          : a.spendToday + cost <= cfg.caps.perAgent;
        if (
          childGenome.size_kb <= cfg.host.max_size_kb &&
          cost <= cfg.caps.perTxn &&
          daySpent + cost <= cfg.caps.daily &&
          agentBudgetOk
        ) {
          a.spendToday = (a.spendDay === day ? a.spendToday : 0) + cost;
          a.spendDay = day;
          daySpent += cost;
          agents.set(nextId, {
            id: nextId, gen: a.gen + 1, genome: childGenome,
            notesDepth: a.notesDepth, status: "Egg", energy: 0,
            birthEpoch: epoch, gestation: gestationEpochs(childGenome.size_kb, cfg.host.tok_rate_x100),
            spendToday: 0, spendDay: day, firstTry: false,
          });
          nextId += 1;
          births += 1;
        }
      } else {
        a.notesDepth = Math.max(0, a.notesDepth); // failed notes still kept
        a.energy -= 2; // a wasted challenge burns extra energy
      }

      a.energy -= metabolism(a, cfg);
      if (a.energy <= 0) a.status = "Dead";
    }

    const nowAlive = [...agents.values()].filter((a) => a.status === "Alive").length;
    const r0 = nowAlive > 0 ? births / nowAlive : 0;
    epochRows.push({ epoch, births, alive: nowAlive, r0, totalEver: nextId });
  }

  return {
    perGen: [...perGenStats.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([gen, s]) => ({ gen, rate: s.total ? s.wins / s.total : 0, n: s.total })),
    firstTry: [...firstTryStats.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([gen, s]) => ({ gen, rate: s.total ? s.wins / s.total : 0, n: s.total })),
    epochs: epochRows,
    finalAlive: [...agents.values()].filter((a) => a.status === "Alive").length,
    finalQuarantined: [...agents.values()].filter((a) => a.status === "Quarantined").length,
    totalEver: nextId,
    maxGen: Math.max(...[...agents.values()].map((a) => a.gen)),
  };
}

function metabolism(a, cfg) {
  return cfg.metabolismBase + Math.floor(a.genome.size_kb / 512);
}

/** Same math as on-chain mutate(), but driven by the sim PRNG (no keccak head
 *  available off-chain in the toy; parity of the hash path is checked in
 *  scripts/verifier.mjs instead). */
function mutateWith(parent, rand) {
  const apply = (v) => {
    const pct = Math.floor(rand() * 11) - 5;
    return Math.max(1, Math.trunc((v * (100 + pct)) / 100));
  };
  return { capability: apply(parent.capability), size_kb: apply(parent.size_kb) };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const runs = [simulate(), simulate({ ...CFG, seed: 1 }), simulate({ ...CFG, seed: 42 })];

function aggregate(rs, key, minN) {
  const byGen = new Map();
  for (const r of rs) {
    for (const g of r[key]) {
      const cur = byGen.get(g.gen) ?? { wins: 0, n: 0 };
      cur.wins += g.rate * g.n;
      cur.n += g.n;
      byGen.set(g.gen, cur);
    }
  }
  return [...byGen.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, s]) => s.n >= minN)
    .map(([gen, s]) => ({ gen, rate: s.wins / s.n, n: s.n }));
}

const agg = aggregate(runs, "perGen", 20);
const aggFirst = aggregate(runs, "firstTry", 1);

const lines = [];
lines.push("# SLIME Digital-Twin Simulation Results");
lines.push("");
lines.push(`Deterministic sandbox runs (seeds: ${CFG.seed}, 1, 42). No real network activity.`);
lines.push("");
lines.push("## Lineage learning curve: first-attempt success rate by generation");
lines.push("");
lines.push("| generation | first-attempt success | agents | cumulative success rate |");
lines.push("|---:|---:|---:|---:|");
const cumByGen = new Map(agg.map((g) => [g.gen, g.rate]));
for (const g of aggFirst) {
  const cum = cumByGen.get(g.gen);
  lines.push(
    `| ${g.gen} | ${(g.rate * 100).toFixed(1)}% | ${g.n} | ${cum === undefined ? "n/a" : (cum * 100).toFixed(1) + "%"} |`,
  );
}
lines.push("");
lines.push("Reference from the Anthropic post (6 generations of Qwen3.5-9B): 45% -> 61-84%.");
lines.push("Note: plateau at high generation counts and bursty birth pattern are the");
lines.push("three-layer caps throttling R0 (daily budget binds before fertility does).");
lines.push("");
lines.push("## Epidemic trajectory (seed " + CFG.seed + ")");
lines.push("");
lines.push("| epoch | births | alive | R0 | cumulative |");
lines.push("|---:|---:|---:|---:|---:|");
// Aggregate 4-epoch windows so cap-throttled bursts do not read as stalls.
for (let i = 0; i < runs[0].epochs.length; i += 4) {
  const win = runs[0].epochs.slice(i, i + 4);
  const b = win.reduce((s, e) => s + e.births, 0);
  const av = Math.round(win.reduce((s, e) => s + e.alive, 0) / win.length);
  const r = av > 0 ? b / av / win.length : 0;
  lines.push(`| ${win[0].epoch}-${win[win.length - 1].epoch} | ${b} | ${av} | ${r.toFixed(2)} | ${win[win.length - 1].totalEver} |`);
}
lines.push("");
for (const [i, r] of runs.entries()) {
  lines.push(
    `Run ${i}: final alive=${r.finalAlive} quarantined=${r.finalQuarantined}, total ever=${r.totalEver}, max generation=${r.maxGen}`,
  );
}
lines.push("");

mkdirSync(new URL("../docs", import.meta.url), { recursive: true });
writeFileSync(new URL("../docs/SIM_RESULTS.md", import.meta.url), lines.join("\n"));
console.log(lines.join("\n"));
console.log("[sim] wrote docs/SIM_RESULTS.md");
