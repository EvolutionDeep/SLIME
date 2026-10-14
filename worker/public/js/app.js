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
import { createTour } from "./tour.js";
import { setupCompute } from "./compute.js";

const $ = (id) => document.getElementById(id);

const ui = {
  scene: $("scene"),
  epoch: $("st-epoch"), pop: $("st-pop"), alive: $("st-alive"),
  r0: $("st-r0"), total: $("st-total"), claimed: $("st-claimed"),
  seasonBar: $("season-bar"),
  feed: $("feed"), card: $("card"), curve: $("curve"),
  mode: $("mode"), rotate: $("btn-rotate"), hero: $("hero"),
  loading: $("loading"),
};

const POLL_MS = 4000;
let world = null;        // raw /api/world payload
let colonyView = null;   // scene-compatible view built from world
let since = -1;          // chronicle cursor
let seenHeads = new Set();

const scene = new ColonyScene(ui.scene);
// Hover cards must be REACHABLE: leaving the cell starts a grace timer
// instead of hiding instantly, and hovering the card itself pins it open.
// Without this the CLAIM/FEED/PIT buttons are impossible to click.
let cardHideTimer = null;
let pinnedId = null;         // a clicked specimen keeps its card until you click away
const cancelCardHide = () => { if (cardHideTimer) { clearTimeout(cardHideTimer); cardHideTimer = null; } };
const scheduleCardHide = (ms) => {
  // A selected (pinned) specimen never auto-hides on hover-out: focusing the
  // camera slides the cell off the cursor, which used to dismiss the card the
  // instant you clicked it. Only un-pinned "peek" cards get the grace timer.
  if (pinnedId != null) return;
  cancelCardHide();
  cardHideTimer = setTimeout(() => ui.card.classList.add("hidden"), ms);
};
scene.onHover((id) => {
  if (pinnedId != null) return;                 // the selection owns the card
  if (id == null) scheduleCardHide(500);
  else { cancelCardHide(); showCard(id); }
});
ui.card.addEventListener("mouseenter", cancelCardHide);
ui.card.addEventListener("mouseleave", () => scheduleCardHide(350));
// Click a specimen to PIN its card (survives the camera move); click empty
// water to release the pin and dismiss it — a click is a deliberate choice.
scene.onSelect((id) => {
  if (id != null) {
    pinnedId = id; cancelCardHide(); showCard(id); scene.focus(id, colonyView);
  } else {
    pinnedId = null; cancelCardHide(); ui.card.classList.add("hidden"); scene.focus(null, colonyView);
  }
});

// ---------------------------------------------------------------------------
// Drawer: one surface at a time, slid out from the left rail. Accordion
// semantics — a new tab replaces the old one, ESC or ✕ gives the screen back
// to the colony. This is where future panels plug in: add a rail button and
// a <section data-p="..."> in index.html, nothing else.
// ---------------------------------------------------------------------------

const DRAWER_LABELS = { world: "WORLD", curve: "LEARNING CURVE", guardian: "GUARDIAN", chain: "KEEPER LEDGER", compute: "VOLUNTEER COMPUTE", paper: "THE PAPER" };
const drawer = {
  el: $("drawer"), title: $("drawer-title"),
  buttons: [...document.querySelectorAll(".rail-btn[data-drawer]")],
  sections: [...document.querySelectorAll(".dp[data-p]")],
  current: null,
  show(key) {
    if (this.current === key) { this.close(); return; }
    this.current = key;
    this.el.classList.remove("hidden");
    this.title.textContent = DRAWER_LABELS[key] ?? key;
    for (const s of this.sections) s.classList.toggle("hidden", s.dataset.p !== key);
    for (const b of this.buttons) b.classList.toggle("active", b.dataset.drawer === key);
  },
  close() {
    this.current = null;
    this.el.classList.add("hidden");
    for (const b of this.buttons) b.classList.remove("active");
  },
};
for (const b of drawer.buttons) b.addEventListener("click", () => drawer.show(b.dataset.drawer));
$("drawer-close").addEventListener("click", () => drawer.close());
addEventListener("keydown", (e) => { if (e.key === "Escape") drawer.close(); });
// No drawer opens on load: the colony is the landing screen, panels are
// opt-in. (The chronicle lives permanently at the right edge, outside here.)

const claim = setupClaim({ scene, getWorld: () => world, refresh: () => poll(), openDrawer: (k) => drawer.show(k) });

// First-run coach-mark tour: auto-plays once the world is on screen, and the
// rail "?" replays it on demand. tourChecked keeps the 4s poll from restarting
// it every cycle before the visitor has dismissed it.
const tour = createTour();
$("btn-tour").addEventListener("click", () => tour.start());
let tourChecked = false;

