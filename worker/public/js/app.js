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
  // R₀ gauge: half-scale reads as the extinction line, past it = epidemic.
  const pct = Math.min(100, (colony.r0ema / 2) * 100);
  $("g-r0").style.width = pct.toFixed(1) + "%";
  ui.r0.parentElement.classList.toggle("hot", colony.r0ema > 1);
}

// Feed rows are structured log lines: dot + epoch chip + type tag + text.
const FEED_KIND = {
  birth: "birth", hatch: "hatch", death: "death",
  quarantine: "quarantine", "cap-blocked": "cap", tick: "tick",
};

function feedRow(kind, meta, text, tail) {
  const li = document.createElement("li");
  li.className = "ev-" + (FEED_KIND[kind] ?? "tick");
  li.innerHTML = `<i class="dot"></i><span class="meta">${meta}</span>` +
    `<span class="tag">${kind}</span><span class="txt">${text}</span>` +
    (tail ? ` <span class="dim">${tail}</span>` : "");
  return li;
}

function pushFeed(events) {
  // Credit-cap refusals flood the stream at high population: aggregate them
  // into one chronicle line per epoch so the feed stays readable.
  const blocked = events.filter((e) => e.type === "cap-blocked").length;
  const births = events.filter((e) => e.type === "birth");
  for (const ev of events) {
    if (ev.type === "attempt" || ev.type === "stats" || ev.type === "tick" ||
        ev.type === "cap-blocked" || (ev.type === "birth" && births.length > 6)) continue;
    const kind = FEED_KIND[ev.type] ? ev.type : "tick";
    const a = ev.agent != null ? colony.agents.get(ev.agent) : null;
    let text = ev.type;
    if (ev.type === "birth") text = `agent #${ev.agent} budded from #${ev.from} → gen ${ev.gen}`;
    else if (ev.type === "hatch") text = `agent #${ev.agent} emerged from egg`;
    else if (ev.type === "death") text = `agent #${ev.agent} energy exhausted`;
    else if (ev.type === "quarantine") text = `agent #${ev.agent} swept by blue team`;
    else if (ev.type === "cap-blocked") text = `spawn cost ${ev.cost} refused`;
    ui.feed.prepend(feedRow(kind, `e${colony.epoch}`, text,
      a ? `#${a.gen}g ${a.genome.capability}cap` : ""));
    while (ui.feed.children.length > 26) ui.feed.lastChild.remove();
  }
  if (births.length > 6) {
    ui.feed.prepend(feedRow("birth", `e${colony.epoch}`,
      `explosion: ${births.length} new agents budded off the colony`));
  }
  if (blocked > 0) {
    ui.feed.prepend(feedRow("cap", `e${colony.epoch}`,
      `${blocked} spawn attempt${blocked > 1 ? "s" : ""} refused by credit caps`));
    while (ui.feed.children.length > 26) ui.feed.lastChild.remove();
  }
}

function showCard(id) {
  if (id == null) { ui.card.classList.add("hidden"); return; }
  const a = colony.agents.get(id);
  if (!a) return;
  const statusColor = { Alive: "#35ffc3", Egg: "#b58cff", Quarantined: "#ff5470", Dead: "#8b98a5" }[a.status];
  const cell = (label, value, extra = "") =>
    `<div class="rp-cell"><label>${label}</label><value>${value}</value>${extra}</div>`;
  const ePct = Math.max(0, Math.min(100, (a.energy / 160) * 100));
  ui.card.innerHTML = `
    <div class="rp-bar" style="--c:${statusColor}"></div>
    <div class="rp-head"><b>AGENT #${a.id}</b><span class="rp-status" style="--c:${statusColor}">${a.status}</span></div>
    <div class="rp-grid">
      ${cell("generation", a.gen)}
      ${cell("capability", a.genome.capability)}
      ${cell("genome", a.genome.size_kb.toLocaleString() + " KB")}
      ${cell("notes depth", a.notesDepth)}
      ${cell("energy", a.energy, `<div class="rp-ebar"><i style="width:${ePct}%"></i></div>`)}
      ${cell("wins / losses", `${a.wins} / ${a.losses}`)}
      ${cell("parent", a.parent == null ? "genesis" : "#" + a.parent, "")}
      ${cell("size rank", a.genome.size_kb > 1600 ? "heavy" : a.genome.size_kb < 1100 ? "light" : "standard")}
    </div>
    <div class="rp-foot">▸ click to trace lineage</div>`;
  ui.card.classList.remove("hidden");
}

// Learning curve: first-attempt success by generation vs the paper's band.
function renderCurve() {
  const c = ui.curve;
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  // Faint horizontal grid so the plot reads as an instrument trace.
  g.strokeStyle = "rgba(53,255,195,0.07)";
  g.lineWidth = 1;
  for (const r of [0.25, 0.5, 0.75]) {
    g.beginPath(); g.moveTo(26, H - 18 - (H - 30) * r); g.lineTo(W - 8, H - 18 - (H - 30) * r); g.stroke();
  }
  const gens = [...colony.firstTry.keys()].sort((x, y) => x - y).filter((n) => n <= 8);
  if (!gens.length) return;
  const x = (i) => 26 + (W - 36) * (gens.length === 1 ? 0.5 : i / (gens.length - 1));
  const y = (r) => H - 18 - (H - 30) * r;
  // Paper reference band 45% -> 84%.
  g.fillStyle = "rgba(53,255,195,0.05)";
  g.fillRect(20, y(0.84), W - 28, y(0.45) - y(0.84));
  g.strokeStyle = "rgba(53,255,195,0.22)";
  g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(20, y(0.45)); g.lineTo(W - 8, y(0.45));
  g.moveTo(20, y(0.84)); g.lineTo(W - 8, y(0.84)); g.stroke();
  g.setLineDash([]);
  // Data line: soft glow pass under a crisp stroke.
  g.strokeStyle = "rgba(125,249,255,0.25)"; g.lineWidth = 5;
  g.beginPath();
  gens.forEach((gen, i) => {
    const f = colony.firstTry.get(gen);
    const r = f.total ? f.wins / f.total : 0;
    i === 0 ? g.moveTo(x(i), y(r)) : g.lineTo(x(i), y(r));
  });
  g.stroke();
  g.strokeStyle = "#7df9ff"; g.lineWidth = 1.5;
  g.stroke();
  g.fillStyle = "#aef7ff";
  gens.forEach((gen, i) => {
    const f = colony.firstTry.get(gen);
    const r = f.total ? f.wins / f.total : 0;
    g.beginPath(); g.arc(x(i), y(r), 2.4, 0, 7); g.fill();
    g.fillStyle = "#4d6a68"; g.font = "8.5px 'JetBrains Mono', monospace";
    g.fillText("g" + gen, x(i) - 6, H - 5);
    g.fillStyle = "#aef7ff";
  });
  g.fillStyle = "#4d6a68"; g.font = "8.5px 'JetBrains Mono', monospace";
  g.fillText("PAPER 45–84%", W - 84, 12);
  g.fillText("0%", 4, H - 14);
  g.fillText("100%", 2, 24);
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
// Deep links: #keeper / #about open their panel straight from the URL.
if (location.hash === "#keeper") ui.keeper.classList.remove("hidden");
if (location.hash === "#about") ui.about.classList.remove("hidden");
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
