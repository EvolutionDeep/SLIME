// tour.js — a calm, step-by-step coach-mark walkthrough for first-time visitors.
//
// The problem it solves: a newcomer lands on a drifting field of glowing cells
// with a rail of cryptic icons and a gold button, and has no idea what any of
// it means or how to play. The tour spotlights ONE real UI region at a time and
// dims the rest, narrating in the project's voice — the science story (the
// Anthropic self-replication finding rendered as a shared sandbox), never a
// gaudy modal that would wall off the living colony behind it.
//
// Auto-plays once per browser (localStorage), replayable from the rail "?".
// All comments in English by project convention.

const LS_TOUR = "slime-tour-done";
const PAD = 10;      // spotlight breathing room around the target
const GAP = 18;      // card-to-target gap
const M = 12;        // viewport margin

// Each step: an optional target selector (null => centred card over the scene),
// an optional fallback if the primary is hidden, and the science-narrative copy.
const STEPS = [
  { sel: null, title: "A colony that keeps itself alive",
    body: "SLIME turns the Anthropic Frontier Red Team finding — that a model could self-replicate without a datacenter — into something you can watch: digital organisms that bud, adapt and starve on one shared clock. No exploits, no weights. Just evolution, and one creature you can keep." },
  { sel: null, title: "The dish",
    body: "Every glowing cell is one agent: colour marks its family, brightness its capability. They bud children, burn energy, and die — and every visitor is watching the exact same colony at the same epoch. Hover a cell to read its vitals, click to pin its card, drag to orbit, scroll to zoom." },
  { sel: ".rail", title: "Instruments",
    body: "The rail opens one panel at a time: world telemetry, the learning curve from the paper, your guardianship, the on-chain ledger, and the source note. Press ESC to give the screen back." },
  { sel: "#chronicle", title: "The chronicle",
    body: "The world's live log — every birth, death and blue-team quarantine, stamped with its epoch. It is the record of this run, not a feed of noise." },
  { sel: "#hero", fallback: '.rail-btn[data-drawer="guardian"]', title: "Become a guardian",
    body: "Adopt one slime as its guardian: one wallet, one creature. Once per epoch you can feed it +10 energy to keep it alive — or send it into the Pit to gamble capability against the host's size ceiling." },
  { sel: null, title: "That's the whole idea",
    body: "The colony is live and shared, and nothing here is a real network action — it is sandbox math you can steer. Press ? in the rail any time to replay this tour." },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createTour() {
  let root, spot, card, idx = 0, open = false;

  function ensure() {
    if (root) return;
    root = document.createElement("div");
    root.className = "tour";
    root.innerHTML =
      `<div class="tour-spot"></div>` +
      `<div class="tour-card" role="dialog" aria-modal="true">` +
        `<h3 class="tour-title"></h3>` +
        `<p class="tour-body"></p>` +
        `<div class="tour-foot">` +
          `<span class="tour-count"></span>` +
          `<div class="tour-nav">` +
            `<button class="tour-skip" type="button">skip</button>` +
            `<button class="tour-back" type="button">back</button>` +
            `<button class="tour-next primary" type="button">next</button>` +
          `</div>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(root);
    spot = root.querySelector(".tour-spot");
    card = root.querySelector(".tour-card");
    root.querySelector(".tour-skip").addEventListener("click", close);
    root.querySelector(".tour-back").addEventListener("click", () => go(idx - 1));
    root.querySelector(".tour-next").addEventListener("click", () => go(idx + 1));
    // Clicking the dimmed backdrop (not the card) dismisses the tour.
    root.addEventListener("click", (e) => { if (e.target === root) close(); });
    addEventListener("keydown", onKey);
    addEventListener("resize", () => { if (open) render(); });
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" || e.key === "Enter") go(idx + 1);
    else if (e.key === "ArrowLeft") go(idx - 1);
  }

  function rectOf(sel) {
    if (!sel) return null;
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // A hidden (zero-size) element must not become a broken box.
    if (r.width < 2 || r.height < 2) return null;
    return r;
  }

  // Spotlight the primary target; if it is missing OR currently hidden (e.g. the
  // hero CTA is gone once a wallet is linked), fall back to its visible sibling.
  function targetRect(step) {
    return rectOf(step.sel) || rectOf(step.fallback);
  }

  function go(n) {
    if (n < 0) return;
    if (n >= STEPS.length) { close(); return; }
    idx = n;
    render();
  }

  function render() {
    const step = STEPS[idx];
    root.querySelector(".tour-title").textContent = step.title;
    root.querySelector(".tour-body").textContent = step.body;
    root.querySelector(".tour-count").textContent = `${idx + 1} / ${STEPS.length}`;
    root.querySelector(".tour-back").style.visibility = idx === 0 ? "hidden" : "visible";
    root.querySelector(".tour-next").textContent = idx === STEPS.length - 1 ? "start exploring" : "next";

    const rect = targetRect(step);
    const vw = innerWidth, vh = innerHeight;

    if (!rect) {
      // Centred step: collapse the spotlight to a point (its huge box-shadow
      // still dims the whole frame) and float the card over the live colony.
      root.classList.add("centered");
      spot.style.left = `${vw / 2}px`; spot.style.top = `${vh / 2}px`;
      spot.style.width = "0px"; spot.style.height = "0px";
      card.style.left = `${vw / 2}px`; card.style.top = `${vh / 2}px`;
      card.style.transform = "translate(-50%, -50%)";
      return;
    }

    root.classList.remove("centered");
    spot.style.left = `${rect.left - PAD}px`;
    spot.style.top = `${rect.top - PAD}px`;
    spot.style.width = `${rect.width + PAD * 2}px`;
    spot.style.height = `${rect.height + PAD * 2}px`;

    // Drop the card on whichever side has the most room, clamped on-screen.
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x, y;
    if (rect.bottom + GAP + ch < vh - M) { x = rect.left + rect.width / 2 - cw / 2; y = rect.bottom + GAP; }
    else if (rect.top - GAP - ch > M) { x = rect.left + rect.width / 2 - cw / 2; y = rect.top - GAP - ch; }
    else if (rect.right + GAP + cw < vw - M) { x = rect.right + GAP; y = rect.top; }
    else { x = rect.left - GAP - cw; y = rect.top; }
    card.style.left = `${clamp(x, M, vw - cw - M)}px`;
    card.style.top = `${clamp(y, M, vh - ch - M)}px`;
    card.style.transform = "none";
  }

  function start(at = 0) {
    ensure();
    open = true;
    idx = clamp(at, 0, STEPS.length - 1);
    root.classList.add("on");
    render();
  }

  function close() {
    open = false;
    localStorage.setItem(LS_TOUR, "1");
    if (root) root.classList.remove("on");
  }

  // First visit only; every later load stays out of the way. A `?tour=N` link
  // (1-based) opens straight to that step regardless — handy for shareable
  // "start here" pointers and for headless verification of a specific spotlight.
  function maybeAutoStart() {
    const q = new URL(location.href).searchParams.get("tour");
    if (q != null) { start((parseInt(q, 10) || 1) - 1); return; }
    if (localStorage.getItem(LS_TOUR)) return;
    start();
  }

  return { start, maybeAutoStart };
}
