// compute.js — volunteer compute: your browser lends CPU to the shared
// research meter.
//
// Real but light: a background Web Worker (pow-worker.js) grinds the epoch's
// proof-of-work; each solution is submitted to /api/contribute where the Worker
// verifies it in O(1). The effort is opt-in (never burn a visitor's CPU without
// asking), auto-pauses when the tab is hidden, and stops when this device hits
// its per-epoch share so one machine can't carry the whole colony. A full meter
// fires a colony-wide breakthrough.

const LS_SESSION = "slime-session";
const LS_COMPUTE = "slime-compute-on";
const LS_TOTAL = "slime-compute-total";

function sessionId() {
  let s = localStorage.getItem(LS_SESSION);
  if (!s) {
    s = (self.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) + "-v";
    localStorage.setItem(LS_SESSION, s);
  }
  return s;
}

const fmtHps = (n) => {
  if (!n || n < 1000) return `${Math.round(n || 0)} h/s`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} kH/s`;
  return `${(n / 1e6).toFixed(2)} MH/s`;
};

export function setupCompute() {
  const el = (id) => document.getElementById(id);
  const toggle = el("compute-toggle");
  const fill = el("compute-fill");
  const num = el("compute-num");
  const youEl = el("compute-you");
  const rateEl = el("compute-rate");
  const contribEl = el("compute-contrib");
  const btEl = el("compute-breakthroughs");
  const noteEl = el("compute-note");
  const badge = el("compute-badge");
  const railBtn = el("btn-compute");
  const toastEl = el("toast");

  const sid = sessionId();
  let enabled = localStorage.getItem(LS_COMPUTE) === "1";
  // A ?compute=1 link can start the lending for you (shareable "help the colony"
  // entry point); it persists so a reload keeps contributing.
  if (new URL(location.href).searchParams.get("compute") === "1") {
    enabled = true; localStorage.setItem(LS_COMPUTE, "1");
  }
  let worker = null, jobId = 0, job = null, inFlight = false;
  let latest = null;
  let myCredited = 0;
  let youTotal = Number(localStorage.getItem(LS_TOTAL) || 0);

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 4200);
  }

  function spawnWorker() {
    if (worker) return;
    worker = new Worker("/js/pow-worker.js");
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === "progress") { if (rateEl) rateEl.textContent = fmtHps(d.hps); return; }
      if (d.type === "solved" && job && d.id === job.id) {
        const ch = job.challenge; job = null;
        submit(ch, d.nonce);
      }
    };
  }
  function killWorker() { if (worker) { worker.terminate(); worker = null; } job = null; }

  function start() {
    if (!enabled || document.hidden || !latest) return;
    if (inFlight || job) return;
    if (latest.progress >= latest.goal) return;            // bar full, await rollover
    if (myCredited >= latest.perDeviceCap) return;         // this device has done its share
    spawnWorker();
    jobId += 1;
    job = { id: jobId, challenge: latest.challenge };
    worker.postMessage({ id: jobId, challenge: latest.challenge, difficulty: latest.difficulty });
  }

  async function submit(challenge, nonce) {
    inFlight = true;
    try {
      const res = await fetch("/api/contribute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge, nonce, sessionId: sid }),
      });
      const r = await res.json();
      if (r.ok) {
        youTotal += 1; localStorage.setItem(LS_TOTAL, String(youTotal));
        myCredited = r.credited ?? myCredited + 1;
        if (latest) latest.progress = r.progress;
        if (r.boon) {
          toast("distributed breakthrough — the colony is fed by your compute");
          if (railBtn) { railBtn.classList.add("pulse"); setTimeout(() => railBtn.classList.remove("pulse"), 5000); }
        }
      } else if (/device limit/.test(r.error || "")) {
        if (latest) myCredited = latest.perDeviceCap;
      }
      // stale/invalid: just wait for the next poll to hand us a fresh challenge.
    } catch { /* offline — retry on the next cycle */ }
    inFlight = false;
    render();
    if (enabled && !document.hidden) setTimeout(start, 150);
  }

  // Called by app.js on every world poll with the raw /api/world payload.
  function update(w) {
    const prev = latest;
    latest = w.research || null;
    if (!latest) return;
    if (!prev || latest.epoch !== prev.epoch) myCredited = 0;   // new epoch resets the share
    render();
    if (enabled && !document.hidden) start();
  }

  function render() {
    if (toggle) {
      toggle.classList.toggle("on", enabled);
      const label = toggle.querySelector("span");
      if (label) label.textContent = enabled ? "lending your compute" : "lend compute";
    }
    if (latest) {
      const pct = latest.goal ? Math.min(100, (latest.progress / latest.goal) * 100) : 0;
      if (fill) fill.style.width = pct + "%";
      if (num) num.textContent = `${latest.progress} / ${latest.goal}`;
      if (contribEl) contribEl.textContent = latest.contributors;
      if (btEl) btEl.textContent = latest.breakthroughs;
      if (badge) { badge.textContent = Math.round(pct) + "%"; badge.classList.remove("hidden"); }
    }
    if (youEl) youEl.textContent = youTotal;
    if (!enabled && rateEl) rateEl.textContent = "—";
    if (noteEl) {
      if (!enabled) noteEl.textContent = "off — your device is idle";
      else if (document.hidden) noteEl.textContent = "paused — tab in the background";
      else if (latest && latest.progress >= latest.goal) noteEl.textContent = "goal reached — the meter resets next epoch";
      else if (latest && myCredited >= latest.perDeviceCap) noteEl.textContent = `you've given ${myCredited}/${latest.perDeviceCap} this epoch — let other devices help`;
      else noteEl.textContent = "solving — your CPU is feeding the colony";
    }
  }

  function setEnabled(on) {
    enabled = on;
    localStorage.setItem(LS_COMPUTE, on ? "1" : "0");
    if (on) start(); else killWorker();
    render();
  }

  toggle?.addEventListener("click", () => setEnabled(!enabled));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) killWorker();
    else if (enabled) start();
  });
  render();

  return { update };
}
