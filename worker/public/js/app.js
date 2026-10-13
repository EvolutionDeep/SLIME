// app.js — Dashboard renderer for THE shared world.
//
// There is no browser-side simulation anymore: the colony lives in the
// Worker (deterministic engine + clock), and every visitor renders the
// exact same world at the exact same epoch. This file polls /api/world,
// feeds the 3D scene + chronicle + gauges, and wires the RPG claim layer.
// All comments in English by project convention.

import { ColonyScene } from "./scene.js";
import { setupKeeper } from "./keeper.js";
import { setupClaim } from "./claim.js";

const $ = (id) => document.getElementById(id);

const ui = {
  scene: $("scene"),
  epoch: $("st-epoch"), pop: $("st-pop"), alive: $("st-alive"),
  r0: $("st-r0"), total: $("st-total"), claimed: $("st-claimed"),
  seasonBar: $("season-bar"),
  feed: $("feed"), card: $("card"), curve: $("curve"),
  mode: $("mode"), rotate: $("btn-rotate"), about: $("about"),
  keeper: $("keeper"), keeperBtn: $("btn-keeper"),
  aboutBtn: $("btn-about"), loading: $("loading"),
};

const POLL_MS = 4000;
let world = null;        // raw /api/world payload
let colonyView = null;   // scene-compatible view built from world
let since = -1;          // chronicle cursor
let seenHeads = new Set();

const scene = new ColonyScene(ui.scene);
scene.onHover((id) => showCard(id));
scene.onSelect((id) => { if (id != null) scene.focus(id, colonyView); });

const claim = setupClaim({ scene, getWorld: () => world, refresh: () => poll() });

// ---------------------------------------------------------------------------
// Shared-world polling
// ---------------------------------------------------------------------------

function toColonyView(w) {
  const agents = new Map();
  for (const a of w.agents) {
    agents.set(a.id, {
      id: a.id, gen: a.gen, parent: a.parent, status: a.status,
      energy: a.energy, genome: a.genome, notesDepth: a.notesDepth,
      wins: a.wins, losses: a.losses, birthEpoch: a.birthEpoch,
      guardian: a.guardian, feeds: a.feeds, fedThisEpoch: a.fedThisEpoch,
      pit: a.pit, baseOdds: a.baseOdds,
    });
  }
  return {
    agents,
    firstTry: new Map(w.firstTry),
    epoch: w.epoch, r0ema: w.r0ema, maxGen: w.maxGen, totalEver: w.totalEver,
  };
}

