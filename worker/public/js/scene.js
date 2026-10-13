// scene.js 鈥?Three.js rendering of the SLIME colony.
//
// Visual language straight from the Anthropic post: a bioluminescent mold
// colony spreading inside a dark containment vessel. One glowing blob per
// agent: size = genome footprint, hue = capability, halo = energy,
// red cage ring = quarantined, purple dormant = egg. Parent-child mycelial
// filaments draw the lineage. Particle bursts mark births, hatchings,
// deaths and blue-team quarantine sweeps.
//
// All comments in English by project convention.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STATUS } from "./engine.js";

const COLOR = {
  aliveLow: new THREE.Color("#2dd4a7"),   // low capability: deep green
  aliveHigh: new THREE.Color("#7df9ff"),  // high capability: electric cyan
  egg: new THREE.Color("#b58cff"),        // dormant violet
  quarantined: new THREE.Color("#ff5470"),// alarm red
  dead: new THREE.Color("#37413f"),
  edge: new THREE.Color("#1a6e5a"),
  edgeBright: new THREE.Color("#aef7ff"),
};

function agentColor(a) {
  if (a.status === STATUS.Egg) return COLOR.egg;
  if (a.status === STATUS.Quarantined) return COLOR.quarantined;
  if (a.status === STATUS.Dead) return COLOR.dead;
  const t = Math.min(1, Math.max(0, (a.genome.capability - 1100) / 900));
  return COLOR.aliveLow.clone().lerp(COLOR.aliveHigh, t);
}

