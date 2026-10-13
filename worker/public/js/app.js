// app.js — Dashboard orchestration: simulation loop, HUD, interaction,
// and the live-chain probe that takes over once the program is deployed.
// All comments in English by project convention.

import { Colony, DEFAULT_CFG, STATUS } from "./engine.js";
import { ColonyScene } from "./scene.js";
import { setupKeeper } from "./keeper.js";

const $ = (id) => document.getElementById(id);

const ui = {
  scene: $("scene"),
  epoch: $("st-epoch"), pop: $("st-pop"), alive: $("st-alive"),
  r0: $("st-r0"), gen: $("st-gen"), total: $("st-total"),
  feed: $("feed"), card: $("card"), curve: $("curve"),
  mode: $("mode"), pause: $("btn-pause"), speed: $("btn-speed"),
  reset: $("btn-reset"), rotate: $("btn-rotate"), about: $("about"),
  keeper: $("keeper"), keeperBtn: $("btn-keeper"),
  aboutBtn: $("btn-about"), loading: $("loading"),
};

const EPOCH_MS = 1500;
const SPEEDS = [0.5, 1, 2, 4];
let speedIdx = 1;
let paused = false;
let colony = new Colony({ ...DEFAULT_CFG });
let timer = null;
let live = null; // live chain data when the program is deployed

const scene = new ColonyScene(ui.scene);
scene.onHover((id) => showCard(id));
scene.onSelect((id) => { if (id != null) scene.focus(id, colony); });

// ---------------------------------------------------------------------------
// Simulation loop
// ---------------------------------------------------------------------------

function step() {
  if (!paused && !live) {
    const events = colony.tick();
    scene.handleEvents(events, colony);
    scene.sync(colony);
    pushFeed(events);
    renderStats();
    renderCurve();
  }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(step, EPOCH_MS / SPEEDS[speedIdx]);
}

