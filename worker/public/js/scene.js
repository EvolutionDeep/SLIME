// scene.js — Three.js rendering of the SLIME colony.
//
// Art direction: AMOEBA, NOT BALLOONS. Every agent is a deforming single
// cell: a 3D simplex-noise field drives vertex displacement so the
// silhouette genuinely writhes (never a circle at any distance), the body
// is stretched along a per-agent axis, thin pseudopod cones reach out and
// quiver, and organelles orbit inside the translucent membrane. The camera
// auto-frames the colony: small population = macro close-up where one cell
// fills the screen; big population = slow pull-back over the dish.
//
// All comments in English by project convention.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// Agent lifecycle states — the engine now runs server-side (worker/src),
// the renderer only needs the constants to color and shape each cell.
const STATUS = { Egg: "Egg", Alive: "Alive", Quarantined: "Quarantined", Dead: "Dead" };

const COLOR = {
  aliveLow: new THREE.Color("#3fe0c0"),
  aliveHigh: new THREE.Color("#6fd7ff"),
  egg: new THREE.Color("#b58cff"),
  quarantined: new THREE.Color("#ff5470"),
  dead: new THREE.Color("#55628a"),
};

// Clan palette: every gen-1 founder gets a hue from the golden-ratio sequence,
// so sibling lineages land on maximally distinct colors and the colony reads
// as a mosaic of tribes instead of one monochrome blob.
const GOLDEN = 0.61803398875;
// Raw golden-ratio spacing (maximally distinct) folded into a COHESIVE cool
// band — teal→cyan→blue→violet→magenta→rose — instead of the full 360° wheel.
// A uniform rainbow was the single biggest "AI candy" tell; a curated band keeps
// families distinguishable yet reads as one cinematic field, and stays clear of
// green/amber/red so quarantine-red and guardian-gold keep their meaning.
function founderHue(id) {
  const t = (id * GOLDEN) % 1;
  return 0.44 + t * 0.46;   // [0.44, 0.90)
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

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.8)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.2)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function bgTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(256, 300, 0, 256, 256, 420);
  grad.addColorStop(0, "#16214f");
  grad.addColorStop(0.45, "#0c1438");
  grad.addColorStop(1, "#070d26");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// The amoeba shader. Ashima 3D simplex noise drives real vertex displacement
// — the silhouette morphs continuously, which no scale-pulse can fake.
// ---------------------------------------------------------------------------

const SNOISE = /* glsl */ `
vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

const CELL_VERT = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uAmp;
uniform float uFreq;
uniform vec3 uStretch;
varying vec3 vNormal;
varying vec3 vView;
varying float vN;
${SNOISE}
void main() {
  // Non-uniform stretch makes some cells oval, others stubby.
  vec3 p = position * uStretch;
  vec3 base = normalize(p);
  vec3 q = p * uFreq + vec3(uSeed);
  // Two noise octaves, domains drifting in opposite directions: the body
  // rolls and reshapes instead of merely pulsing.
  float n = snoise(q + vec3(0.0, uTime * 0.42, uTime * 0.18)) * 0.65
          + snoise(q * 2.4 - vec3(uTime * 0.3, 0.0, uTime * 0.12)) * 0.35;
  vN = n;
  vec3 disp = p + base * n * uAmp;
  vec4 mv = modelViewMatrix * vec4(disp, 1.0);
  vView = -mv.xyz;
  vNormal = normalize(normalMatrix * base);
  gl_Position = projectionMatrix * mv;
}
`;

