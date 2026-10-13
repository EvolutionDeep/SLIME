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
  nextProposalId: number;
  /** The externally launched community token mint; all-zero until set. */
  tokenMint: number[];
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
    nextProposalId: r.u64(),
    tokenMint: r.bytes(32),
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
  /** Keeper wallet that first fed this agent; zero until claimed. */
  guardian: number[];
  lastFeedEpoch: number;
  feeds: number;
  potion: boolean;
  appealEpoch: number;
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
    guardian: [],
    lastFeedEpoch: 0,
    feeds: 0,
    potion: false,
    appealEpoch: 0,
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
  v.guardian = r.bytes(32);
  v.lastFeedEpoch = r.u64();
  v.feeds = r.u16();
  v.potion = r.u8() !== 0;
  v.appealEpoch = r.u64();
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

export interface VaultView {
  creditsSpawn: number;
  creditsProposals: number;
  creditsFossils: number;
  creditsGranted: number;
  creditsGross: number;
  lastFeeEpoch: number;
}

export async function parseVault(bytes: Uint8Array): Promise<VaultView | null> {
  if (!(await matches(bytes, "account", "Vault"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  r.u8(); // bump
  return {
    creditsSpawn: r.u64(),
    creditsProposals: r.u64(),
    creditsFossils: r.u64(),
    creditsGranted: r.u64(),
    creditsGross: r.u64(),
    lastFeeEpoch: r.u64(),
  };
}

export const PROPOSAL_STATUS = ["Active", "Passed", "Rejected", "Executed"] as const;

export interface ProposalView {
  id: number;
  proposer: number[];
  kind: number; // 1 = ParamChange, 2 = Grant, 3 = Signal
  paramKey: number;
  paramValue: number;
  grantAgent: number;
  votesFor: number;
  votesAgainst: number;
  createdEpoch: number;
  endsEpoch: number;
  status: (typeof PROPOSAL_STATUS)[number];
  /** 0 = agents' upper chamber, 1 = token holders' lower chamber. */
  chamber: number;
}

export async function parseProposal(bytes: Uint8Array): Promise<ProposalView | null> {
  if (!(await matches(bytes, "account", "Proposal"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  r.u8(); // bump
  const v: ProposalView = {
    id: r.u64(),
    proposer: r.bytes(32),
    kind: r.u8(),
    paramKey: r.u8(),
    paramValue: r.u64(),
    grantAgent: r.u64(),
    votesFor: r.u64(),
    votesAgainst: r.u64(),
    createdEpoch: r.u64(),
    endsEpoch: r.u64(),
    status: "Active",
    chamber: 0,
  };
  v.status = PROPOSAL_STATUS[Math.min(r.u8(), 3)];
  v.chamber = r.u8();
  return v;
}

export interface MarketView {
  epoch: number;
  overPool: number;
  underPool: number;
  /** 0 = unsettled/void, 1 = over won, 2 = under won. */
  winner: number;
  settled: boolean;
}

export async function parseMarket(bytes: Uint8Array): Promise<MarketView | null> {
  if (!(await matches(bytes, "account", "EpochMarket"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  r.u8(); // bump
  return {
    epoch: r.u64(),
    overPool: r.u64(),
    underPool: r.u64(),
    winner: r.u8(),
    settled: r.u8() !== 0,
  };
}

export interface BetView {
  bidder: number[];
  epoch: number;
  over: boolean;
  amount: number;
  claimed: boolean;
}

export async function parseBet(bytes: Uint8Array): Promise<BetView | null> {
  if (!(await matches(bytes, "account", "BetTicket"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  r.u8(); // bump
  return {
    bidder: r.bytes(32),
    epoch: r.u64(),
    over: r.u8() !== 0,
    amount: r.u64(),
    claimed: r.u8() !== 0,
  };
}

export interface GenerationView {
  generation: number;
  name: string;
  namedBy: number[];
  heroAgent: number;
}

export async function parseGeneration(bytes: Uint8Array): Promise<GenerationView | null> {
  if (!(await matches(bytes, "account", "GenerationName"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  r.u8(); // bump
  const gen = r.u64();
  const raw = r.bytes(32);
  const namedBy = r.bytes(32);
  const heroAgent = r.u64();
  const end = raw.indexOf(0);
  const nameBytes = end >= 0 ? raw.slice(0, end) : raw;
  return {
    generation: gen,
    name: new TextDecoder().decode(new Uint8Array(nameBytes)),
    namedBy,
    heroAgent,
  };
}

/** Minimal base58 (Bitcoin alphabet) encoder for pubkey comparison. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function bs58Encode(bytes: number[]): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}

export interface FossilView {
  agentId: number;
  generation: number;
  strainRoot: number;
  capability: number;
  sizeKb: number;
  notesCommit: number[];
  wins: number;
  losses: number;
  quarantined: boolean;
  mintedEpoch: number;
  minter: number[];
}

export async function parseFossil(bytes: Uint8Array): Promise<FossilView | null> {
  if (!(await matches(bytes, "account", "Fossil"))) return null;
  const r = new ByteReader(bytes);
  r.skip(8);
  r.u8(); // bump
  return {
    agentId: r.u64(),
    generation: r.u32(),
    strainRoot: r.u64(),
    capability: r.u16(),
    sizeKb: r.u16(),
    notesCommit: r.bytes(32),
    wins: r.u16(),
    losses: r.u16(),
    quarantined: r.u8() !== 0,
    mintedEpoch: r.u64(),
    minter: r.bytes(32),
  };
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

const EVENT_NAMES = [
  "Birth", "Death", "Hatched", "Quarantined", "EpochSettled",
  "TreasuryAccrue", "ProposalCreated", "ProposalExecuted", "FossilMinted",
  "TokenMintSet", "GuardianFeed", "InterventionBurned",
  "BetPlaced", "BetSettled", "BetClaimed", "GenerationNamed",
] as const;

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
        case "TreasuryAccrue":
          fields.source = r.u8();
          fields.amount = r.u64();
          fields.grossTotal = r.u64();
          break;
        case "ProposalCreated":
          fields.id = r.u64();
          fields.kind = r.u8();
          fields.endsEpoch = r.u64();
          break;
        case "ProposalExecuted":
          fields.id = r.u64();
          fields.passed = r.u8();
          fields.votesFor = r.u64();
          fields.votesAgainst = r.u64();
          break;
        case "FossilMinted":
          fields.agentId = r.u64();
          fields.generation = r.u32();
          fields.wins = r.u16();
          fields.quarantined = r.u8();
          break;
        case "GuardianFeed":
          fields.agentId = r.u64();
          r.skip(32); // guardian
          fields.firstClaim = r.u8();
          fields.tokens = r.u64();
          fields.energyGranted = r.u64();
          break;
        case "InterventionBurned":
          fields.kind = r.u8();
          fields.agentId = r.u64();
          fields.tokensBurnt = r.u64();
          break;
        case "BetPlaced":
          fields.epoch = r.u64();
          fields.over = r.u8();
          fields.amount = r.u64();
          break;
        case "BetSettled":
          fields.epoch = r.u64();
          fields.winner = r.u8();
          fields.overPool = r.u64();
          fields.underPool = r.u64();
          break;
        case "BetClaimed":
          fields.epoch = r.u64();
          fields.payout = r.u64();
          break;
        case "GenerationNamed":
          fields.generation = r.u64();
          r.skip(32); // name
          fields.heroAgent = r.u64();
          break;
      }
      return { kind: name, fields };
    }
  }
  return null;
}