// Deterministic per-agent jitter so layout never flickers between frames.
function hashRand(seed) {
  let a = (seed * 0x9e3779b9 + 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Radial-gradient sprite texture for the glow halos.
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.28)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

export class ColonyScene {
  tweenTarget = null;

  constructor(container) {
    this.hovered = null;
    this.tweenTarget = null;
    this.container = container;
    this.posMap = new Map();      // agent id -> Vector3
    this.visuals = new Map();     // agent id -> {core, halo, ring, fade}
    this.bursts = [];             // particle systems in flight
    this.hoverCb = null;
    this.selectCb = null;
    this.selected = null;
    this.time = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#04070a");
    scene.fog = new THREE.FogExp2(0x04070a, 0.0034);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(
      55, container.clientWidth / container.clientHeight, 0.1, 1200,
    );
    camera.position.set(0, 55, 150);
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.minDistance = 16;
    controls.maxDistance = 300;
    this.controls = controls;

    scene.add(new THREE.AmbientLight(0x223344, 1.4));
    const p1 = new THREE.PointLight(0x35ffc3, 1.1, 400); p1.position.set(60, 90, 60);
    const p2 = new THREE.PointLight(0x7a5cff, 0.7, 400); p2.position.set(-80, -40, -60);
    scene.add(p1, p2);

    // Containment vessel: faint geodesic shell, like looking through glass.
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(150, 2),
      new THREE.MeshBasicMaterial({
        color: 0x2b6b5a, wireframe: true, transparent: true, opacity: 0.05,
      }),
    );
    scene.add(shell);
    const innerGlow = new THREE.Mesh(
      new THREE.SphereGeometry(148, 24, 18),
      new THREE.MeshBasicMaterial({
        color: 0x062b23, transparent: true, opacity: 0.14, side: THREE.BackSide,
      }),
    );
    scene.add(innerGlow);

    // Starfield specks (dust in the incubator).
    {
      const n = 1100;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const r = 180 + Math.random() * 320;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      scene.add(new THREE.Points(g, new THREE.PointsMaterial({
        color: 0x3d6b5f, size: 0.9, transparent: true, opacity: 0.5,
        depthWrite: false, sizeAttenuation: true,
      })));
    }

    // Mycelial lineage lines (rebuilt each epoch, preallocated buffers).
    this.maxEdges = 600;
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 6), 3));
    edgeGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 6), 3));
    this.edgeGeo = edgeGeo;
    scene.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false,
    })));

    // Highlighted ancestry chain of the selected agent.
    this.chainLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xaef7ff, transparent: true, opacity: 0.95 }),
    );
    this.chainLine.visible = false;
    scene.add(this.chainLine);

    this.glowTex = glowTexture();
    this.coreGeo = new THREE.SphereGeometry(1, 20, 16);

    // Pointer interaction.
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-2, -2);
    renderer.domElement.addEventListener("pointermove", (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    renderer.domElement.addEventListener("click", () => {
      if (this.selectCb) this.selectCb(this.hovered ?? null);
    });

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#startLoop();
  }

  onHover(cb) { this.hoverCb = cb; }
  onSelect(cb) { this.selectCb = cb; }

  /** Drop all colony visuals for a fresh population. */
  reset() {
    for (const v of this.visuals.values()) {
      this.scene.remove(v.group);
      v.core.material.dispose();
      v.halo.material.dispose();
    }
    this.visuals.clear();
    this.posMap.clear();
    this.chainLine.visible = false;
    this.selected = null;
    this.hovered = null;
  }

  setAutoRotate(on) { this.controls.autoRotate = on; }

  /** Focus the camera on one agent and highlight its ancestry chain. */
  focus(agentId, colony) {
    this.selected = agentId;
    if (agentId == null) { this.chainLine.visible = false; return; }
    const chain = [];
    let cur = colony.agents.get(agentId);
    while (cur) {
      chain.push(this.#position(cur.id, cur));
      cur = cur.parent != null ? colony.agents.get(cur.parent) : null;
    }
    const pts = chain.reverse();
    this.chainLine.geometry.setFromPoints(pts);
    this.chainLine.visible = pts.length > 1;
    if (pts.length) {
      const target = pts[pts.length - 1].clone();
      this.tweenTarget = target;
    }
  }

  /** Consume the events emitted by Colony.tick() for visual effects. */
  handleEvents(events, colony) {
    for (const ev of events) {
      const a = ev.agent != null ? colony.agents.get(ev.agent) : null;
      const pos = a ? this.#position(a.id, a) : null;
      if (ev.type === "birth" && pos) this.#burst(pos, 0x35ffc3, 16, 1.3);
      else if (ev.type === "hatch" && pos) this.#burst(pos, 0xb58cff, 10, 0.9);
      else if (ev.type === "death" && pos) this.#burst(pos, 0xff5470, 12, 1.0);
      else if (ev.type === "quarantine" && pos) this.#burst(pos, 0xff2244, 26, 1.8);
      else if (ev.type === "attempt" && ev.ok && pos && Math.random() < 0.35) {
        this.#burst(pos, 0x9dffe0, 4, 0.5); // subtle solve spark, rate-limited
      }
    }
  }

  /** Full reconciliation of visuals against colony state. */
  sync(colony) {
    const seen = new Set();
    for (const a of colony.agents.values()) {
      if (a.status === STATUS.Dead) continue;
      seen.add(a.id);
      let v = this.visuals.get(a.id);
      const col = agentColor(a);
      if (!v) {
        const core = new THREE.Mesh(this.coreGeo, new THREE.MeshBasicMaterial({ color: col }));
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTex, color: col, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        const group = new THREE.Group();
        group.add(halo, core);
        this.scene.add(group);
        v = { group, core, halo, ring: null, fade: 1 };
        this.visuals.set(a.id, v);
      }
      const base = 0.9 + Math.min(2.4, a.genome.size_kb / 1400);
      const pulse = a.status === STATUS.Egg
        ? 0.85 + 0.15 * Math.sin(this.time * 2 + a.id)
        : 1;
      v.core.scale.setScalar(base * pulse);
      v.core.material.color.copy(col);
      v.halo.scale.setScalar(base * 5.2);
      v.halo.material.color.copy(col);
      v.halo.material.opacity = a.status === STATUS.Egg
        ? 0.25
        : Math.min(0.95, 0.2 + a.energy / 160);
      v.pos = this.#position(a.id, a);
      v.group.position.copy(v.pos);
      // Quarantine cage ring.
      if (a.status === STATUS.Quarantined && !v.ring) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(base * 1.9, 0.12, 8, 40),
          new THREE.MeshBasicMaterial({ color: 0xff5470, transparent: true, opacity: 0.9 }),
        );
        v.group.add(ring);
        v.ring = ring;
      } else if (a.status !== STATUS.Quarantined && v.ring) {
        v.group.remove(v.ring);
        v.ring.geometry.dispose(); v.ring.material.dispose();
        v.ring = null;
      }
      if (v.ring) {
        v.ring.rotation.x = this.time * 1.7 + a.id;
        v.ring.rotation.y = this.time * 1.1;
        v.ring.material.opacity = 0.55 + 0.4 * Math.sin(this.time * 5);
      }
    }
    // Fade out visuals of agents that just died.
    for (const [id, v] of this.visuals) {
      if (!seen.has(id) && v.fade > 0) v.dying = true;
    }
    this.#rebuildEdges(colony);
    this.#followCentroid(colony);
  }

  /** Keep the colony centered: gently drag the orbit target to the centroid. */
  #followCentroid(colony) {
    // A user-selected agent holds the camera instead.
    if (this.selected != null) {
      const p = this.posMap.get(this.selected);
      if (p) { this.tweenTarget = p.clone(); return; }
      this.selected = null;
    }
    let n = 0;
    const sum = new THREE.Vector3();
    for (const a of colony.agents.values()) {
      if (a.status === STATUS.Dead) continue;
      const p = this.posMap.get(a.id);
      if (!p) continue;
      sum.add(p);
      n++;
    }
    if (n > 0) this.tweenTarget = sum.multiplyScalar(1 / n);
  }

  // -------------------------------------------------------------------------

  #position(id, a) {
    let p = this.posMap.get(id);
    if (p) return p;
    if (a.parent == null) {
      p = new THREE.Vector3(0, 0, 0);
    } else {
      const parentPos = this.posMap.get(a.parent) ?? new THREE.Vector3(0, 0, 0);
      if (!this.posMap.has(a.parent)) this.posMap.set(a.parent, parentPos);
      const r = hashRand(id * 7919 + 17);
      // Random direction on the sphere, flattened vertically (mold spreads).
      const th = r() * Math.PI * 2;
      const ph = Math.acos(2 * r() - 1);
      const dist = 15 + a.gen * 3 + r() * 9;
      p = new THREE.Vector3(
        parentPos.x + dist * Math.sin(ph) * Math.cos(th),
        parentPos.y + dist * Math.cos(ph) * 0.45,
        parentPos.z + dist * Math.sin(ph) * Math.sin(th),
      );
    }
    this.posMap.set(id, p);
    return p;
  }

  #rebuildEdges(colony) {
    const pos = this.edgeGeo.attributes.position.array;
    const col = this.edgeGeo.attributes.color.array;
    let w = 0;
    for (const a of colony.agents.values()) {
      if (a.parent == null || a.status === STATUS.Dead) continue;
      const p = this.posMap.get(a.parent);
      const c = this.posMap.get(a.id);
      const pa = colony.agents.get(a.parent);
      if (!p || !c || !pa || pa.status === STATUS.Dead) continue;
      if (w >= this.maxEdges) break;
      pos[w * 6] = p.x; pos[w * 6 + 1] = p.y; pos[w * 6 + 2] = p.z;
      pos[w * 6 + 3] = c.x; pos[w * 6 + 4] = c.y; pos[w * 6 + 5] = c.z;
      const pc = agentColor(pa), cc = agentColor(a);
      col[w * 6] = pc.r; col[w * 6 + 1] = pc.g; col[w * 6 + 2] = pc.b;
      col[w * 6 + 3] = cc.r * 0.7; col[w * 6 + 4] = cc.g * 0.7; col[w * 6 + 5] = cc.b * 0.7;
      w++;
    }
    this.edgeGeo.setDrawRange(0, w * 2);
    this.edgeGeo.attributes.position.needsUpdate = true;
    this.edgeGeo.attributes.color.needsUpdate = true;
  }

  #burst(point, colorHex, count, power) {
    const pos = new Float32Array(count * 3);
    const vel = [];
    for (let i = 0; i < count; i++) {
      pos[i * 3] = point.x; pos[i * 3 + 1] = point.y; pos[i * 3 + 2] = point.z;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const s = (0.6 + Math.random()) * 6 * power;
      vel.push(new THREE.Vector3(
        s * Math.sin(ph) * Math.cos(th), s * Math.cos(ph), s * Math.sin(ph) * Math.sin(th),
      ));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color: colorHex, size: 1.6 * power, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pts = new THREE.Points(g, m);
    this.scene.add(pts);
    this.bursts.push({ pts, vel, life: 1.1, age: 0 });
  }

  #stepBursts(dt) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.age += dt;
      const arr = b.pts.geometry.attributes.position.array;
      for (let j = 0; j < b.vel.length; j++) {
        arr[j * 3] += b.vel[j].x * dt;
        arr[j * 3 + 1] += b.vel[j].y * dt;
        arr[j * 3 + 2] += b.vel[j].z * dt;
        b.vel[j].multiplyScalar(0.94);
      }
      b.pts.geometry.attributes.position.needsUpdate = true;
      b.pts.material.opacity = Math.max(0, 1 - b.age / b.life);
      if (b.age >= b.life) {
        this.scene.remove(b.pts);
        b.pts.geometry.dispose(); b.pts.material.dispose();
        this.bursts.splice(i, 1);
      }
    }
  }

  #stepFades(dt) {
    for (const [id, v] of this.visuals) {
      if (v.dying) {
        v.fade -= dt * 0.7;
        v.core.material.opacity = v.fade;
        v.core.material.transparent = true;
        v.halo.material.opacity = Math.max(0, v.halo.material.opacity - dt * 0.7);
        v.group.scale.multiplyScalar(1 - dt * 0.35);
        if (v.fade <= 0) {
          this.scene.remove(v.group);
          v.core.material.dispose(); v.halo.material.dispose();
          this.visuals.delete(id);
          this.posMap.delete(id);
        }
      }
    }
  }

  #pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const cores = [...this.visuals.values()].map((v) => v.core);
    const hit = this.raycaster.intersectObjects(cores, false)[0];
    let id;
    if (hit) {
      for (const [aid, v] of this.visuals) if (v.core === hit.object) { id = aid; break; }
    }
    if (id !== this.hovered) {
      this.hovered = id;
      if (this.hoverCb) this.hoverCb(id ?? null);
      this.renderer.domElement.style.cursor = id != null ? "pointer" : "grab";
    }
  }

  #tween(dt) {
    if (!this.tweenTarget) return;
    const cur = this.controls.target;
    cur.lerp(this.tweenTarget, Math.min(1, dt * 2.2));
    if (cur.distanceTo(this.tweenTarget) < 0.5) this.tweenTarget = null;
  }

  #resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  #startLoop() {
    const clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, clock.getDelta());
      this.time += dt;
      this.#stepBursts(dt);
      this.#stepFades(dt);
      this.#tween(dt);
      this.#pick();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }
}
