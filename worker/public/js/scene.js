// scene.js 鈥?Three.js rendering of the SLIME colony.
//
// Art direction: a BIOLUMINESCENT COLONY INSIDE A PETRI DISH.
// Agents are not spheres 鈥?they are living cells: a membrane that writhes
// with peristaltic waves (vertex displacement), a Fresnel rim that glows
// where the surface curves away from the eye, a brighter nucleus suspended
// inside. Everything blooms. The dish floor, drifting spores and the
// containment haze give the colony scale and depth.
//
// All comments in English by project convention.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { STATUS } from "./engine.js";

const COLOR = {
  aliveLow: new THREE.Color("#2dd4a7"),   // low capability: deep green
  aliveHigh: new THREE.Color("#7df9ff"),  // high capability: electric cyan
  egg: new THREE.Color("#b58cff"),        // dormant violet
  quarantined: new THREE.Color("#ff5470"),// alarm red
  dead: new THREE.Color("#37413f"),
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

// Soft radial sprite for glow halos.
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.8)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.22)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Deep radial background: lit from colony center, contained by darkness.
function bgTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(256, 300, 0, 256, 256, 420);
  grad.addColorStop(0, "#061a1e");
  grad.addColorStop(0.45, "#030e14");
  grad.addColorStop(1, "#01040a");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// Living-cell shader: peristaltic membrane + Fresnel bioluminescence.
// ---------------------------------------------------------------------------

const CELL_VERT = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uAmp;
varying vec3 vNormal;
varying vec3 vView;
varying float vWob;

// Three stacked sine products read as organic peristaltic waves.
float wob(vec3 p, float t) {
  return sin(p.x * 2.1 + t * 1.6) * 0.5
       + sin(p.y * 2.7 + t * 1.1 + p.z * 1.3) * 0.3
       + sin(p.z * 1.9 - t * 1.3 + uSeed) * 0.2;
}

