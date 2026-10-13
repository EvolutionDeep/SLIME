// keeper.js — "My Slimes" cockpit: the holder-side of the colony.
// Reads /api/my/:address (guarded agents, bets, fossils, named generations)
// and renders the keeper economy surface. All comments in English.

const $ = (id) => document.getElementById(id);

const ui = {
  body: $("keeper-body"),
  input: $("wallet-input"),
  lookup: $("btn-lookup"),
};

let currentAddr = null;
let refreshTimer = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const short = (a) => (a.length > 10 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a);

function energyBar(energy) {
  const pct = Math.max(2, Math.min(100, energy));
  const cls = energy <= 10 ? "low" : energy <= 30 ? "mid" : "";
  return `<div class="ebar"><div class="ebar-fill ${cls}" style="width:${pct}%"></div></div>`;
}

function section(title, inner) {
  return `<h3>${title}</h3>${inner}`;
}

function guardedCard(a) {
  const statusCls = a.status === "Dead" ? "dead" : a.status === "Quarantined" ? "quar" : "";
  return `
  <div class="k-card ${statusCls}">
    <div class="k-head"><b>#${a.id}</b> <span class="k-gen">gen ${a.generation}</span>
      <span class="k-status">${esc(a.status)}</span></div>
    ${energyBar(a.energy)}
    <div class="k-stats">
      <span>cap ${a.capability}</span><span>${a.sizeKb} KB</span>
      <span>fit ${a.fitness}</span><span>${a.wins}W/${a.losses}L</span>
      <span>fed ×${a.feeds}</span>
    </div>
    ${a.potion ? `<div class="k-potion">potion armed · next birth ±25%</div>` : ""}
    <div class="k-actions">
      <button class="k-btn" disabled title="live once the token is deployed and a wallet signs">feed</button>
      <button class="k-btn" disabled title="burn to widen the next mutation">potion</button>
      <button class="k-btn" disabled title="burn to appeal a quarantine">appeal</button>
    </div>
  </div>`;
}

function betRow(b) {
  let outcome = "pending";
  if (b.market && b.market.settled) {
    const w = b.market.winner;
    outcome = w === 0 ? "void · refund"
      : (w === 1) === b.over ? "won"
      : "lost";
  }
  const cls = outcome === "won" ? "won" : outcome === "lost" ? "lost" : "";
  return `<div class="k-bet ${cls}">
    <span class="k-epoch">e${b.epoch}</span>
    <span class="k-side">${b.over ? "R₀ &gt; 1" : "R₀ ≤ 1"}</span>
    <span class="k-amt">${(b.amount / 1e6).toLocaleString()}</span>
    <span class="k-out">${b.claimed ? "claimed" : outcome}</span>
  </div>`;
}

function render(data) {
  const g = data.guarded ?? [];
  const bets = data.bets ?? [];
  const f = data.fossils ?? [];
  const n = data.namedGenerations ?? [];
  const tokenState = data.tokenConfigured
    ? `<span class="k-live">token live</span>`
    : `<span class="k-dark">token not registered yet</span>`;
  ui.body.innerHTML = `
    <p class="k-summary">guarding <b>${g.length}</b> · bets <b>${bets.length}</b> ·
      fossils <b>${f.length}</b> · named gens <b>${n.length}</b> ${tokenState}</p>
    ${section("my slimes", g.length
      ? `<div class="k-grid">${g.map(guardedCard).join("")}</div>`
      : `<p class="muted empty">no slime bears your mark yet. once live, the first wallet to feed an agent becomes its guardian forever — be early, be famous, or be the one who kept it alive.</p>`)}
    ${section("my tickets", bets.length
      ? bets.map(betRow).join("")
      : `<p class="muted empty">no R₀ bets. every epoch the colony is either growing or dying — pick a side, the chronicle is the oracle.</p>`)}
    ${section("my fossils", f.length
      ? f.map((x) => `<div class="k-bet"><span class="k-epoch">e${x.mintedEpoch}</span><span class="k-side">agent #${x.agentId}</span><span class="k-amt">gen ${x.generation} · ${x.wins}W</span></div>`).join("")
      : `<p class="muted empty">you have not memorialized anyone. legends and infamous dead deserve a stone with your wallet on the plaque.</p>`)}
    ${section("generations I named", n.length
      ? n.map((x) => `<div class="k-bet"><span class="k-epoch">gen ${x.generation}</span><span class="k-side">“${esc(x.name)}”</span><span class="k-amt">hero #${x.heroAgent}</span></div>`).join("")
      : `<p class="muted empty">no generation carries your words yet. guard an agent of a generation, and its name is yours to choose — once, forever.</p>`)}
  `;
}

async function lookup(addr) {
  addr = (addr || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    ui.body.innerHTML = `<p class="muted empty">that is not a Solana address.</p>`;
    return;
  }
  currentAddr = addr;
  localStorage.setItem("slime.wallet", addr);
  ui.body.innerHTML = `<p class="muted empty">scanning the chain for ${esc(short(addr))}…</p>`;
  try {
    const res = await fetch(`/api/my/${addr}`);
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch {
    ui.body.innerHTML = `<p class="muted empty">keeper data unavailable — the colony is still in sandbox twin mode.
      the cockpit arms itself the moment the program + community token go live on devnet.</p>`;
  }
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => lookup(currentAddr), 30000);
}

export function setupKeeper() {
  ui.lookup.addEventListener("click", () => lookup(ui.input.value));
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") lookup(ui.input.value);
  });
  const saved = localStorage.getItem("slime.wallet");
  if (saved) {
    ui.input.value = saved;
    // Prefill only; the keeper chooses when to open the ledger eyes.
  }
}
