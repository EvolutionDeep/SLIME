// claim.js — the RPG layer: claim, feed, be seen.
//
// Everything a trader needs to go from "visitor" to "guardian" lives on the
// first screen: a persistent dock (your creatures, or one huge CTA), floating
// UNCLAIMED markers over unclaimed slimes in the 3D field, and a hall of
// guardians. Claims are a pre-chain registry (Worker KV) that migrates into
// on-chain guardianship when the program deploys — the UI says so honestly.
// All comments in English by project convention.

const LS_WALLET = "slime-wallet";
const MAX_MARKERS = 10;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (addr) => (addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : "—");
const isAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export function setupClaim(hooks) {
  const dock = $("dock");
  const modal = $("claim-modal");
  const markers = $("markers");
  const toast = $("toast");

  let wallet = localStorage.getItem(LS_WALLET) || "";
  let world = null;
  let busy = false;
  let prevMineIds = new Set();   // last frame's flock — the dead vanish from world.agents

  function say(msg, kind = "ok") {
    toast.textContent = msg;
    toast.className = "show " + kind;
    setTimeout(() => { toast.className = kind; }, 2600);
  }

  async function post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((x) => x.json().catch(() => ({})));
    return r;
  }

  // -------------------------------------------------------------------------
  // Wallet modal
  // -------------------------------------------------------------------------

  function openModal(prefillAgent) {
    $("modal-agent").textContent = prefillAgent != null ? `SLIME #${prefillAgent}` : "PICK A SLIME";
    modal.dataset.agent = prefillAgent != null ? String(prefillAgent) : "";
    $("wallet-modal-input").value = wallet;
    modal.classList.remove("hidden");
    setTimeout(() => $("wallet-modal-input").focus(), 50);
  }
  function closeModal() { modal.classList.add("hidden"); }

  $("btn-modal-cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  $("btn-modal-enter").addEventListener("click", async () => {
    const addr = $("wallet-modal-input").value.trim();
    if (!isAddr(addr)) { say("that is not a Solana address", "bad"); return; }
    wallet = addr;
    localStorage.setItem(LS_WALLET, addr);
    closeModal();
    renderDock();
    const agentId = modal.dataset.agent ? Number(modal.dataset.agent) : null;
    if (agentId != null) await doClaim(agentId);
    say("wallet linked — the world now knows who you are");
  });

  // -------------------------------------------------------------------------
  // Claim + feed actions
  // -------------------------------------------------------------------------

  async function doClaim(agentId) {
    if (busy) return;
    if (!wallet) { openModal(agentId); return; }
    busy = true;
    const r = await post("/api/claim", { address: wallet, agentId });
    busy = false;
    if (r.ok) {
      say(`⚔ slime #${agentId} is yours — keep it alive`);
      renderDock();
    } else {
      say(r.error ?? "claim failed", "bad");
    }
  }

  async function doFeed(agentId) {
    if (busy || !wallet) return;
    busy = true;
    const r = await post("/api/feed", { address: wallet, agentId });
    busy = false;
    if (r.ok) say(`fed slime #${agentId} — energy rising`);
    else say(r.error ?? "feed failed", "bad");
  }

  // Global delegation: report-card buttons live in app.js-rendered HTML.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-claim],[data-feed]");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.claim != null && b.dataset.claim !== "") doClaim(Number(b.dataset.claim));
    if (b.dataset.feed != null && b.dataset.feed !== "") doFeed(Number(b.dataset.feed));
  });

  /** HTML for the specimen report card CTA row (consumed by app.js). */
  function cardButton(a) {
    if (a.guardian === wallet && wallet) {
      return a.fedThisEpoch
        ? `<div class="rp-claim done">✓ you fed this slime this epoch</div>`
        : `<button class="rp-claim" data-feed="${a.id}">✦ FEED +10 ENERGY</button>`;
    }
    if (a.guardian) return `<div class="rp-claim taken">guardianship is taken — every unclaimed slime still has a ring</div>`;
    return `<button class="rp-claim" data-claim="${a.id}">⚔ CLAIM THIS SLIME</button>`;
  }

  // -------------------------------------------------------------------------
  // Dock: your creatures, or one giant invitation
  // -------------------------------------------------------------------------

  function mySlimes() {
    if (!world || !wallet) return [];
    return world.agents.filter((a) => a.guardian === wallet);
  }

  function renderDock() {
    if (!wallet) {
      dock.innerHTML = `
        <div class="dock-cta">
          <div class="dock-tag">pre-chain registry · migrates on-chain at deploy</div>
          <button id="btn-hero-claim" class="hero-claim">⚔ CLAIM YOUR SLIME</button>
          <div class="dock-sub">one wallet · one creature · keep it alive while the world watches</div>
        </div>`;
      $("btn-hero-claim").addEventListener("click", () => {
        // Claim the most dramatic unclaimed slime alive: lowest energy.
        const free = (world?.agents ?? []).filter((a) => !a.guardian && a.status === "Alive");
        free.sort((x, y) => x.energy - y.energy);
        openModal(free[0]?.id ?? null);
      });
    } else {
      const mine = mySlimes();
      const lb = (world?.leaderboard ?? []).slice(0, 6);
      dock.innerHTML = `
        <div class="dock-head">
          <span class="dock-you">YOUR CREATURES <b>${mine.length}</b> · guardian ${short(wallet)}
            <button class="dock-swap" id="btn-claim-more">+ claim more</button>
            <button class="dock-swap" id="btn-wallet-change">change wallet</button>
          </span>
          <span class="dock-lb">HALL OF GUARDIANS ${lb.map((l) => `${short(l.address)}×${l.slimes}`).join(" · ") || "empty throne"}</span>
        </div>
        <div class="dock-cards">
          ${mine.length ? mine.map((a) => creatureCard(a)).join("") :
            `<div class="dock-empty">nothing claimed yet — hover any glowing cell and press ⚔, or the world picks one for you
              <button class="hero-claim small" id="btn-pick">⚔ CLAIM ONE FOR ME</button></div>`}
        </div>`;
      $("btn-claim-more").addEventListener("click", () => openModal(null));
      $("btn-wallet-change").addEventListener("click", () => openModal(null));
      $("btn-pick")?.addEventListener("click", () => {
        const free = (world?.agents ?? []).filter((a) => !a.guardian && a.status === "Alive");
        free.sort((x, y) => x.energy - y.energy);
        if (free[0]) doClaim(free[0].id);
      });
    }
  }

  function creatureCard(a) {
    const pct = Math.max(0, Math.min(100, (a.energy / 160) * 100));
    const low = a.energy < 40 ? "low" : "";
    const cls = a.status === "Quarantined" ? "quar" : a.status === "Egg" ? "egg" : "";
    return `
      <div class="cr-card ${cls}">
        <div class="cr-top"><b>SLIME #${a.id}</b><span>gen ${a.gen}</span><span class="cr-status">${a.status}</span></div>
        <div class="cr-ebar"><i class="${low}" style="width:${pct}%"></i></div>
        <div class="cr-foot">
          <span>${a.energy}⚡ ${a.feeds ?? 0} feeds</span>
          ${a.fedThisEpoch ? `<span class="cr-fed">fed ✓</span>` :
            a.status === "Alive" ? `<button class="cr-feed" data-feed="${a.id}">FEED</button>` : ""}
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // UNCLAIMED markers floating over the 3D field
  // -------------------------------------------------------------------------

  let markerIds = [];
  function syncMarkers() {
    if (!world) return;
    const free = world.agents
      .filter((a) => !a.guardian && a.status === "Alive")
      .sort((x, y) => x.energy - y.energy)   // the dying ones ask the loudest
      .slice(0, MAX_MARKERS);
    markerIds = free.map((a) => a.id);
    markers.innerHTML = free.map((a) =>
      `<button class="slime-marker ${a.energy < 40 ? "faint" : ""}" data-mid="${a.id}">
        <span class="mk-diamond">◆</span><span class="mk-label">UNCLAIMED #${a.id}</span>
      </button>`).join("");
  }

  markers.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mid]");
    if (m) doClaim(Number(m.dataset.mid));
  });

  function followMarkers() {
    for (const el of markers.children) {
      const id = Number(el.dataset.mid);
      const p = hooks.scene.project(id);
      if (!p) { el.style.display = "none"; continue; }
      el.style.display = "";
      el.style.left = p.x + "px";
      el.style.top = p.y + "px";
    }
    requestAnimationFrame(followMarkers);
  }
  requestAnimationFrame(followMarkers);

  // -------------------------------------------------------------------------
  // Public surface used by app.js's poll loop
  // -------------------------------------------------------------------------

  function refresh(w, freshEvents) {
    world = w;
    renderDock();
    syncMarkers();
    if (w) {
      const mine = wallet ? w.agents.filter((a) => a.guardian === wallet) : [];
      const mineIds = new Set(mine.map((a) => a.id));
      // A slime you guarded just died? The world should tell you loudly.
      if (wallet) {
        for (const ev of freshEvents) {
          if (ev.type === "death" && prevMineIds.has(ev.agent) && !mineIds.has(ev.agent)) {
            say(`☠ your slime #${ev.agent} just died — claim another before the void does`, "bad");
          }
        }
      }
      prevMineIds = mineIds;
    }
  }

  refresh(null, []);
  return { refresh, cardButton };
}