void main() {
  vec3 p = position;
  float w = wob(p * 1.6 + uSeed, uTime);
  vWob = w;
  p += normal * w * uAmp;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = -mv.xyz;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

const CELL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uEnergy;   // 0..1 鈥?metabolic brightness
uniform float uTime;
varying vec3 vNormal;
varying vec3 vView;
varying float vWob;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  float fres = pow(1.0 - abs(dot(N, V)), 2.2);
  // Mottled cytoplasm: the wobble field doubles as a luminance pattern.
  float mottle = 0.5 + 0.5 * sin(vWob * 6.0 + uTime * 0.8);
  vec3 body = uColor * (0.10 + 0.07 * mottle);
  vec3 rim = uColor * (0.85 + 0.55 * uEnergy);
  vec3 col = body + rim * fres;
  float alpha = 0.34 + fres * 0.5;
  gl_FragColor = vec4(col, alpha);
}
`;

function cellMaterial(color, seed) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seed },
      uAmp: { value: 0.14 },
      uColor: { value: color.clone() },
      uEnergy: { value: 0.5 },
    },
    vertexShader: CELL_VERT,
    fragmentShader: CELL_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

export class ColonyScene {
  constructor(container) {
    this.hovered = null;
    this.tweenTarget = null;
    this.container = container;
    this.posMap = new Map();      // agent id -> Vector3
    this.visuals = new Map();     // agent id -> visual bundle
    this.bursts = [];             // particle systems in flight
    this.hoverCb = null;
    this.selectCb = null;
    this.selected = null;
    this.time = 0;
    this.chainPts = [];           // selected ancestry path for the traveling pulse

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = bgTexture();
    scene.fog = new THREE.FogExp2(0x02090f, 0.0042);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(
      52, container.clientWidth / container.clientHeight, 0.1, 1200,
    );
    camera.position.set(92, 40, 128);   // low three-quarter 鈥?cinematic default
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.22;
    controls.minDistance = 16;
    controls.maxDistance = 300;
    this.controls = controls;

    // Bloom 鈥?the single biggest quality lever. Everything emissive melts.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.45, 0.6, 0.38,   // strength, radius, threshold — glow, not fog
    );
    composer.addPass(this.bloom);
    this.composer = composer;

    scene.add(new THREE.AmbientLight(0x223344, 1.2));
    const p1 = new THREE.PointLight(0x35ffc3, 1.0, 400); p1.position.set(60, 90, 60);
    const p2 = new THREE.PointLight(0x7a5cff, 0.6, 400); p2.position.set(-80, -40, -60);
    scene.add(p1, p2);

    // --- The dish: polar grid floor + glowing rim, gives the colony scale.
    const grid = new THREE.PolarGridHelper(150, 12, 6, 96, 0x1d5c4c, 0x0d2b26);
    grid.material.transparent = true;
    grid.material.opacity = 0.16;
    grid.material.depthWrite = false;
    grid.position.y = -46;
    scene.add(grid);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(150, 0.55, 8, 160),
      new THREE.MeshBasicMaterial({
        color: 0x2bd9a8, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending,
      }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -46;
    scene.add(rim);
    this.rim = rim;

    // Containment shell: barely-there geodesic glass.
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(158, 2),
      new THREE.MeshBasicMaterial({
        color: 0x2b6b5a, wireframe: true, transparent: true, opacity: 0.045,
      }),
    );
    scene.add(shell);

    // --- Spore dust: two layers 鈥?near drifters and far motes.
    this.spores = this.#makeSpores(320, 130, 0.42, 0x54c9ab);
    this.motes = this.#makeSpores(700, 340, 0.26, 0x274f47);

    // Mycelial lineage lines (rebuilt each epoch, preallocated buffers).
    this.maxEdges = 600;
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 6), 3));
    edgeGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 6), 3));
    this.edgeGeo = edgeGeo;
    scene.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })));

    // Highlighted ancestry chain + a nutrient pulse traveling along it.
    this.chainLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0xaef7ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
      }),
    );
    this.chainLine.visible = false;
    scene.add(this.chainLine);
    this.pulse = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xaef7ff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.pulse.scale.setScalar(7);
    this.pulse.visible = false;
    this.pulseT = 0;
    scene.add(this.pulse);

    // Selection reticle: two billboarded rings, counter-rotating.
    this.reticle = new THREE.Group();
    const reticleMat = new THREE.MeshBasicMaterial({
      color: 0x7df9ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const r1 = new THREE.Mesh(new THREE.RingGeometry(4.6, 4.85, 48), reticleMat);
    const r2 = new THREE.Mesh(new THREE.RingGeometry(6.1, 6.2, 48, 1, 0, Math.PI * 1.4), reticleMat.clone());
    this.reticle.add(r1, r2);
    this.reticle.visible = false;
    scene.add(this.reticle);

    this.glowTex = glowTexture();
    this.coreGeo = new THREE.SphereGeometry(1, 32, 24);
    this.nucleusGeo = new THREE.SphereGeometry(1, 12, 10);

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

  #makeSpores(n, radius, size, colorHex) {
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = radius * (0.25 + 0.75 * Math.random());
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.55;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      seed[i] = Math.random() * Math.PI * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
      color: colorHex, size, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    pts.userData.seed = seed;
    pts.userData.base = pos.slice();
    this.scene.add(pts);
    return pts;
  }

  #driftSpores(pts, t) {
    const arr = pts.geometry.attributes.position.array;
    const base = pts.userData.base;
    const seed = pts.userData.seed;
    for (let i = 0; i < seed.length; i++) {
      const s = seed[i];
      arr[i * 3] = base[i * 3] + Math.sin(t * 0.13 + s) * 2.4;
      arr[i * 3 + 1] = base[i * 3 + 1] + Math.sin(t * 0.09 + s * 1.7) * 1.8;
      arr[i * 3 + 2] = base[i * 3 + 2] + Math.cos(t * 0.11 + s * 0.6) * 2.4;
    }
    pts.geometry.attributes.position.needsUpdate = true;
  }

  onHover(cb) { this.hoverCb = cb; }
  onSelect(cb) { this.selectCb = cb; }

  /** Drop all colony visuals for a fresh population. */
  reset() {
    for (const v of this.visuals.values()) {
      this.scene.remove(v.group);
      v.core.material.dispose();
      v.nucleus.material.dispose();
      v.halo.material.dispose();
    }
    this.visuals.clear();
    this.posMap.clear();
    this.chainLine.visible = false;
    this.reticle.visible = false;
    this.pulse.visible = false;
    this.chainPts = [];
    this.selected = null;
    this.hovered = null;
  }

  setAutoRotate(on) { this.controls.autoRotate = on; }

  /** Focus the camera on one agent and highlight its ancestry chain. */
  focus(agentId, colony) {
    this.selected = agentId;
    if (agentId == null) {
      this.chainLine.visible = false;
      this.pulse.visible = false;
      this.chainPts = [];
      return;
    }
    const chain = [];
    let cur = colony.agents.get(agentId);
    while (cur) {
      chain.push(this.#position(cur.id, cur));
      cur = cur.parent != null ? colony.agents.get(cur.parent) : null;
    }
    const pts = chain.reverse();
    this.chainPts = pts;
    this.chainLine.geometry.setFromPoints(pts);
    this.chainLine.visible = pts.length > 1;
    this.pulse.visible = pts.length > 1;
    if (pts.length) {
      this.tweenTarget = pts[pts.length - 1].clone();
    }
  }

  /** Consume the events emitted by Colony.tick() for visual effects. */
  handleEvents(events, colony) {
    for (const ev of events) {
      const a = ev.agent != null ? colony.agents.get(ev.agent) : null;
      const pos = a ? this.#position(a.id, a) : null;
      if (ev.type === "birth" && pos) this.#burst(pos, 0x35ffc3, 18, 1.3);
      else if (ev.type === "hatch" && pos) this.#burst(pos, 0xb58cff, 12, 0.9);
      else if (ev.type === "death" && pos) this.#burst(pos, 0xff5470, 14, 1.0);
      else if (ev.type === "quarantine" && pos) this.#burst(pos, 0xff2244, 30, 1.8);
      else if (ev.type === "attempt" && ev.ok && pos && Math.random() < 0.35) {
        this.#burst(pos, 0x9dffe0, 5, 0.5); // subtle solve spark, rate-limited
      }
    }
  }

  /** Full reconciliation of visuals against colony state. */
  sync(colony) {
    const seen = new Set();
    for (const a of colony.agents.values()) {
      if (a.status === STATUS.Dead) continue;
      seen.add(a.id);
      const col = agentColor(a);
      let v = this.visuals.get(a.id);
      if (!v) {
        const seed = ((a.id * 2654435761) >>> 0) % 1000 / 1000 * Math.PI * 2;
        const core = new THREE.Mesh(this.coreGeo, cellMaterial(col, seed));
        const nucleus = new THREE.Mesh(
          this.nucleusGeo,
          new THREE.MeshBasicMaterial({ color: col.clone().lerp(new THREE.Color("#ffffff"), 0.16) }),
        );
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTex, color: col, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        const group = new THREE.Group();
        group.add(halo, core, nucleus);
        this.scene.add(group);
        v = { group, core, nucleus, halo, ring: null, fade: 1, seed };
        this.visuals.set(a.id, v);
      }
      const base = 0.9 + Math.min(2.4, a.genome.size_kb / 1400);
      const energy = a.status === STATUS.Egg ? 0.15 : Math.min(1, a.energy / 120);
      // Peristalsis: eggs breathe slowly, starving cells writhe harder.
      const u = v.core.material.uniforms;
      u.uColor.value.copy(col);
      u.uEnergy.value = energy;
      u.uAmp.value = a.status === STATUS.Egg ? 0.06 : 0.10 + (1 - energy) * 0.10;
      const wob = 1 + 0.05 * Math.sin(this.time * (a.status === STATUS.Egg ? 1.4 : 2.2) + a.id);
      const hoverBoost = this.hovered === a.id ? 1.18 : 1;
      v.core.scale.setScalar(base * wob * hoverBoost);
      v.nucleus.scale.setScalar(base * 0.24 * wob);
      v.nucleus.material.color.copy(col).lerp(new THREE.Color("#ffffff"), 0.16);
      v.halo.scale.setScalar(base * 4.0);
      v.halo.material.color.copy(col);
      v.halo.material.opacity = Math.min(0.45, 0.06 + energy * 0.3) * hoverBoost;
      v.pos = this.#position(a.id, a);
      v.group.position.copy(v.pos);
      // Quarantine cage ring.
      if (a.status === STATUS.Quarantined && !v.ring) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(base * 1.9, 0.12, 8, 40),
          new THREE.MeshBasicMaterial({
            color: 0xff5470, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
          }),
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
      col[w * 6] = pc.r * 0.5; col[w * 6 + 1] = pc.g * 0.5; col[w * 6 + 2] = pc.b * 0.5;
      col[w * 6 + 3] = cc.r * 0.85; col[w * 6 + 4] = cc.g * 0.85; col[w * 6 + 5] = cc.b * 0.85;
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
        v.core.material.uniforms.uColor.value.multiplyScalar(0.9);
        v.halo.material.opacity = Math.max(0, v.halo.material.opacity - dt * 0.7);
        v.group.scale.multiplyScalar(1 - dt * 0.35);
        if (v.fade <= 0) {
          this.scene.remove(v.group);
          v.core.material.dispose(); v.nucleus.material.dispose(); v.halo.material.dispose();
          this.visuals.delete(id);
          this.posMap.delete(id);
        }
      }
    }
  }

  /** Selected reticle + nutrient pulse traveling down the ancestry chain. */
  #stepSelection(dt) {
    const sel = this.selected != null ? this.visuals.get(this.selected) : null;
    if (sel && !sel.dying) {
      this.reticle.visible = true;
      this.reticle.position.copy(sel.group.position);
      this.reticle.quaternion.copy(this.camera.quaternion);
      const t = this.time;
      this.reticle.children[0].scale.setScalar(1 + 0.06 * Math.sin(t * 3.2));
      this.reticle.children[1].rotation.z = t * 0.9;
      this.reticle.children[1].scale.setScalar(1 + 0.05 * Math.sin(t * 2.1 + 1));
    } else {
      this.reticle.visible = false;
    }
    if (this.chainPts.length > 1) {
      this.pulseT = (this.pulseT + dt * 0.35) % 1;
      const n = this.chainPts.length - 1;
      const f = this.pulseT * n;
      const i = Math.min(n - 1, Math.floor(f));
      this.pulse.position.lerpVectors(this.chainPts[i], this.chainPts[i + 1], f - i);
      this.pulse.material.opacity = 0.55 + 0.4 * Math.sin(this.pulseT * Math.PI);
      this.pulse.visible = true;
    } else {
      this.pulse.visible = false;
    }
  }

  #pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const cores = [...this.visuals.values()].filter((v) => !v.dying).map((v) => v.core);
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
    this.composer.setSize(w, h);
  }

  #startLoop() {
    const clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, clock.getDelta());
      this.time += dt;
      // Push global time into every cell shader.
      for (const v of this.visuals.values()) {
        v.core.material.uniforms.uTime.value = this.time;
      }
      this.#driftSpores(this.spores, this.time);
      this.#driftSpores(this.motes, this.time * 0.6);
      this.rim.material.opacity = 0.12 + 0.05 * Math.sin(this.time * 0.7);
      this.#stepBursts(dt);
      this.#stepFades(dt);
      this.#stepSelection(dt);
      this.#tween(dt);
      this.#pick();
      this.controls.update();
      this.composer.render();
    };
    loop();
  }
}