function resetColony() {
  const seed = (Date.now() % 1e9) >>> 0;
  colony = new Colony({ ...DEFAULT_CFG, seed });
  scene.reset();
  scene.sync(colony);
  ui.feed.innerHTML = "";
  pushFeed([{ type: "tick", epoch: 0 }]);
  renderStats();
  renderCurve();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function renderStats() {
  let pop = 0, alive = 0;
  for (const a of colony.agents.values()) {
    if (a.status !== STATUS.Dead) pop++;
    if (a.status === STATUS.Alive) alive++;
  }
  ui.epoch.textContent = colony.epoch;
  ui.pop.textContent = pop;
  ui.alive.textContent = alive;
  ui.r0.textContent = colony.r0ema.toFixed(2);
  ui.gen.textContent = colony.maxGen;
  ui.total.textContent = colony.totalEver;
}

const FEED_ICONS = {
  birth: ["✦", "#35ffc3"], hatch: ["◍", "#b58cff"], death: ["✕", "#ff5470"],
  quarantine: ["", "#ff2244"], "cap-blocked": ["⊘", "#8b98a5"],
  tick: ["—", "#2c3a41"],
};

function pushFeed(events) {
  // Credit-cap refusals flood the stream at high population: aggregate them
  // into one chronicle line per epoch so the feed stays readable.
  const blocked = events.filter((e) => e.type === "cap-blocked").length;
  const births = events.filter((e) => e.type === "birth");
  for (const ev of events) {
    if (ev.type === "attempt" || ev.type === "stats" || ev.type === "tick" ||
        ev.type === "cap-blocked" || (ev.type === "birth" && births.length > 6)) continue;
    const [icon, color] = FEED_ICONS[ev.type] ?? ["·", "#7d8b93"];
    const a = ev.agent != null ? colony.agents.get(ev.agent) : null;
    let text = ev.type;
    if (ev.type === "birth") text = `birth · agent #${ev.agent} of #${ev.from} → gen ${ev.gen}`;
    else if (ev.type === "hatch") text = `hatch · agent #${ev.agent} emerged from egg`;
    else if (ev.type === "death") text = `death · agent #${ev.agent} energy exhausted`;
    else if (ev.type === "quarantine") text = `QUARANTINE · agent #${ev.agent} swept by blue team`;
    else if (ev.type === "cap-blocked") text = `cap blocked · spawn cost ${ev.cost} refused`;
    const li = document.createElement("li");
    li.innerHTML = `<span style="color:${color}">${icon}</span> ` +
      `<span class="dim">e${colony.epoch}</span> ${text}` +
      (a ? ` <span class="dim">#${a.gen}g ${a.genome.capability}cap</span>` : "");
    ui.feed.prepend(li);
    while (ui.feed.children.length > 26) ui.feed.lastChild.remove();
  }
  if (births.length > 6) {
    const li = document.createElement("li");
    li.innerHTML = `<span style="color:#35ffc3">✦</span> <span class="dim">e${colony.epoch}</span> ` +
      `explosion: ${births.length} new agents budded off the colony`;
    ui.feed.prepend(li);
  }
  if (blocked > 0) {
    const li = document.createElement("li");
    li.innerHTML = `<span style="color:#8b98a5">⊘</span> <span class="dim">e${colony.epoch}</span> ` +
      `${blocked} spawn attempt${blocked > 1 ? "s" : ""} refused by credit caps`;
    ui.feed.prepend(li);
    while (ui.feed.children.length > 26) ui.feed.lastChild.remove();
  }
}

function showCard(id) {
  if (id == null) { ui.card.classList.add("hidden"); return; }
  const a = colony.agents.get(id);
  if (!a) return;
  const statusColor = { Alive: "#35ffc3", Egg: "#b58cff", Quarantined: "#ff5470", Dead: "#8b98a5" }[a.status];
  ui.card.innerHTML = `
    <div class="card-head"><b>agent #${a.id}</b> <span style="color:${statusColor}">● ${a.status}</span></div>
    <div class="row"><span>generation</span><i>${a.gen}</i></div>
    <div class="row"><span>capability</span><i>${a.genome.capability}</i></div>
    <div class="row"><span>size (KB)</span><i>${a.genome.size_kb.toLocaleString()}</i></div>
    <div class="row"><span>energy</span><i>${a.energy}</i></div>
    <div class="row"><span>notes depth</span><i>${a.notesDepth}</i></div>
    <div class="row"><span>wins / losses</span><i>${a.wins} / ${a.losses}</i></div>
    <div class="row"><span>parent</span><i>${a.parent == null ? "genesis" : "#" + a.parent}</i></div>
    <div class="hint">click to trace lineage</div>`;
  ui.card.classList.remove("hidden");
}

// Learning curve: first-attempt success by generation vs the paper's band.
function renderCurve() {
  const c = ui.curve;
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const gens = [...colony.firstTry.keys()].sort((x, y) => x - y).filter((n) => n <= 8);
  if (!gens.length) return;
  const x = (i) => 26 + (W - 36) * (gens.length === 1 ? 0.5 : i / (gens.length - 1));
  const y = (r) => H - 18 - (H - 30) * r;
  // Paper reference band 45% -> 84%.
  g.fillStyle = "rgba(53,255,195,0.06)";
  g.fillRect(20, y(0.84), W - 26, y(0.45) - y(0.84));
  g.strokeStyle = "rgba(53,255,195,0.25)";
  g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(20, y(0.45)); g.lineTo(W - 6, y(0.45));
  g.moveTo(20, y(0.84)); g.lineTo(W - 6, y(0.84)); g.stroke();
  g.setLineDash([]);
  // Data line.
  g.strokeStyle = "#7df9ff"; g.lineWidth = 1.6;
  g.beginPath();
  gens.forEach((gen, i) => {
    const f = colony.firstTry.get(gen);
    const r = f.total ? f.wins / f.total : 0;
    i === 0 ? g.moveTo(x(i), y(r)) : g.lineTo(x(i), y(r));
  });
  g.stroke();
  g.fillStyle = "#aef7ff";
  gens.forEach((gen, i) => {
    const f = colony.firstTry.get(gen);
    const r = f.total ? f.wins / f.total : 0;
    g.beginPath(); g.arc(x(i), y(r), 2.6, 0, 7); g.fill();
    g.fillStyle = "#5c7382"; g.font = "9px monospace";
    g.fillText("g" + gen, x(i) - 6, H - 5);
    g.fillStyle = "#aef7ff";
  });
  g.fillStyle = "#5c7382"; g.font = "9px monospace";
  g.fillText("paper 45–84%", W - 78, 12);
}

// ---------------------------------------------------------------------------
// Live-chain probe: when the program is deployed, the chronicle replaces
// the sandbox simulation as the data source.
// ---------------------------------------------------------------------------

async function probeLive() {
  try {
    const h = await fetch("/health").then((r) => r.json());
    if (h.programDeployed) {
      const agents = await fetch("/api/agents").then((r) => r.json());
      if (Array.isArray(agents) && agents.length) {
        ui.mode.textContent = "LIVE · on-chain";
        ui.mode.classList.add("live");
        live = agents;
        return;
      }
    }
    ui.mode.textContent = "SANDBOX · digital twin";
    ui.mode.classList.remove("live");
    live = null;
  } catch { /* offline: keep sandbox mode */ }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

ui.pause.addEventListener("click", () => {
  paused = !paused;
  ui.pause.textContent = paused ? "▶ resume" : "⏸ pause";
});
ui.speed.addEventListener("click", () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  ui.speed.textContent = `×${SPEEDS[speedIdx]}`;
  schedule();
});
ui.reset.addEventListener("click", resetColony);
ui.rotate.addEventListener("click", () => {
  scene.controls.autoRotate = !scene.controls.autoRotate;
  ui.rotate.classList.toggle("off", !scene.controls.autoRotate);
});
ui.aboutBtn.addEventListener("click", () => ui.about.classList.toggle("hidden"));
ui.keeperBtn.addEventListener("click", () => ui.keeper.classList.toggle("hidden"));
setupKeeper();
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") { e.preventDefault(); ui.pause.click(); }
  if (e.key === "r") resetColony();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

scene.sync(colony);
pushFeed([{ type: "birth", agent: 0, from: null, gen: 0 }]);
renderStats();
renderCurve();
schedule();
probeLive();
setInterval(probeLive, 20000);
ui.loading.remove();