const CELL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uEnergy;
varying vec3 vNormal;
varying vec3 vView;
varying float vN;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);
  // Membrane grain from the displacement field: mottled, veined surface.
  float grain = 0.5 + 0.5 * sin(vN * 11.0) * (0.6 + 0.4 * vN);
  float veins = smoothstep(0.35, 0.85, abs(vN));
  vec3 body = uColor * (0.10 + 0.14 * grain + 0.07 * veins);
  vec3 glow = uColor * (0.48 + 0.42 * uEnergy) * fres;
  gl_FragColor = vec4(body + glow, 0.5 + fres * 0.42);
}
`;

function cellMaterial(color, seed, amp, freq, stretch) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seed },
      uAmp: { value: amp },
      uFreq: { value: freq },
      uStretch: { value: stretch },
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
    this.bursts = [];
    this.hoverCb = null;
    this.selectCb = null;
    this.selected = null;
    this.time = 0;
    this.frame = 0;
    this.chainPts = [];
    this.fitRadius = 0;           // colony spread the camera keeps framed
    this.lastUserZoom = -99;
    // Renderer-side perf kit: shared scratch objects + O(1) hover lookup.
    this.coreIds = new Map();     // core mesh -> agent id
    this.clanHue = new Map();     // agent id -> lineage hue [0,1)
    this.sib = new Map();         // agent id -> {i, n} sibling slot around parent
    this._c = new THREE.Color();
    this._q = new THREE.Quaternion();
    this._swayAxis = new THREE.Vector3();

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
    // MSAA now happens INSIDE the composer (see the samples:4 target below),
    // so the canvas itself doesn't need antialias — that keeps the geometry
    // edges crisp without paying for supersampling. DPR cap 1.75 balances
    // sharpness against fill-rate; adaptive quality still trims it under load.
    this.dprBase = Math.min(window.devicePixelRatio || 1, 1.75);
    this.dprCur = this.dprBase;
    renderer.setPixelRatio(this.dprCur);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.8;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = bgTexture();
    scene.fog = new THREE.FogExp2(0x0a1230, 0.0022);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(
      52, container.clientWidth / container.clientHeight, 0.1, 2400,
    );
    camera.position.set(96, 42, 132);
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.4;
    controls.minDistance = 10;
    controls.maxDistance = 620;
    this.controls = controls;
    // Respect manual zooming: auto-fit pauses after the user touches it.
    renderer.domElement.addEventListener("wheel", () => { this.lastUserZoom = this.time; }, { passive: true });

    // A multisampled HalfFloat target is what actually kills the jaggies:
    // the default composer target has no samples, so every geometry edge was
    // hard-aliased. Size it to the real drawing buffer (DPR-aware), not CSS px.
    const db0 = renderer.getDrawingBufferSize(new THREE.Vector2());
    const msaaTarget = new THREE.WebGLRenderTarget(db0.x, db0.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    const composer = new EffectComposer(renderer, msaaTarget);
    composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.17, 0.55, 0.62,  // strength, radius, threshold — a whisper of bloom so
                          // hues stay legible bodies, not a neon candy wash
    );
    composer.addPass(this.bloom);
    this.composer = composer;

    scene.add(new THREE.AmbientLight(0x2c3c66, 1.25));
    const p1 = new THREE.PointLight(0x59b8ff, 1.05, 700); p1.position.set(120, 160, 120);
    const p2 = new THREE.PointLight(0x7a5cff, 0.6, 700); p2.position.set(-150, -70, -110);
    scene.add(p1, p2);

    // --- The dish: bigger world so cells never crowd each other.
    const grid = new THREE.PolarGridHelper(260, 14, 6, 96, 0x31539b, 0x1a2a55);
    grid.material.transparent = true;
    grid.material.opacity = 0.15;
    grid.material.depthWrite = false;
    grid.position.y = -70;
    scene.add(grid);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(260, 0.7, 8, 200),
      new THREE.MeshBasicMaterial({
        color: 0x63b5ff, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending,
      }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -70;
    scene.add(rim);
    this.rim = rim;

    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(275, 2),
      new THREE.MeshBasicMaterial({
        color: 0x3d4f96, wireframe: true, transparent: true, opacity: 0.04,
      }),
    );
    scene.add(shell);

    // Spore dust: near drifters + far motes, slow parallax life.
    this.spores = this.#makeSpores(360, 230, 0.5, 0x7fc8ff);
    this.motes = this.#makeSpores(800, 560, 0.32, 0x39518f);

    // Protoplasmic lineage filaments.
    this.maxEdges = 600;
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 6), 3));
    edgeGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 6), 3));
    this.edgeGeo = edgeGeo;
    scene.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })));

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
    this.pulse.scale.setScalar(12);
    this.pulse.visible = false;
    this.pulseT = 0;
    scene.add(this.pulse);

    // Selection reticle.
    this.reticle = new THREE.Group();
    const reticleMat = new THREE.MeshBasicMaterial({
      color: 0x6fd7ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const r1 = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.58, 48), reticleMat);
    const r2 = new THREE.Mesh(new THREE.RingGeometry(1.95, 2.03, 48, 1, 0, Math.PI * 1.4), reticleMat.clone());
    this.reticle.add(r1, r2);
    this.reticle.visible = false;
    scene.add(this.reticle);

    this.glowTex = glowTexture();
    // Shared geometries, two LOD tiers: close cells keep the buttery detail-3
    // writhe; far ones swap to detail-2 (1/4 tris) — invisible at that size.
    this.blobGeo = new THREE.IcosahedronGeometry(1, 3);
    this.blobGeoLow = new THREE.IcosahedronGeometry(1, 2);
    this.nucleusGeo = new THREE.SphereGeometry(1, 12, 10);
    this.organelleGeo = new THREE.SphereGeometry(1, 6, 5);
    this.podGeo = new THREE.ConeGeometry(0.14, 1.1, 6, 1, true);

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
      color: colorHex, size, transparent: true, opacity: 0.4,
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
      arr[i * 3] = base[i * 3] + Math.sin(t * 0.11 + s) * 3.4;
      arr[i * 3 + 1] = base[i * 3 + 1] + Math.sin(t * 0.08 + s * 1.7) * 2.6;
      arr[i * 3 + 2] = base[i * 3 + 2] + Math.cos(t * 0.1 + s * 0.6) * 3.4;
    }
    pts.geometry.attributes.position.needsUpdate = true;
  }

  onHover(cb) { this.hoverCb = cb; }
  onSelect(cb) { this.selectCb = cb; }

  /** Project an agent's world position to viewport pixels (claim markers). */
  project(agentId) {
    const p = this.posMap.get(agentId);
    if (!p) return null;
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null; // behind the camera
    const r = this.container.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * r.width + r.left,
      y: (-v.y * 0.5 + 0.5) * r.height + r.top,
    };
  }

  /** Drop all colony visuals for a fresh population. */
  reset() {
    for (const v of this.visuals.values()) {
      this.scene.remove(v.group);
      v.core.material.dispose();
      v.skinMat.dispose();
      v.orgMat.dispose();
      v.halo.material.dispose();
      if (v.crown) v.crown.material.dispose();
    }
    this.visuals.clear();
    this.coreIds.clear();
    this.posMap.clear();
    this.chainLine.visible = false;
    this.reticle.visible = false;
    this.pulse.visible = false;
    this.chainPts = [];
    this.selected = null;
    this.hovered = null;
  }

    // One switch governs BOTH the turntable drift and the auto-framing dolly:
    // if #autoFit kept re-distancing the camera after "off", orbit would look
    // broken because the frame never truly stops moving.
    setAutoRotate(on) { this.controls.autoRotate = on; this.fitEnabled = on; }

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
    if (pts.length) this.tweenTarget = pts[pts.length - 1].clone();
  }

  /** Consume the events emitted by Colony.tick() for visual effects. */
  handleEvents(events, colony) {
    for (const ev of events) {
      const a = ev.agent != null ? colony.agents.get(ev.agent) : null;
      const pos = a ? this.#position(a.id, a) : null;
      if (ev.type === "birth" && pos) this.#burst(pos, 0x4be3b0, 18, 1.6);
      else if (ev.type === "hatch" && pos) this.#burst(pos, 0xb58cff, 12, 1.2);
      else if (ev.type === "death" && pos) this.#burst(pos, 0xff5470, 14, 1.3);
      else if (ev.type === "quarantine" && pos) this.#burst(pos, 0xff2244, 30, 2.2);
      else if (ev.type === "attempt" && ev.ok && pos && Math.random() < 0.35) {
        this.#burst(pos, 0x9dffe0, 5, 0.7);
      }
    }
  }

  /** Full reconciliation of visuals against colony state. */
  sync(colony) {
    this.#layoutMeta(colony);
    const seen = new Set();
    for (const a of colony.agents.values()) {
      if (a.status === STATUS.Dead) continue;
      seen.add(a.id);
      const col = this.#colorOf(a);
      let v = this.visuals.get(a.id);
      if (!v) v = this.#buildCell(a, col);
      const base = 1.7 + Math.min(4.6, a.genome.size_kb / 360);
      v.base = base;
      const energy = a.status === STATUS.Egg ? 0.15 : Math.min(1, a.energy / 120);
      const u = v.core.material.uniforms;
      u.uColor.value.copy(col);
      u.uEnergy.value = energy;
      // Eggs barely stir; healthy cells writhe; starving ones spasm harder.
      u.uAmp.value = a.status === STATUS.Egg
        ? 0.10
        : (a.status === STATUS.Quarantined ? 0.26 : 0.34 + (1 - energy) * 0.14);
      const s = base * (this.hovered === a.id ? 1.12 : 1);
      v.group.scale.setScalar(s);
      v.halo.scale.setScalar(3.4);   // local units — multiplied by group scale
      v.halo.material.color.copy(col);
      v.halo.material.opacity = Math.min(0.42, 0.10 + energy * 0.28);
      v.pos = this.#position(a.id, a);
      v.group.position.copy(v.pos);
      // Guardian crown: a warm gold mote hovering over claimed slimes —
      // visible proof that someone out there is keeping this one alive.
      if (a.guardian && !v.crown) {
        const crown = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTex, color: 0xffd66a, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        crown.scale.setScalar(1.15);
        crown.position.y = 1.9;
        v.group.add(crown);
        v.crown = crown;
      } else if (!a.guardian && v.crown) {
        v.group.remove(v.crown);
        v.crown.material.dispose();
        v.crown = null;
      }
      if (v.crown) v.crown.position.y = 1.9 + 0.12 * Math.sin(this.time * 2.4 + a.id);
      // Quarantine cage ring.
      if (a.status === STATUS.Quarantined && !v.ring) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.9, 0.07, 8, 40),
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
    for (const [id, v] of this.visuals) {
      if (!seen.has(id) && v.fade > 0) v.dying = true;
    }
    this.#rebuildEdges(colony);
    this.#followCentroid(colony);
  }

  /** Per-poll layout metadata: sibling slots (even fan-out around the parent)
   *  and household hues — color keys on the PARENT, so every sister cluster
   *  shares one hue and hundreds of households spread across the wheel via
   *  the golden-ratio sequence. Clan-founder colors failed: one bloodline can
   *  be 80% of the dish, which just recreates the monochrome blob. */
  #layoutMeta(colony) {
    const kids = new Map();
    for (const a of colony.agents.values()) {
      if (a.status === STATUS.Dead || a.parent == null) continue;
      let list = kids.get(a.parent);
      if (!list) kids.set(a.parent, (list = []));
      list.push(a.id);
    }
    this.sib.clear();
    for (const list of kids.values()) {
      list.sort((x, y) => x - y);
      for (let i = 0; i < list.length; i++) this.sib.set(list[i], { i, n: list.length });
    }
    this.clanHue.clear();
    for (const a of colony.agents.values()) {
      if (a.status === STATUS.Dead) continue;
      this.clanHue.set(a.id, founderHue(a.parent ?? a.id));
    }
  }

  /** Household color: one hue per parent-family, brightness/saturation from
   *  capability — a fit elder literally glows hotter than its sluggish kin. */
  #colorOf(a) {
    if (a.status === STATUS.Quarantined) return COLOR.quarantined;
    if (a.status === STATUS.Dead) return COLOR.dead;
    const hue = this.clanHue.get(a.id) ?? 0.45;
    // Wild capability spans ~1300–1700: map onto a wide, vivid band so even
    // modest cells wear their clan color loudly — no more grey-blue mush.
    const capT = Math.min(1, Math.max(0, (a.genome.capability - 1250) / 600));
    if (a.status === STATUS.Egg) {
      this._c.setHSL(hue, 0.40, 0.34 + capT * 0.07);   // dormant, but still kin
    } else {
      // Tinted-glass jewel, not a gumball: moderate saturation and a lower
      // lightness so the band reads deep and cinematic instead of milky candy.
      this._c.setHSL(hue, 0.48 + capT * 0.13, 0.44 + capT * 0.11);
    }
    return this._c;
  }

  /** Assemble one amoeba: deforming body, nucleus, organelles, pseudopods. */
  #buildCell(a, col) {
    const r = hashRand(a.id * 3301 + 7);
    const seed = r() * Math.PI * 2;
    const freq = 1.15 + r() * 0.7;
    // Per-agent stretch: oval, stubby, needle-ish — no two silhouettes alike.
    const stretch = new THREE.Vector3(
      0.78 + r() * 0.55, 0.78 + r() * 0.55, 0.78 + r() * 0.55,
    );
    const core = new THREE.Mesh(this.blobGeo, cellMaterial(col, seed, 0.34, freq, stretch));
    this.coreIds.set(core, a.id);

    const skinMat = new THREE.MeshBasicMaterial({
      color: col.clone().lerp(new THREE.Color("#ffffff"), 0.18),
      transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const orgMat = new THREE.MeshBasicMaterial({
      color: col.clone().lerp(new THREE.Color("#ffffff"), 0.35),
      transparent: true, opacity: 0.85, depthWrite: false,
    });

    const nucleus = new THREE.Mesh(this.nucleusGeo, orgMat);
    nucleus.scale.setScalar(0.3);
    nucleus.position.set((r() - 0.5) * 0.3, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3);

    // Organelles orbit on random planes inside the cytoplasm.
    const organelles = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(this.organelleGeo, orgMat);
      m.scale.setScalar(0.07 + r() * 0.09);
      const u = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      const w = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      const vAxis = new THREE.Vector3().crossVectors(u, w).normalize();
      organelles.push({
        mesh: m, u, v: vAxis,
        rad: 0.35 + r() * 0.35, ang: r() * Math.PI * 2,
        spd: (0.25 + r() * 0.5) * (r() > 0.5 ? 1 : -1),
      });
    }

    // Pseudopods: thin cones reaching out, tips quivering.
    const pods = [];
    const podCount = 2 + Math.floor(r() * 3);
    for (let i = 0; i < podCount; i++) {
      const dir = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      const m = new THREE.Mesh(this.podGeo, skinMat);
      const baseQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      m.quaternion.copy(baseQ);
      m.userData.dir = dir;
      m.userData.baseQ = baseQ;
      m.userData.phase = r() * Math.PI * 2;
      m.userData.len = 0.8 + r() * 0.9;
      // Sway axis precomputed — per-frame allocation here was GC poison.
      m.userData.axis = new THREE.Vector3(
        Math.sin(m.userData.phase), Math.cos(m.userData.phase * 1.3), Math.sin(m.userData.phase * 0.7),
      ).normalize();
      pods.push(m);
    }

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: col, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));

    const group = new THREE.Group();
    group.add(halo, core, nucleus, ...pods, ...organelles.map((o) => o.mesh));
    this.scene.add(group);

    const v = {
      group, core, halo, nucleus, pods, organelles, ring: null, fade: 1,
      skinMat, orgMat, base: 1,
    };
    this.visuals.set(a.id, v);
    return v;
  }

  /** Per-frame cytoplasmic motion: organelle orbits + pseudopod quiver.
   *  Cells animate on alternating frames (double dt) — the motion is slow
   *  enough that half-rate updates are invisible, and far cells skip entirely. */
  #stepCells(dt) {
    const parity = this.frame & 1;
    let i = 0;
    for (const v of this.visuals.values()) {
      if (v.dying || v.isFar) { i++; continue; }
      if ((i++ & 1) !== parity) continue;
      const t = this.time;
      for (const o of v.organelles) {
        o.ang += dt * 2 * o.spd;
        o.mesh.position.set(
          Math.cos(o.ang) * o.u.x * o.rad + Math.sin(o.ang) * o.v.x * o.rad,
          Math.cos(o.ang) * o.u.y * o.rad + Math.sin(o.ang) * o.v.y * o.rad,
          Math.cos(o.ang) * o.u.z * o.rad + Math.sin(o.ang) * o.v.z * o.rad,
        );
      }
      for (const p of v.pods) {
        const d = p.userData;
        const q = 0.6 + 0.4 * Math.sin(t * 1.9 + d.phase);   // extend/retract
        p.scale.set(1, q * d.len, 1);
        p.position.copy(d.dir).multiplyScalar(0.55 + q * 0.35);
        // Sway around the resting direction — scratch quaternion, zero alloc.
        this._q.setFromAxisAngle(d.axis, 0.12 * Math.sin(t * 1.3 + d.phase));
        p.quaternion.copy(d.baseQ).premultiply(this._q);
      }
    }
  }

  /** Distance LOD: near cells render at full fidelity; far ones drop to the
   *  low-poly silhouette and shed sub-pixel innards (organelles ~0.1u, pods).
   *  Biggest draw-call + vertex-cost saver at 300+ populations. */
  #stepLod() {
    const cam = this.camera.position;
    for (const v of this.visuals.values()) {
      if (v.dying) continue;
      const far = v.group.position.distanceTo(cam) > 130;
      if (far === v.isFar) continue;
      v.isFar = far;
      v.core.geometry = far ? this.blobGeoLow : this.blobGeo;
      v.nucleus.visible = !far;
      for (const o of v.organelles) o.mesh.visible = !far;
      for (const p of v.pods) p.visible = !far;
    }
  }

  /** Keep the colony centered: gently drag the orbit target to the centroid. */
  #followCentroid(colony) {
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

  /** Auto-framing: the orbit distance tracks the colony's own spread. */
  #measureSpread() {
    if (this.posMap.size === 0) { this.fitRadius = 0; return; }
    const c = this.controls.target;
    let far = 0;
    for (const p of this.posMap.values()) {
      const d = p.distanceTo(c);
      if (d > far) far = d;
    }
    this.fitRadius = far;
  }

  #autoFit(dt) {
    if (!this.fitRadius) return;
    if (this.fitEnabled === false) return;
    // Pause auto-framing for a while after the user scrolls the zoom wheel.
    if (this.time - this.lastUserZoom < 12) return;
    // Close-up when small (cells fill the frame), overview when large.
    const desired = Math.min(560, Math.max(42, this.fitRadius * 2.4 + 34));
    const off = this.camera.position.clone().sub(this.controls.target);
    const len = off.length();
    const next = len + (desired - len) * Math.min(1, dt * 0.55);
    this.camera.position.copy(this.controls.target).add(off.setLength(next));
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
      // Siblings fan out evenly inside their sector of the parent instead of
      // random directions — lineages grow as branching families, not a pile.
      const s = this.sib.get(id) || { i: 0, n: 1 };
      const sector = (Math.PI * 2) / s.n;
      const th = id * 0.37 + s.i * sector + (r() - 0.5) * sector * 0.65;
      const tilt = (r() - 0.5) * 1.05;                  // mild vertical spread
      const dist = 24 + a.gen * 5.5 + r() * 14;
      p = new THREE.Vector3(
        parentPos.x + Math.cos(th) * dist,
        parentPos.y + Math.sin(tilt) * dist * 0.42,
        parentPos.z + Math.sin(th) * dist,
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
      // #colorOf returns a shared scratch color — clone before the next call.
      const pc = this.#colorOf(pa).clone();
      const cc = this.#colorOf(a);
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
      const s = (0.6 + Math.random()) * 8 * power;
      vel.push(new THREE.Vector3(
        s * Math.sin(ph) * Math.cos(th), s * Math.cos(ph), s * Math.sin(ph) * Math.sin(th),
      ));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      color: colorHex, size: 1.8 * power, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pts = new THREE.Points(g, m);
    this.scene.add(pts);
    this.bursts.push({ pts, vel, life: 1.2, age: 0 });
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
          v.core.material.dispose(); v.skinMat.dispose(); v.orgMat.dispose(); v.halo.material.dispose();
          this.coreIds.delete(v.core);
          this.visuals.delete(id);
          this.posMap.delete(id);
        }
      }
    }
  }

  #stepSelection(dt) {
    const sel = this.selected != null ? this.visuals.get(this.selected) : null;
    if (sel && !sel.dying) {
      this.reticle.visible = true;
      this.reticle.position.copy(sel.group.position);
      this.reticle.quaternion.copy(this.camera.quaternion);
      this.reticle.scale.setScalar((sel.base || 2) * 1.35);
      const t = this.time;
      this.reticle.children[0].scale.setScalar(1 + 0.06 * Math.sin(t * 3.2));
      this.reticle.children[1].rotation.z = t * 0.9;
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
    const id = hit ? this.coreIds.get(hit.object) : undefined;
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
    // Size the composer to the DRAWING BUFFER, not CSS px — the earlier CSS
    // sizing silently dropped the post buffer to 1x, softening everything.
    const db = this.renderer.getDrawingBufferSize(this._dbTmp || (this._dbTmp = new THREE.Vector2()));
    this.composer.setSize(db.x, db.y);
  }

  /** Adaptive resolution: sample real frame rate every ~1.5s and step the
   *  pixel ratio down ONLY under real strain, back up as soon as it's
   *  comfortable. Hard floor of 1.0 — a sub-native back-buffer is exactly what
   *  read as "blurry at the default whole-colony view": the old 0.75 floor plus
   *  a dead-band that only recovered above 57fps could get stuck soft, because
   *  dropping resolution lifted fps into the 45–57 gap where it never climbed
   *  back. Zooming in/out changed the on-screen overdraw enough to escape it,
   *  which is why only the default distance looked fuzzy. */
  #adaptQuality(dt) {
    this._fpsAcc = (this._fpsAcc || 0) + dt;
    this._fpsN = (this._fpsN || 0) + 1;
    if (this._fpsAcc < 1.5) return;
    const fps = this._fpsN / this._fpsAcc;
    this._fpsAcc = 0; this._fpsN = 0;
    let next = this.dprCur;
    if (fps < 38) next = Math.max(1, this.dprCur - 0.25);       // never below native
    else if (fps > 50) next = Math.min(this.dprBase, this.dprCur + 0.25);
    if (next === this.dprCur) return;
    this.dprCur = next;
    this.renderer.setPixelRatio(next);
    this.#resize();   // recomputes composer buffer from the new DPR
  }

  #startLoop() {
    const clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      this.frame++;
      const dt = Math.min(0.05, clock.getDelta());
      this.time += dt;
      for (const v of this.visuals.values()) {
        v.core.material.uniforms.uTime.value = this.time;
      }
      this.#stepLod();
      this.#stepCells(dt);
      // Spore dust drifts slowly — a quarter-rate update still reads as fluid.
      if ((this.frame & 3) === 0) {
        this.#driftSpores(this.spores, this.time);
        this.#driftSpores(this.motes, this.time * 0.6);
      }
      this.rim.material.opacity = 0.1 + 0.05 * Math.sin(this.time * 0.7);
      this.#stepBursts(dt);
      this.#stepFades(dt);
      this.#stepSelection(dt);
      this.#tween(dt);
      this.#measureSpread();
      this.#autoFit(dt);
      this.#adaptQuality(dt);
      // Hover raycast at half rate — pointer response stays imperceptibly fast,
      // but 320-mesh intersection no longer runs every single frame.
      if ((this.frame & 1) === 0) this.#pick();
      this.controls.update();
      this.composer.render();
    };
    loop();
  }
}
