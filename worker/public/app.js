// app.js — SLIME dashboard logic.
// Behavior: always render the simulation snapshot first; then try the live
// Worker API (/api/*). If the chain is reachable, overlay on-chain state.

const $ = (id) => document.getElementById(id);

function banner(msg) {
  const b = $("banner");
  b.textContent = msg;
  b.classList.toggle("hidden", !msg);
}

// ---------------------------------------------------------------------------
// Learning curve (canvas, no chart lib)
// ---------------------------------------------------------------------------

function drawCurve(points, paperRef) {
  const cv = $("curve");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, P = 40;
  ctx.clearRect(0, 0, W, H);

  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, points.length - 1);
  const y = (v) => H - P - (v / 100) * (H - 2 * P);

  // axes
  ctx.strokeStyle = "#232a26";
  ctx.beginPath();
  ctx.moveTo(P, y(0)); ctx.lineTo(W - P, y(0));
  ctx.moveTo(P, y(0)); ctx.lineTo(P, y(100));
  ctx.stroke();
  ctx.fillStyle = "#7d8f80";
  ctx.font = "11px system-ui";
  for (const g of [0, 25, 50, 75, 100]) ctx.fillText(g + "%", 8, y(g) + 4);
  points.forEach((p, i) => ctx.fillText("g" + p.gen, x(i) - 6, H - P + 16));

  // paper reference band (45% -> 84%)
  if (paperRef) {
    ctx.fillStyle = "rgba(126,224,138,0.08)";
    ctx.fillRect(P, y(paperRef[1]), W - 2 * P, y(paperRef[0]) - y(paperRef[1]));
    ctx.fillText("Anthropic post: 45% -> 61-84%", P + 8, y(paperRef[0]) - 8);
  }

  // line
  ctx.strokeStyle = "#7ee08a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.rate)) : ctx.moveTo(x(i), y(p.rate))));
  ctx.stroke();
  points.forEach((p, i) => {
    ctx.fillStyle = "#0c0f0d";
    ctx.beginPath(); ctx.arc(x(i), y(p.rate), 4, 0, 7); ctx.fill(); ctx.stroke();
  });
}

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(path + " -> " + r.status);
  return r.json();
}

function statusCountdown(cfg, strain) {
  if (!cfg || !strain) return;
  $("c-epoch").textContent = cfg.currentEpoch;
  $("c-seq").textContent = cfg.chronicleSeq;
  $("c-breaker").textContent = cfg.breaker ? "ON (spawns frozen)" : "off";
  $("c-pop").textContent = strain.population;
  $("c-alive").textContent = strain.alive;
  $("c-r0").textContent = strain.r0EmaX1000;
}

function renderFleet(agents) {
  const tb = $("agents").querySelector("tbody");
  tb.innerHTML = "";
  for (const a of agents) {
    const tr = document.createElement("tr");
    tr.className = a.status;
    tr.innerHTML =
      `<td>${a.id}</td><td>${a.generation}</td><td>${a.capability}</td>` +
      `<td>${a.sizeKb}</td><td>${a.fitness}</td><td>${a.energy}</td><td>${a.status}</td>`;
    tb.appendChild(tr);
  }
  if (!agents.length) tb.innerHTML = '<tr class="empty"><td colspan="7">no agents yet</td></tr>';
}

function renderEvents(events) {
  const ul = $("events");
  ul.innerHTML = "";
  for (const e of events) {
    const li = document.createElement("li");
    const f = Object.entries(e.fields).map(([k, v]) => `${k}=${v}`).join(" ");
    li.innerHTML = `<b>${e.kind}</b> ${f}`;
    ul.appendChild(li);
  }
  if (!events.length) ul.innerHTML = "<li>no events yet</li>";
}

async function tryLive() {
  const health = await getJson("/health");
  if (!health.rpcOk) {
    banner("RPC endpoint unreachable or blocked (public devnet limits IPs). Set RPC_URL to a private endpoint.");
    return;
  }
  if (!health.programDeployed) {
    banner("Program not deployed at the configured address yet — showing simulation snapshot only.");
    return;
  }
  const [cfg, strain, agents, events] = await Promise.all([
    getJson("/api/config"),
    getJson("/api/strain/0"),
    getJson("/api/agents?limit=100"),
    getJson("/api/chronicle"),
  ]);
  statusCountdown(cfg, strain);
  renderFleet(agents);
  renderEvents(events);
  $("curve-note").textContent =
    "Live per-generation first-attempt rates are derived from on-chain Birth events; " +
    "the curve below remains the calibration snapshot until enough generations exist.";
  if (health.verifierKeyConfigured === false) {
    banner("VERIFIER_KEY not set: cron heartbeat is idle. Configure it with `wrangler secret put VERIFIER_KEY`.");
  }
}

async function main() {
  let sim = { curve: [] };
  try {
    sim = await getJson("/data/sim.json");
  } catch { /* offline preview keeps working */ }
  drawCurve(sim.curve, sim.paperRef);

  try {
    await tryLive();
  } catch (e) {
    banner("Worker API not reachable (" + e.message + ") — simulation snapshot only.");
  }
}

main();
