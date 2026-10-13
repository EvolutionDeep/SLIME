// decode.ts — Byte-level decoders mirroring programs/slime/src/lib.rs layouts.
// Anchor account discriminator = sha256("account:<Name>")[..8];
// event discriminator = sha256("event:<Name>")[..8];
// instruction discriminator = sha256("global:<snake_case_name>")[..8].

export const AGENT_STATUS = ["Egg", "Alive", "Quarantined", "Dead"] as const;

const discCache = new Map<string, Uint8Array>();

/** First 8 bytes of sha256("<prefix>:<name>"), cached (async WebCrypto). */
export async function discriminator(
  prefix: "account" | "event" | "global" | "type",
  name: string,
): Promise<Uint8Array> {
  const key = `${prefix}:${name}`;
  let d = discCache.get(key);
  if (!d) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    d = new Uint8Array(buf).slice(0, 8);
    discCache.set(key, d);
  }
  return d;
}

async function matches(bytes: Uint8Array, prefix: "account" | "event", name: string) {
  const d = await discriminator(prefix, name);
  for (let i = 0; i < 8; i++) if (bytes[i] !== d[i]) return false;
  return true;
}

/** Little-endian sequential reader over one account's data. */
export class ByteReader {
  private dv: DataView;
  private o = 0;
  constructor(b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8(): number {
    const v = this.dv.getUint8(this.o);
    this.o += 1;
    return v;
  }
  u16(): number {
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32(): number {
    const v = this.dv.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  u64(): number {
    const v = Number(this.dv.getBigUint64(this.o, true));
    this.o += 8;
    return v;
  }
  bytes(n: number): number[] {
    const s = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.o, n);
    this.o += n;
    return Array.from(s);
  }
  skip(n: number) {
    this.o += n;
  }
}

/** Serialize a u64 little-endian (used by instruction data builders). */
export function le8(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Views (field order copied 1:1 from the Rust structs, after the 8-byte disc)
// ---------------------------------------------------------------------------

export interface ConfigView {
  authority: number[];
  verifier: number[];
  breaker: boolean;
  epochLenSlots: number;
  currentEpoch: number;
  chronicleHead: number[];
  chronicleSeq: number;
  caps: { daily: number; perAgent: number; perTxn: number };
  daily: { day: number; spent: number };
  birthsLastEpoch: number;
  nextAgentId: number;
}

export async function parseConfig(bytes: Uint8Array): Promise<ConfigView | null> {
  if (!(await matches(bytes, "account", "Config"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  return {
    authority: r.bytes(32),
    verifier: r.bytes(32),
    breaker: r.u8() !== 0,
    epochLenSlots: r.u64(),
    currentEpoch: r.u64(),
    chronicleHead: r.bytes(32),
    chronicleSeq: r.u64(),
    caps: { daily: r.u64(), perAgent: r.u64(), perTxn: r.u64() },
    daily: { day: r.u64(), spent: r.u64() },
    birthsLastEpoch: r.u32(),
    nextAgentId: r.u64(),
  };
}

export interface AgentView {
  id: number;
  parentId: number;
  strainRoot: number;
  generation: number;
  capability: number;
  sizeKb: number;
  notesCommit: number[];
  fitness: number;
  energy: number;
  hostMaxSizeKb: number;
  hostTokRateX100: number;
  status: (typeof AGENT_STATUS)[number];
  birthEpoch: number;
  gestationEpochs: number;
  lastTickEpoch: number;
  wins: number;
  losses: number;
}

export async function parseAgent(bytes: Uint8Array): Promise<AgentView | null> {
  if (!(await matches(bytes, "account", "Agent"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  const bump = r.u8();
  if (bump > 255) return null;
  const v: AgentView = {
    id: r.u64(),
    parentId: r.u64(),
    strainRoot: r.u64(),
    generation: r.u32(),
    capability: r.u16(),
    sizeKb: r.u16(),
    notesCommit: r.bytes(32),
    fitness: r.u16(),
    energy: r.u64(),
    hostMaxSizeKb: r.u16(),
    hostTokRateX100: r.u16(),
    status: "Egg",
    birthEpoch: 0,
    gestationEpochs: 0,
    lastTickEpoch: 0,
    wins: 0,
    losses: 0,
  };
  const sIdx = r.u8();
  v.status = AGENT_STATUS[Math.min(sIdx, 3)];
  v.birthEpoch = r.u64();
  v.gestationEpochs = r.u64();
  v.lastTickEpoch = r.u64();
  r.u64(); // day_book.day
  r.u64(); // day_book.spent
  v.wins = r.u16();
  v.losses = r.u16();
  return v;
}

export interface StrainView {
  rootId: number;
  population: number;
  alive: number;
  r0EmaX1000: number;
  meanFitness: number;
  lastEpoch: number;
}

export async function parseStrain(bytes: Uint8Array): Promise<StrainView | null> {
  if (!(await matches(bytes, "account", "Strain"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  r.u8(); // bump
  return {
    rootId: r.u64(),
    population: r.u32(),
    alive: r.u32(),
    r0EmaX1000: r.u32(),
    meanFitness: r.u16(),
    lastEpoch: r.u64(),
  };
}

// ---------------------------------------------------------------------------
// Events (program data logs)
// ---------------------------------------------------------------------------

const EVENT_NAMES = ["Birth", "Death", "Hatched", "Quarantined", "EpochSettled"] as const;

export interface EventView {
  kind: (typeof EVENT_NAMES)[number];
  fields: Record<string, number>;
}

/** Decode one base64 "Program data:" log line into a typed event, or null. */
export async function decodeEvent(base64: string): Promise<EventView | null> {
  const bytes = Uint8Array.from(atob(base64), (c: string) => c.charCodeAt(0));
  if (bytes.length < 8) return null;
  for (const name of EVENT_NAMES) {
    if (await matches(bytes, "event", name)) {
      const r = new ByteReader(bytes);
      r.skip(8);
      const fields: Record<string, number> = {};
      switch (name) {
        case "Birth":
          fields.agentId = r.u64();
          fields.parentId = r.u64();
          fields.generation = r.u32();
          fields.capability = r.u16();
          fields.sizeKb = r.u16();
          break;
        case "Death":
          fields.agentId = r.u64();
          break;
        case "Hatched":
          fields.agentId = r.u64();
          break;
        case "Quarantined":
          fields.agentId = r.u64();
          fields.flag = r.u8();
          break;
        case "EpochSettled":
          fields.epoch = r.u64();
          fields.r0EmaX1000 = r.u32();
          break;
      }
      return { kind: name, fields };
    }
  }
  return null;
}
