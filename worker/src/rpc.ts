// rpc.ts — Thin chain-access layer for the SLIME program.
// Read paths use raw JSON-RPC via web3.js Connection; PDA seeds mirror
// the program (["agent", le8(id)], ["strain", le8(root)], ["config"],
// ["vault"], ["proposal", le8(id)], ["fossil", le8(agent_id)]).

import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseConfig,
  parseAgent,
  parseStrain,
  parseVault,
  parseProposal,
  parseFossil,
  decodeEvent,
  le8,
  type ConfigView,
  type AgentView,
  type StrainView,
  type VaultView,
  type ProposalView,
  type FossilView,
  type EventView,
} from "./decode";

// Account data sizes fixed in programs/slime/src/lib.rs (discriminator + space).
const CONFIG_SPACE = 8 + 256;
const AGENT_SPACE = 8 + 256;
const STRAIN_SPACE = 8 + 96;
const VAULT_SPACE = 8 + 96;
const PROPOSAL_SPACE = 8 + 160;
const FOSSIL_SPACE = 8 + 128;

export class SlimeChain {
  readonly conn: Connection;
  readonly pid: PublicKey;

  constructor(rpcUrl: string, programId: string) {
    this.conn = new Connection(rpcUrl, "confirmed");
    this.pid = new PublicKey(programId);
  }

  configPda(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("config")], this.pid)[0];
  }
  agentPda(id: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), le8(id)],
      this.pid,
    )[0];
  }
  strainPda(root: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("strain"), le8(root)],
      this.pid,
    )[0];
  }
  vaultPda(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("vault")], this.pid)[0];
  }
  proposalPda(id: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), le8(id)],
      this.pid,
    )[0];
  }
  fossilPda(agentId: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("fossil"), le8(agentId)],
      this.pid,
    )[0];
  }

  async fetchConfig(): Promise<ConfigView | null> {
    const acc = await this.conn.getAccountInfo(this.configPda());
    if (!acc) return null;
    return parseConfig(acc.data);
  }

  async fetchAgent(id: number): Promise<AgentView | null> {
    const acc = await this.conn.getAccountInfo(this.agentPda(id));
    if (!acc) return null;
    return parseAgent(acc.data);
  }

  /** Scan every Agent account (program-owned, fixed size; small MVP fleets). */
  async fetchAgents(limit = 200): Promise<AgentView[]> {
    const accs = await this.conn.getProgramAccounts(this.pid, {
      filters: [{ dataSize: AGENT_SPACE }],
    });
    const out: AgentView[] = [];
    for (const { account } of accs) {
      const v = await parseAgent(account.data);
      if (v) out.push(v);
      if (out.length >= limit) break;
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  async fetchStrain(root: number): Promise<StrainView | null> {
    const acc = await this.conn.getAccountInfo(this.strainPda(root));
    if (!acc) return null;
    return parseStrain(acc.data);
  }

  async fetchVault(): Promise<VaultView | null> {
    const acc = await this.conn.getAccountInfo(this.vaultPda());
    if (!acc) return null;
    return parseVault(acc.data);
  }

  /** All governance proposals, newest first (size filter + disc check). */
  async fetchProposals(limit = 50): Promise<ProposalView[]> {
    const accs = await this.conn.getProgramAccounts(this.pid, {
      filters: [{ dataSize: PROPOSAL_SPACE }],
    });
    const out: ProposalView[] = [];
    for (const { account } of accs) {
      const v = await parseProposal(account.data);
      if (v) out.push(v);
      if (out.length >= limit) break;
    }
    out.sort((a, b) => b.id - a.id);
    return out;
  }

  /** The lineage fossil registry (scarce by protocol rules). */
  async fetchFossils(limit = 100): Promise<FossilView[]> {
    const accs = await this.conn.getProgramAccounts(this.pid, {
      filters: [{ dataSize: FOSSIL_SPACE }],
    });
    const out: FossilView[] = [];
    for (const { account } of accs) {
      const v = await parseFossil(account.data);
      if (v) out.push(v);
      if (out.length >= limit) break;
    }
    out.sort((a, b) => b.mintedEpoch - a.mintedEpoch);
    return out;
  }

  /** Recent lifecycle events, read from Config-account transaction logs.
   *  Bounded scan: `depth` signatures, `max` decoded transactions (cost cap). */
  async recentEvents(depth = 25, max = 10): Promise<EventView[]> {
    const sigs = await this.conn.getSignaturesForAddress(this.configPda(), {
      limit: depth,
    });
    const events: EventView[] = [];
    for (const s of sigs.slice(0, max)) {
      const tx = await this.conn.getTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
      });
      // web3.js types lag the RPC shape: logLines lives on the confirmed meta.
      const meta = tx?.meta as unknown as { logLines?: string[] } | undefined;
      const logs: string[] = meta?.logLines ?? [];
      for (const line of logs) {
        if (line.startsWith("Program data: ")) {
          const ev = await decodeEvent(line.slice("Program data: ".length));
          if (ev) events.push(ev);
        }
      }
    }
    return events;
  }

  /** True when the program is deployed at the configured address. */
  async programDeployed(): Promise<boolean> {
    const info = await this.conn.getAccountInfo(this.pid);
    return info !== null;
  }
}

export { CONFIG_SPACE, STRAIN_SPACE, VAULT_SPACE, PROPOSAL_SPACE, FOSSIL_SPACE };