// Volunteer compute: the shared research meter your own browser can feed.
const compute = setupCompute();

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
  // If a pinned specimen died or left the dish, release the pin so hover
  // peeking resumes instead of a card frozen on a ghost.
  if (pinnedId != null && !colonyView.agents.has(pinnedId)) {
    pinnedId = null; ui.card.classList.add("hidden");
  }
  pushChronicle(fresh);
  renderStats(w);
  renderCurve(w);
  claim.refresh(w, fresh);
  compute.update(w);

  ui.mode.textContent = `SHARED WORLD · ${w.stats.pop} souls · epoch ${w.epoch}`;
  ui.mode.classList.add("live");
  if (ui.loading && !ui.loading.removed) ui.loading.remove();
  if (!tourChecked) { tourChecked = true; tour.maybeAutoStart(); }
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
    else if (ev.type === "breakthrough") text = `distributed breakthrough — the crowd's compute fed the whole colony`;
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
  const statusColor = { Alive: "#4be3b0", Egg: "#b58cff", Quarantined: "#ff5470", Dead: "#94a3c4" }[a.status];
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
  g.strokeStyle = "rgba(111,215,255,0.08)";
  g.lineWidth = 1;
  for (const r of [0.25, 0.5, 0.75]) {
    g.beginPath(); g.moveTo(26, H - 18 - (H - 30) * r); g.lineTo(W - 8, H - 18 - (H - 30) * r); g.stroke();
  }
  const ft = new Map(w.firstTry);
  const gens = [...ft.keys()].sort((x, y) => x - y).filter((n) => n <= 8);
  if (!gens.length) return;
  const x = (i) => 26 + (W - 36) * (gens.length === 1 ? 0.5 : i / (gens.length - 1));
  const y = (r) => H - 18 - (H - 30) * r;
  g.fillStyle = "rgba(111,215,255,0.06)";
  g.fillRect(20, y(0.84), W - 28, y(0.45) - y(0.84));
  g.strokeStyle = "rgba(111,215,255,0.25)";
  g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(20, y(0.45)); g.lineTo(W - 8, y(0.45));
  g.moveTo(20, y(0.84)); g.lineTo(W - 8, y(0.84)); g.stroke();
  g.setLineDash([]);
  g.strokeStyle = "rgba(181,140,255,0.30)"; g.lineWidth = 5;
  g.beginPath();
  gens.forEach((gen, i) => {
    const f = ft.get(gen);
    const r = f.total ? f.wins / f.total : 0;
    i === 0 ? g.moveTo(x(i), y(r)) : g.lineTo(x(i), y(r));
  });
  g.stroke();
  g.strokeStyle = "#6fd7ff"; g.lineWidth = 1.5;
  g.stroke();
  g.fillStyle = "#bfe4ff";
  gens.forEach((gen, i) => {
    const f = ft.get(gen);
    const r = f.total ? f.wins / f.total : 0;
    g.beginPath(); g.arc(x(i), y(r), 2.4, 0, 7); g.fill();
    g.fillStyle = "#7488b5"; g.font = "8.5px 'JetBrains Mono', monospace";
    g.fillText("g" + gen, x(i) - 6, H - 5);
    g.fillStyle = "#bfe4ff";
  });
  g.fillStyle = "#7488b5"; g.font = "8.5px 'JetBrains Mono', monospace";
  g.fillText("PAPER 45–84%", W - 84, 12);
  g.fillText("0%", 4, H - 14);
  g.fillText("100%", 2, 24);
}

// ---------------------------------------------------------------------------
// Controls (world-clock driven: no local pause/speed/seed — the world is
// the world, and everyone watches the same one turn).
// ---------------------------------------------------------------------------

// Orbit toggle: turning it off also pauses the auto-framing dolly, otherwise
// #autoFit keeps moving the camera and the switch feels dead. Speed is high
// enough that once it IS on, the drift is unmistakable.
ui.rotate.addEventListener("click", () => {
  const on = !scene.controls.autoRotate;
  scene.setAutoRotate(on);
  ui.rotate.classList.toggle("off", !on);
});
setupKeeper();
// Legacy deep links land on the matching drawer tab.
if (location.hash === "#keeper") drawer.show("chain");
if (location.hash === "#about") drawer.show("paper");

// ---------------------------------------------------------------------------
// Boot: the shared world begins the instant the page opens.
// ---------------------------------------------------------------------------

poll();
setInterval(poll, POLL_MS);