async function poll() {
  let w;
  try {
    w = await fetch(`/api/world?since=${since}`).then((r) => r.json());
    if (!w || !Array.isArray(w.agents)) throw new Error("bad world payload");
  } catch {
    ui.mode.textContent = "world link down — retrying";
    ui.mode.classList.remove("live");
    return;
  }
  world = w;
  try { colonyView = toColonyView(w); } catch { /* keep last good view on malformed payload */ }
  since = w.chronicleHead;

  // Fresh chronicle entries drive effects, feed and toasts.
  const fresh = w.chronicle.filter((e) => !seenHeads.has(e.i));
  for (const e of fresh) seenHeads.add(e.i);
  if (seenHeads.size > 500) seenHeads = new Set(fresh.map((e) => e.i));
  scene.handleEvents(fresh, colonyView);
  scene.sync(colonyView);
  pushChronicle(fresh);
  renderStats(w);
  renderCurve(w);
  claim.refresh(w, fresh);

  ui.mode.textContent = `SHARED WORLD · ${w.stats.pop} souls · epoch ${w.epoch}`;
  ui.mode.classList.add("live");
  if (ui.loading && !ui.loading.removed) ui.loading.remove();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function renderStats(w) {
  ui.epoch.textContent = w.epoch;
  ui.pop.textContent = w.stats.pop;
  ui.alive.textContent = w.stats.alive;
  ui.r0.textContent = w.r0ema.toFixed(2);
  ui.total.textContent = w.totalEver;
  ui.claimed.textContent = `${w.stats.claimed}/${w.stats.pop}`;
  // R₀ gauge: half-scale reads as the extinction line, past it = epidemic.
  const pct = Math.min(100, (w.r0ema / 2) * 100);
  $("g-r0").style.width = pct.toFixed(1) + "%";
  ui.r0.parentElement.classList.toggle("hot", w.r0ema > 1);
  // Season countdown: seconds until the next shared epoch.
  ui.seasonBar.style.width = (100 * (1 - w.nextEpochIn / w.epochSeconds)).toFixed(1) + "%";
  $("season-cd").textContent = w.nextEpochIn + "s";
}

function feedRow(kind, meta, text, tail) {
  const li = document.createElement("li");
  li.className = "ev-" + kind;
  li.innerHTML = `<i class="dot"></i><span class="meta">${meta}</span>` +
    `<span class="tag">${kind}</span><span class="txt">${text}</span>` +
    (tail ? ` <span class="dim">${tail}</span>` : "");
  return li;
}

function pushChronicle(events) {
  for (const ev of events) {
    const a = ev.agent != null && colonyView ? colonyView.agents.get(ev.agent) : null;
    let text = ev.type;
    if (ev.type === "birth") text = `agent #${ev.agent} budded from ${ev.from == null ? "genesis" : "#" + ev.from} → gen ${ev.gen}`;
    else if (ev.type === "hatch") text = `agent #${ev.agent} emerged from egg`;
    else if (ev.type === "death") text = `agent #${ev.agent} energy exhausted`;
    else if (ev.type === "quarantine") text = `agent #${ev.agent} swept by blue team`;
    else if (ev.type === "cap-blocked") text = `${ev.n ?? 1} spawn attempts refused by credit caps`;
    else if (ev.type === "trial") text = `agent #${ev.agent} ${ev.ok ? "cleared" : "failed"} a pit trial at difficulty ${ev.diff}`;
    else if (ev.type === "burst") text = `agent #${ev.agent} burst its host in the pit — fossilized`;
    const kind = ev.type === "cap-blocked" ? "cap" : ev.type;
    ui.feed.prepend(feedRow(kind, `e${ev.epoch}`, text,
      a ? `#${a.gen}g ${a.genome.capability}cap` : ""));
    while (ui.feed.children.length > 30) ui.feed.lastChild.remove();
  }
}

// Specimen report card — with the claim CTA wired into the RPG layer.
function showCard(id) {
  if (id == null || !colonyView) { ui.card.classList.add("hidden"); return; }
  const a = colonyView.agents.get(id);
  if (!a) { ui.card.classList.add("hidden"); return; }
  const statusColor = { Alive: "#35ffc3", Egg: "#b58cff", Quarantined: "#ff5470", Dead: "#8b98a5" }[a.status];
  const cell = (label, value) =>
    `<div class="rp-cell"><label>${label}</label><value>${value}</value></div>`;
  const ePct = Math.max(0, Math.min(100, (a.energy / 200) * 100));
  const short = (addr) => addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : "—";
  const pitLine = a.pit
    ? cell("pit record", `${a.pit.wins}W / ${a.pit.losses}L<div class="rp-streak">streak ${a.pit.streak} · best ${a.pit.best} · cap +${a.pit.cap}</div>`)
    : cell("pit record", "untouched");
  ui.card.innerHTML = `
    <div class="rp-bar" style="--c:${statusColor}"></div>
    <div class="rp-head"><b>SLIME #${a.id}</b><span class="rp-status" style="--c:${statusColor}">${a.status}</span></div>
    <div class="rp-grid">
      ${cell("generation", a.gen)}
      ${cell("capability", a.genome.capability + (a.pit?.cap ?? 0))}
      ${cell("genome", (a.genome.size_kb + (a.pit?.sizeGain ?? 0)).toLocaleString() + " KB")}
      ${pitLine}
      ${cell("notes depth", a.notesDepth)}
      ${cell("energy", `${a.energy}<div class="rp-ebar"><i style="width:${ePct}%"></i></div>`)}
      ${cell("wild wins / losses", `${a.wins} / ${a.losses}`)}
      ${cell("parent", a.parent == null ? "genesis" : "#" + a.parent)}
    </div>
    <div class="rp-owner">${a.guardian
      ? ` guardian <b>${short(a.guardian)}</b> — this slime belongs to someone`
      : "⬥ UNCLAIMED — no one is keeping this slime alive"}</div>
    ${claim.cardButton(a)}
    <div class="rp-foot">▸ click to trace lineage</div>`;
  ui.card.classList.remove("hidden");
}

// Learning curve: first-attempt success by generation vs the paper's band.
function renderCurve(w) {
  const c = ui.curve;
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = "rgba(53,255,195,0.07)";
  g.lineWidth = 1;
  for (const r of [0.25, 0.5, 0.75]) {
    g.beginPath(); g.moveTo(26, H - 18 - (H - 30) * r); g.lineTo(W - 8, H - 18 - (H - 30) * r); g.stroke();
  }
  const ft = new Map(w.firstTry);
  const gens = [...ft.keys()].sort((x, y) => x - y).filter((n) => n <= 8);
  if (!gens.length) return;
  const x = (i) => 26 + (W - 36) * (gens.length === 1 ? 0.5 : i / (gens.length - 1));
  const y = (r) => H - 18 - (H - 30) * r;
  g.fillStyle = "rgba(53,255,195,0.05)";
  g.fillRect(20, y(0.84), W - 28, y(0.45) - y(0.84));
  g.strokeStyle = "rgba(53,255,195,0.22)";
  g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(20, y(0.45)); g.lineTo(W - 8, y(0.45));
  g.moveTo(20, y(0.84)); g.lineTo(W - 8, y(0.84)); g.stroke();
  g.setLineDash([]);
  g.strokeStyle = "rgba(125,249,255,0.25)"; g.lineWidth = 5;
  g.beginPath();
  gens.forEach((gen, i) => {
    const f = ft.get(gen);
    const r = f.total ? f.wins / f.total : 0;
    i === 0 ? g.moveTo(x(i), y(r)) : g.lineTo(x(i), y(r));
  });
  g.stroke();
  g.strokeStyle = "#7df9ff"; g.lineWidth = 1.5;
  g.stroke();
  g.fillStyle = "#aef7ff";
  gens.forEach((gen, i) => {
    const f = ft.get(gen);
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
// Controls (world-clock driven: no local pause/speed/seed — the world is
// the world, and everyone watches the same one turn).
// ---------------------------------------------------------------------------

ui.rotate.addEventListener("click", () => {
  scene.controls.autoRotate = !scene.controls.autoRotate;
  ui.rotate.classList.toggle("off", !scene.controls.autoRotate);
});
ui.aboutBtn.addEventListener("click", () => ui.about.classList.toggle("hidden"));
ui.keeperBtn.addEventListener("click", () => ui.keeper.classList.toggle("hidden"));
setupKeeper();
if (location.hash === "#keeper") ui.keeper.classList.remove("hidden");
if (location.hash === "#about") ui.about.classList.remove("hidden");

// ---------------------------------------------------------------------------
// Boot: the shared world begins the instant the page opens.
// ---------------------------------------------------------------------------

poll();
setInterval(poll, POLL_MS);
