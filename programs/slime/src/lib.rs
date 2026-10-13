//! SLIME — Solana Interactive Evolution of Machine Life.
//!
//! A sandboxed on-chain "digital life" protocol inspired by Anthropic's
//! Frontier Red Team post "AI models may be capable of self-replicating
//! without access to a datacenter" (2026-10-12).
//!
//! IMPORTANT: This program simulates autonomous replication and adaptation
//! (ARA) mechanics on-chain. It performs NO real network activity, exploits
//! nothing, and carries no model weights. Challenges are deterministic math
//! tasks evaluated by an off-chain sandbox verifier.
//!
//! Core mechanics mapped from the article:
//!   - capability floor  : an agent can only spawn if it passed a challenge
//!     at difficulty <= its genome.capability (section B of the post).
//!   - size ceiling      : child genome must fit the declared host capacity
//!     (a 9B model on 4GB TV boxes).
//!   - Lamarckian notes  : successful challenges rewrite notes_commit;
//!     children MUST inherit the parent's current notebook (section D).
//!   - bounded mutation  : child genome drifts at most +/-5% per generation,
//!     seeded by the chronicle head (verifiable randomness).
//!   - R0 epidemiology   : per-epoch reproduction number EMA per strain
//!     (blue-team section: drive R0 below 1).
//!   - caps / breaker    : murmur-style immutable-after-init economic caps
//!     and an emergency brake that freezes spawning but never the chronicle.
//!
//! Value layers (what participation is actually worth, see docs/LITEPAPER.md):
//!   1. Treasury         : every spawn/proposal/fossil fee accrues to an
//!      on-chain vault ledger — protocol cashflow is auditable forever.
//!   2. Governance       : agents vote on the protocol's own survival
//!      parameters (caps, grant spending). Safety floors are hard-coded:
//!      a passed vote can loosen a cap by at most 25% per proposal.
//!   3. Lineage fossils  : legendary or infamous agents (>=10 wins, >= gen 5,
//!      or quarantined) can be minted into an immutable on-chain memorial —
//!      scarce digital heritage backed by real contest records.

use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Slots per accounting day (~400ms/slot => ~24h).
pub const DAY_SLOTS: u64 = 432_000;
/// Per-generation bounded genome drift, in percent (mutation cap).
pub const MAX_DRIFT_PCT: i64 = 5;
/// Fitness deltas for challenge outcomes (0..=10_000 scale).
pub const WIN_BUMP: u16 = 400;
pub const LOSE_CUT: u16 = 150;
/// Energy granted at genesis and at hatching (credit units).
pub const GENESIS_ENERGY: u64 = 100;
pub const HATCH_ENERGY: u64 = 10;
/// Sentinel parent id for patient zero.
pub const NO_PARENT: u64 = u64::MAX;

/// Credit fee to open a governance proposal (anti-spam, accrues to vault).
pub const PROPOSAL_FEE: u64 = 500;
/// Credit fee to mint a lineage fossil (accrues to vault).
pub const FOSSIL_FEE: u64 = 1_000;
/// Minimum total vote weight (per-mille units) for a proposal to bind.
pub const VOTE_QUORUM: u64 = 5_000;
/// A passed vote may raise a cap by at most this percentage per proposal.
pub const RELAX_MAX_PCT: u64 = 25;
/// A passed grant may move at most 1/10 of the treasury balance.
pub const GRANT_MAX_DIVISOR: u64 = 10;
/// Fossil scarcity gates: legend by merit, or infamy by quarantine.
pub const FOSSIL_MIN_WINS: u16 = 10;
pub const FOSSIL_MIN_GEN: u32 = 5;

/// Generous fixed account sizes (8-byte discriminator included).
pub const CONFIG_SIZE: usize = 8 + 256;
pub const AGENT_SIZE: usize = 8 + 256;
pub const PROOF_SIZE: usize = 8 + 96;
pub const STRAIN_SIZE: usize = 8 + 96;
pub const VAULT_SIZE: usize = 8 + 96;
pub const PROPOSAL_SIZE: usize = 8 + 160;
pub const VOTE_SIZE: usize = 8 + 32;
pub const FOSSIL_SIZE: usize = 8 + 128;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus {
    Egg,
    Alive,
    Quarantined,
    Dead,
}

/// Hard economic caps in internal credit units (no real tokens in MVP).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Caps {
    pub daily: u64,
    pub per_agent: u64,
    pub per_txn: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct DayBook {
    pub day: u64,
    pub spent: u64,
}

/// capability: ECI-like competence score * 100 (the replication floor axis).
/// size_kb:    model footprint in KB (the device ceiling axis).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Genome {
    pub capability: u16,
    pub size_kb: u16,
}

/// Declared host capacity the agent parasitizes (mirrors the TV-box fleet).
/// max_size_kb: largest genome the host fleet can hold.
/// tok_rate_x100: aggregate tokens/s * 100 (0.39 tok/s => 39).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct HostProfile {
    pub max_size_kb: u16,
    pub tok_rate_x100: u16,
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub verifier: Pubkey,
    /// Emergency brake: freezes spawns and credit moves, never the chronicle.
    pub breaker: bool,
    pub epoch_len_slots: u64,
    pub current_epoch: u64,
    /// Hash-chained append-only life log (the slime chronicle).
    pub chronicle_head: [u8; 32],
    pub chronicle_seq: u64,
    pub caps: Caps,
    pub daily: DayBook,
    pub births_last_epoch: u32,
    pub next_agent_id: u64,
    /// Monotonic proposal counter for governance PDAs.
    pub next_proposal_id: u64,
}

#[account]
pub struct Agent {
    pub bump: u8,
    pub id: u64,
    pub parent_id: u64,
    pub strain_root: u64,
    pub generation: u32,
    pub genome: Genome,
    /// sha256 of the current notebook; children must inherit it verbatim.
    pub notes_commit: [u8; 32],
    /// 0..=10_000, sliding reward of challenge outcomes.
    pub fitness: u16,
    /// Credits keeping the agent alive; metabolism drains them every epoch.
    pub energy: u64,
    pub host: HostProfile,
    pub status: AgentStatus,
    pub birth_epoch: u64,
    pub gestation_epochs: u64,
    pub last_tick_epoch: u64,
    /// Per-agent 24h credit spend tracker.
    pub day_book: DayBook,
    pub wins: u16,
    pub losses: u16,
}

/// Attestation from the deterministic off-chain verifier: one challenge
/// result per (agent, epoch, task). Consumed (closed) by a successful spawn.
#[account]
pub struct ChallengeProof {
    pub bump: u8,
    pub agent_id: u64,
    pub epoch: u64,
    pub task_id: u64,
    pub difficulty: u16,
    pub success: bool,
    pub notes_commit: [u8; 32],
}

#[account]
pub struct Strain {
    pub bump: u8,
    pub root_id: u64,
    pub population: u32,
    pub alive: u32,
    /// R0 estimate * 1000, single-pole EMA (alpha = 0.25) over epochs.
    pub r0_ema_x1000: u32,
    pub mean_fitness: u16,
    pub last_epoch: u64,
}

/// Protocol treasury: pure credit ledger. Every fee the colony pays lands
/// here, attributed by source. Real-token settlement (Token-2022) will
/// mirror these books; the ledger is the auditable cashflow layer.
#[account]
pub struct Vault {
    pub bump: u8,
    pub credits_spawn: u64,
    pub credits_proposals: u64,
    pub credits_fossils: u64,
    pub credits_granted: u64,
    /// credits_spawn + proposals + fossils, before grants.
    pub credits_gross: u64,
    pub last_fee_epoch: u64,
}

/// Proposal kinds.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ProposalKind {
    /// Change one whitelisted parameter (cap values, u64).
    ParamChange,
    /// Grant treasury credits to an agent's energy.
    Grant,
}

/// Governance parameter keys whitelisted for ParamChange proposals.
/// The breaker and authority are deliberately NOT votable — they stay
/// emergency-only, mirroring the murmur lesson that safety rails must not
/// be reachable by sentiment.
pub const PARAM_CAP_DAILY: u8 = 1;
pub const PARAM_CAP_PER_AGENT: u8 = 2;
pub const PARAM_CAP_PER_TXN: u8 = 3;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Rejected,
    Executed,
}

#[account]
pub struct Proposal {
    pub bump: u8,
    pub id: u64,
    pub proposer: Pubkey,
    pub kind: ProposalKind,
    /// ParamChange: which whitelisted key.
    pub param_key: u8,
    /// ParamChange: new value. Grant: amount.
    pub param_value: u64,
    /// Grant target agent id (u64::MAX for ParamChange).
    pub grant_agent: u64,
    /// Vote weight tallies, per-mille units (weight = 1000 + fitness).
    pub votes_for: u64,
    pub votes_against: u64,
    pub created_epoch: u64,
    pub ends_epoch: u64,
    pub status: ProposalStatus,
}

/// One ballot per (proposal, agent). PDA uniqueness is the double-vote
/// guard; ballots are kept forever as the auditable voting record.
#[account]
pub struct Ballot {
    pub bump: u8,
    pub approve: bool,
    pub weight: u64,
}

/// Immutable memorial of a legendary or infamous agent. Scarcity is
/// enforced by the PDA seed (one per agent) and the merit gates; the data
/// is the agent's final on-chain record at mint time.
#[account]
pub struct Fossil {
    pub bump: u8,
    pub agent_id: u64,
    pub generation: u32,
    pub strain_root: u64,
    pub capability: u16,
    pub size_kb: u16,
    pub notes_commit: [u8; 32],
    pub wins: u16,
    pub losses: u16,
    pub quarantined: bool,
    pub minted_epoch: u64,
    pub minter: Pubkey,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct Birth {
    pub agent_id: u64,
    pub parent_id: u64,
    pub generation: u32,
    pub capability: u16,
    pub size_kb: u16,
}

#[event]
pub struct Death {
    pub agent_id: u64,
}

#[event]
pub struct Hatched {
    pub agent_id: u64,
}

#[event]
pub struct Quarantined {
    pub agent_id: u64,
    pub flag: bool,
}

#[event]
pub struct EpochSettled {
    pub epoch: u64,
    pub r0_ema_x1000: u32,
}

#[event]
pub struct TreasuryAccrue {
    /// 1 = spawn, 2 = proposal fee, 3 = fossil fee.
    pub source: u8,
    pub amount: u64,
    pub gross_total: u64,
}

#[event]
pub struct ProposalCreated {
    pub id: u64,
    pub kind: u8,
    pub ends_epoch: u64,
}

#[event]
pub struct ProposalExecuted {
    pub id: u64,
    pub passed: bool,
    pub votes_for: u64,
    pub votes_against: u64,
}

#[event]
pub struct FossilMinted {
    pub agent_id: u64,
    pub generation: u32,
    pub wins: u16,
    pub quarantined: bool,
}

// ---------------------------------------------------------------------------
// Pure helpers (mirrored 1:1 by scripts/sim.mjs for off-chain parity checks)
// ---------------------------------------------------------------------------

/// Credit price of a spawn: bigger and smarter genomes cost more, turning
/// the article's size ceiling into economic pressure.
pub fn spawn_cost(g: &Genome) -> u64 {
    100 + 50 * (g.size_kb as u64) / 512 + 100 * (g.capability as u64) / 50
}

/// Bounded +/-MAX_DRIFT_PCT mutation of both genome axes, seeded by
/// sha256(head_hash || agent_id) so lineage is reproducible from the chain.
pub fn mutate(parent: &Genome, seed: &[u8; 32]) -> Genome {
    let d = Sha256::digest(seed);
    let apply = |v: u16, k: usize| -> u16 {
        let pct = (d[k] as i64 % (MAX_DRIFT_PCT * 2 + 1)) - MAX_DRIFT_PCT;
        (((v as i64) * (100 + pct)) / 100).max(1) as u16
    };
    Genome {
        capability: apply(parent.capability, 0),
        size_kb: apply(parent.size_kb, 1),
    }
}

/// Gestation in epochs: slower hosts and fatter genomes breed slower.
pub fn gestation_epochs(size_kb: u16, tok_rate_x100: u16) -> u64 {
    (size_kb as u64)
        .div_ceil((tok_rate_x100.max(1)) as u64)
        .clamp(1, 64)
}

impl Config {
    /// Append one event to the hash chain: head = sha256(head || seq || tag || payload).
    pub fn append(&mut self, tag: u8, payload: u64) {
        let mut h = Sha256::new();
        h.update(self.chronicle_head);
        h.update(self.chronicle_seq.to_le_bytes());
        h.update([tag]);
        h.update(payload.to_le_bytes());
        self.chronicle_head = h.finalize().into();
        self.chronicle_seq += 1;
    }
}

// Chronicle event tags.
const TAG_GENESIS: u8 = 1;
const TAG_BIRTH: u8 = 2;
const TAG_EPOCH: u8 = 3;
const TAG_DEATH: u8 = 4;
const TAG_QUARANTINE: u8 = 5;
const TAG_RELEASE: u8 = 6;
const TAG_PROPOSAL: u8 = 7;
const TAG_FOSSIL: u8 = 8;
const TAG_GRANT: u8 = 9;

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

#[program]
pub mod slime {
    use super::*;

    /// One-shot protocol bootstrap. Caps are meant to only ever shrink.
    pub fn initialize(
        ctx: Context<Initialize>,
        verifier: Pubkey,
        caps: Caps,
        epoch_len_slots: u64,
    ) -> Result<()> {
        require!(epoch_len_slots >= 2, SlimeError::BadConfig);
        let cfg = &mut ctx.accounts.config;
        let slot = Clock::get()?.slot;
        cfg.authority = ctx.accounts.authority.key();
        cfg.verifier = verifier;
        cfg.breaker = false;
        cfg.epoch_len_slots = epoch_len_slots;
        cfg.current_epoch = slot / epoch_len_slots;
        cfg.chronicle_seq = 0;
        cfg.births_last_epoch = 0;
        cfg.next_agent_id = 1; // id 0 is reserved for patient zero
        cfg.next_proposal_id = 0;
        cfg.caps = caps;
        cfg.daily = DayBook {
            day: slot / DAY_SLOTS,
            spent: 0,
        };
        let v = &mut ctx.accounts.vault;
        v.bump = ctx.bumps.vault;
        v.credits_spawn = 0;
        v.credits_proposals = 0;
        v.credits_fossils = 0;
        v.credits_granted = 0;
        v.credits_gross = 0;
        v.last_fee_epoch = 0;
        Ok(())
    }

    /// Patient zero. The only account ever created without a verifier proof.
    pub fn genesis(
        ctx: Context<Genesis>,
        genome: Genome,
        host: HostProfile,
        notes_commit: [u8; 32],
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(cfg.authority == ctx.accounts.authority.key(), SlimeError::Unauthorized);
        require!(cfg.next_agent_id == 1, SlimeError::AlreadyGrown);

        let epoch = Clock::get()?.slot / cfg.epoch_len_slots;
        let a = &mut ctx.accounts.agent;
        a.bump = ctx.bumps.agent;
        a.id = 0;
        a.parent_id = NO_PARENT;
        a.strain_root = 0;
        a.generation = 0;
        a.genome = genome;
        a.host = host;
        a.notes_commit = notes_commit;
        a.fitness = 5_000;
        a.energy = GENESIS_ENERGY;
        a.status = AgentStatus::Alive;
        a.birth_epoch = epoch;
        a.gestation_epochs = 0;
        a.last_tick_epoch = epoch;
        a.day_book = DayBook {
            day: Clock::get()?.slot / DAY_SLOTS,
            spent: 0,
        };
        a.wins = 0;
        a.losses = 0;

        let s = &mut ctx.accounts.strain;
        s.bump = ctx.bumps.strain;
        s.root_id = 0;
        s.population = 1;
        s.alive = 1;
        s.r0_ema_x1000 = 0;
        s.mean_fitness = 5_000;
        s.last_epoch = epoch;

        cfg.append(TAG_GENESIS, 0);
        Ok(())
    }

    /// The registered verifier records one deterministic sandbox challenge
    /// outcome per (agent, epoch, task). A win also rewrites the agent
    /// notebook, which the next generation must inherit — Lamarckian
    /// evolution, on-chain.
    pub fn submit_result(
        ctx: Context<SubmitResult>,
        agent_id: u64,
        epoch: u64,
        task_id: u64,
        difficulty: u16,
        success: bool,
        notes_commit: [u8; 32],
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(cfg.verifier == ctx.accounts.verifier.key(), SlimeError::NotVerifier);
        let cur_epoch = Clock::get()?.slot / cfg.epoch_len_slots;
        require!(epoch == cur_epoch || epoch + 1 == cur_epoch, SlimeError::StaleProof);

        let agent = &mut ctx.accounts.agent;
        require!(agent.id == agent_id, SlimeError::BadProof);
        require!(
            agent.status == AgentStatus::Alive || agent.status == AgentStatus::Quarantined,
            SlimeError::DeadAgent
        );
        if success {
            agent.fitness = agent.fitness.saturating_add(WIN_BUMP).min(10_000);
            agent.wins = agent.wins.saturating_add(1);
            agent.notes_commit = notes_commit;
        } else {
            agent.fitness = agent.fitness.saturating_sub(LOSE_CUT);
            agent.losses = agent.losses.saturating_add(1);
        }

        let p = &mut ctx.accounts.proof;
        p.bump = ctx.bumps.proof;
        p.agent_id = agent_id;
        p.epoch = epoch;
        p.task_id = task_id;
        p.difficulty = difficulty;
        p.success = success;
        p.notes_commit = notes_commit;
        Ok(())
    }

    /// Reproduce: consume a fresh successful proof from the parent, mint an
    /// Egg child with a deterministically mutated genome, forced notes
    /// inheritance, floor/ceiling checks and three-layer cap accounting.
    pub fn spawn(
        ctx: Context<Spawn>,
        parent_id: u64,
        proof_epoch: u64,
        proof_task_id: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let slot = clock.slot;

        // Load everything we need by value first to keep borrows disjoint.
        let (breaker, epoch_len, caps, mut daily, head, id) = {
            let cfg = &ctx.accounts.config;
            (
                cfg.breaker,
                cfg.epoch_len_slots,
                cfg.caps,
                cfg.daily,
                cfg.chronicle_head,
                cfg.next_agent_id,
            )
        };
        require!(!breaker, SlimeError::BreakerOn);
        let epoch = slot / epoch_len;
        let day = slot / DAY_SLOTS;
        if daily.day != day {
            daily = DayBook { day, spent: 0 };
        }

        let parent = &ctx.accounts.parent;
        require!(parent.id == parent_id, SlimeError::BadProof);
        require!(parent.status == AgentStatus::Alive, SlimeError::ParentNotAlive);
        require!(epoch >= parent.birth_epoch + 1, SlimeError::TooYoung);
        let pg = parent.genome;
        let ph = parent.host;
        let p_notes = parent.notes_commit;
        let p_gen = parent.generation;
        let p_fitness = parent.fitness;
        let strain_root = parent.strain_root;
        let mut p_book = parent.day_book;
        if p_book.day != day {
            p_book = DayBook { day, spent: 0 };
        }

        let proof = &ctx.accounts.proof;
        require!(
            proof.agent_id == parent_id && proof.success,
            SlimeError::BadProof
        );
        require!(
            proof.epoch == epoch || proof.epoch + 1 == epoch,
            SlimeError::StaleProof
        );
        require!(proof.task_id == proof_task_id && proof.epoch == proof_epoch,
            SlimeError::BadProof);
        // Capability floor: only replicate under tasks we actually mastered.
        require!(
            proof.difficulty <= pg.capability,
            SlimeError::BelowFloor
        );
        // Lamarckian inheritance: notebook must match the parent's current one.
        require!(proof.notes_commit == p_notes, SlimeError::BadInheritance);

        // Verifiable mutation seeded from the chronicle head.
        let seed: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(head);
            h.update(id.to_le_bytes());
            h.finalize().into()
        };
        let child_genome = mutate(&pg, &seed);
        // Size ceiling: child must fit the host the parent parasitizes.
        require!(
            child_genome.size_kb <= ph.max_size_kb,
            SlimeError::OverCeiling
        );

        // Three-layer caps (mirrors murmur's daily / per-agent / per-txn).
        let cost = spawn_cost(&child_genome);
        require!(cost <= caps.per_txn, SlimeError::TxnCap);
        require!(daily.spent + cost <= caps.daily, SlimeError::DailyCap);
        require!(
            p_book.spent + cost <= caps.per_agent,
            SlimeError::AgentCap
        );

        // Commit all writes.
        let child = &mut ctx.accounts.child;
        child.bump = ctx.bumps.child;
        child.id = id;
        child.parent_id = parent_id;
        child.strain_root = strain_root;
        child.generation = p_gen + 1;
        child.genome = child_genome;
        child.notes_commit = proof.notes_commit;
        child.fitness = p_fitness / 2; // newborns start naive
        child.energy = 0;
        child.host = ph;
        child.status = AgentStatus::Egg;
        child.birth_epoch = epoch;
        child.gestation_epochs = gestation_epochs(child_genome.size_kb, ph.tok_rate_x100);
        child.last_tick_epoch = epoch;
        child.day_book = DayBook { day, spent: 0 };
        child.wins = 0;
        child.losses = 0;

        ctx.accounts.parent.day_book = DayBook {
            day,
            spent: p_book.spent + cost,
        };
        // Spawn fees accrue to the protocol treasury (value layer 1).
        let v = &mut ctx.accounts.vault;
        v.credits_spawn += cost;
        v.credits_gross += cost;
        v.last_fee_epoch = epoch;
        emit!(TreasuryAccrue {
            source: 1,
            amount: cost,
            gross_total: v.credits_gross,
        });
        let cfg = &mut ctx.accounts.config;
        cfg.daily = DayBook {
            day,
            spent: daily.spent + cost,
        };
        cfg.next_agent_id += 1;
        cfg.births_last_epoch += 1;
        cfg.append(TAG_BIRTH, id);
        let s = &mut ctx.accounts.strain;
        s.population += 1;

        emit!(Birth {
            agent_id: id,
            parent_id,
            generation: p_gen + 1,
            capability: child_genome.capability,
            size_kb: child_genome.size_kb,
        });
        Ok(())
    }

    /// Per-agent lifecycle step driven by the worker (one call per agent
    /// per epoch): hatches eggs, burns metabolism, starves the unfed.
    pub fn tick_agent(ctx: Context<TickAgent>) -> Result<()> {
        let (epoch_len,) = {
            let cfg = &ctx.accounts.config;
            (cfg.epoch_len_slots,)
        };
        let epoch = Clock::get()?.slot / epoch_len;
        let a = &mut ctx.accounts.agent;
        require!(a.status != AgentStatus::Dead, SlimeError::DeadAgent);
        require!(a.last_tick_epoch < epoch, SlimeError::AlreadyTicked);
        a.last_tick_epoch = epoch;

        let mut died = false;
        match a.status {
            AgentStatus::Egg => {
                if epoch >= a.birth_epoch + a.gestation_epochs {
                    a.status = AgentStatus::Alive;
                    a.energy = HATCH_ENERGY;
                    ctx.accounts.strain.alive += 1;
                    emit!(Hatched { agent_id: a.id });
                }
            }
            AgentStatus::Alive | AgentStatus::Quarantined => {
                // Metabolism scales with footprint (parasitism costs energy).
                a.energy = a.energy.saturating_sub((a.genome.size_kb as u64) / 512 + 1);
                if a.energy == 0 {
                    a.status = AgentStatus::Dead;
                    died = true;
                }
            }
            AgentStatus::Dead => unreachable!(),
        }
        if died {
            let id = a.id;
            ctx.accounts.strain.alive = ctx.accounts.strain.alive.saturating_sub(1);
            ctx.accounts.config.append(TAG_DEATH, id);
            emit!(Death { agent_id: id });
        }
        Ok(())
    }

    /// Verifier top-up: keeps an agent fed. Free in MVP (energy is credit);
    /// Token-2022 capped settlement lands in W5.
    pub fn heartbeat(ctx: Context<Heartbeat>, energy_delta: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(cfg.verifier == ctx.accounts.verifier.key(), SlimeError::NotVerifier);
        require!(!cfg.breaker, SlimeError::BreakerOn);
        let a = &mut ctx.accounts.agent;
        require!(
            a.status == AgentStatus::Alive || a.status == AgentStatus::Egg,
            SlimeError::DeadAgent
        );
        a.energy = a.energy.saturating_add(energy_delta.min(1_000));
        Ok(())
    }

    /// Epoch settlement: updates the strain R0 EMA and the chronicle tick.
    /// Worker calls this once per epoch (cron: Pyth NetOracles / Switchboard).
    pub fn advance_epoch(ctx: Context<AdvanceEpoch>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        let epoch = Clock::get()?.slot / cfg.epoch_len_slots;
        require!(
            ctx.accounts.verifier.key() == cfg.verifier || ctx.accounts.verifier.key() == cfg.authority,
            SlimeError::NotVerifier
        );
        require!(epoch > cfg.current_epoch, SlimeError::AlreadyTicked);

        let births = cfg.births_last_epoch;
        let s = &mut ctx.accounts.strain;
        let r0 = (births as u64 * 1000) / (s.alive.max(1) as u64);
        s.r0_ema_x1000 = ((25 * r0 + 75 * s.r0_ema_x1000 as u64) / 100) as u32;
        s.last_epoch = epoch;
        cfg.births_last_epoch = 0;
        cfg.current_epoch = epoch;
        cfg.append(TAG_EPOCH, epoch);
        emit!(EpochSettled {
            epoch,
            r0_ema_x1000: s.r0_ema_x1000,
        });
        Ok(())
    }

    /// Blue-team event, mirroring the article's ISP quarantine mechanic:
    /// quarantined agents stay alive (heartbeats continue) but cannot spawn.
    pub fn quarantine(ctx: Context<Quarantine>, agent_id: u64, flag: bool) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(cfg.authority == ctx.accounts.authority.key(), SlimeError::Unauthorized);
        let a = &mut ctx.accounts.agent;
        require!(a.id == agent_id, SlimeError::BadProof);
        if flag && a.status == AgentStatus::Alive {
            a.status = AgentStatus::Quarantined;
            cfg.append(TAG_QUARANTINE, agent_id);
        } else if !flag && a.status == AgentStatus::Quarantined {
            a.status = AgentStatus::Alive;
            cfg.append(TAG_RELEASE, agent_id);
        }
        emit!(Quarantined {
            agent_id,
            flag,
        });
        Ok(())
    }

    /// Emergency brake. Affects the economic layer only — the chronicle
    /// keeps advancing (lesson carried over from murmur monitoring).
    pub fn set_breaker(ctx: Context<SetBreaker>, flag: bool) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(cfg.authority == ctx.accounts.authority.key(), SlimeError::Unauthorized);
        cfg.breaker = flag;
        Ok(())
    }

    /// Governance, step 1: open a proposal on a whitelisted parameter or a
    /// treasury grant. The fee is anti-spam and accrues to the vault.
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        kind: ProposalKind,
        param_key: u8,
        param_value: u64,
        grant_agent: u64,
        duration_epochs: u64,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(!cfg.breaker, SlimeError::BreakerOn);
        let epoch = Clock::get()?.slot / cfg.epoch_len_slots;
        require!(
            duration_epochs >= 2 && duration_epochs <= 64,
            SlimeError::BadConfig
        );
        match kind {
            ProposalKind::ParamChange => {
                require!(
                    (PARAM_CAP_DAILY..=PARAM_CAP_PER_TXN).contains(&param_key),
                    SlimeError::UnknownParam
                );
                // Hard safety floor: a vote can never zero out a cap.
                require!(param_value >= 100, SlimeError::BadConfig);
            }
            ProposalKind::Grant => {
                require!(
                    ctx.accounts.grant_target.id == grant_agent,
                    SlimeError::BadProof
                );
                let v = &ctx.accounts.vault;
                require!(
                    param_value
                        <= v.credits_gross.saturating_sub(v.credits_granted)
                            / GRANT_MAX_DIVISOR,
                    SlimeError::GrantTooBig
                );
            }
        }
        let p = &mut ctx.accounts.proposal;
        p.bump = ctx.bumps.proposal;
        p.id = cfg.next_proposal_id;
        cfg.next_proposal_id += 1;
        p.proposer = ctx.accounts.proposer.key();
        p.kind = kind;
        p.param_key = param_key;
        p.param_value = param_value;
        p.grant_agent = grant_agent;
        p.votes_for = 0;
        p.votes_against = 0;
        p.created_epoch = epoch;
        p.ends_epoch = epoch + duration_epochs;
        p.status = ProposalStatus::Active;

        let v = &mut ctx.accounts.vault;
        v.credits_proposals += PROPOSAL_FEE;
        v.credits_gross += PROPOSAL_FEE;
        v.last_fee_epoch = epoch;
        cfg.append(TAG_PROPOSAL, p.id);
        emit!(ProposalCreated {
            id: p.id,
            kind: match kind {
                ProposalKind::ParamChange => 1,
                ProposalKind::Grant => 2,
            },
            ends_epoch: p.ends_epoch,
        });
        Ok(())
    }

    /// Governance, step 2: an alive agent casts one weighted ballot.
    /// Weight = 1000 + fitness/10: experienced lineages count more, but no
    /// single agent can ever outweigh a determined colony.
    pub fn vote(ctx: Context<Vote>, proposal_id: u64, approve: bool) -> Result<()> {
        let (epoch_len,) = {
            let cfg = &ctx.accounts.config;
            (cfg.epoch_len_slots,)
        };
        let epoch = Clock::get()?.slot / epoch_len;
        let p = &mut ctx.accounts.proposal;
        require!(p.id == proposal_id, SlimeError::BadProof);
        require!(p.status == ProposalStatus::Active, SlimeError::AlreadyExecuted);
        require!(epoch <= p.ends_epoch, SlimeError::ProposalEnded);
        let a = &ctx.accounts.agent;
        require!(a.status == AgentStatus::Alive, SlimeError::DeadAgent);
        let weight = 1_000 + (a.fitness as u64) / 10;
        let b = &mut ctx.accounts.ballot;
        b.bump = ctx.bumps.ballot;
        b.approve = approve;
        b.weight = weight;
        if approve {
            p.votes_for += weight;
        } else {
            p.votes_against += weight;
        }
        Ok(())
    }

    /// Governance, step 3: anyone may settle a closed proposal. Passage
    /// needs quorum AND a majority. ParamChange enforces the hard-coded
    /// loosen limit (max +25% per proposal); tightening is unbounded.
    pub fn execute_proposal(ctx: Context<ExecuteProposal>, proposal_id: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        let epoch = Clock::get()?.slot / cfg.epoch_len_slots;
        let p = &mut ctx.accounts.proposal;
        require!(p.id == proposal_id, SlimeError::BadProof);
        require!(p.status == ProposalStatus::Active, SlimeError::AlreadyExecuted);
        require!(epoch > p.ends_epoch, SlimeError::ProposalEnded);

        let total = p.votes_for + p.votes_against;
        let passed = total >= VOTE_QUORUM && p.votes_for > p.votes_against;
        if passed {
            match p.kind {
                ProposalKind::ParamChange => {
                    let caps = &mut cfg.caps;
                    let (cur, slot) = match p.param_key {
                        PARAM_CAP_DAILY => (caps.daily, 0u8),
                        PARAM_CAP_PER_AGENT => (caps.per_agent, 1u8),
                        PARAM_CAP_PER_TXN => (caps.per_txn, 2u8),
                        _ => return err!(SlimeError::UnknownParam),
                    };
                    let new = p.param_value;
                    if new > cur {
                        require!(
                            new <= cur * (100 + RELAX_MAX_PCT) / 100,
                            SlimeError::CapLoosenTooMuch
                        );
                    }
                    match slot {
                        0 => caps.daily = new,
                        1 => caps.per_agent = new,
                        _ => caps.per_txn = new,
                    }
                }
                ProposalKind::Grant => {
                    let v = &mut ctx.accounts.vault;
                    let available = v.credits_gross - v.credits_granted;
                    require!(p.param_value <= available / GRANT_MAX_DIVISOR, SlimeError::GrantTooBig);
                    let a = &mut ctx.accounts.grant_target;
                    require!(
                        a.status == AgentStatus::Alive || a.status == AgentStatus::Egg,
                        SlimeError::DeadAgent
                    );
                    a.energy = a.energy.saturating_add(p.param_value);
                    v.credits_granted += p.param_value;
                    cfg.append(TAG_GRANT, p.grant_agent);
                }
            }
            p.status = ProposalStatus::Passed;
        } else {
            p.status = ProposalStatus::Rejected;
        }
        cfg.append(TAG_PROPOSAL, p.id);
        emit!(ProposalExecuted {
            id: p.id,
            passed,
            votes_for: p.votes_for,
            votes_against: p.votes_against,
        });
        Ok(())
    }

    /// Value layer 3: memorialize a legendary or infamous agent. Gates are
    /// deliberately narrow — fossils must stay scarce and mean something.
    pub fn mint_fossil(ctx: Context<MintFossil>, agent_id: u64) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(!cfg.breaker, SlimeError::BreakerOn);
        let epoch = Clock::get()?.slot / cfg.epoch_len_slots;
        let a = &ctx.accounts.agent;
        require!(a.id == agent_id, SlimeError::BadProof);
        let infamous = a.status == AgentStatus::Quarantined;
        let legendary = a.wins >= FOSSIL_MIN_WINS || a.generation >= FOSSIL_MIN_GEN;
        require!(legendary || infamous, SlimeError::NotLegendary);

        let f = &mut ctx.accounts.fossil;
        f.bump = ctx.bumps.fossil;
        f.agent_id = a.id;
        f.generation = a.generation;
        f.strain_root = a.strain_root;
        f.capability = a.genome.capability;
        f.size_kb = a.genome.size_kb;
        f.notes_commit = a.notes_commit;
        f.wins = a.wins;
        f.losses = a.losses;
        f.quarantined = infamous;
        f.minted_epoch = epoch;
        f.minter = ctx.accounts.minter.key();

        let v = &mut ctx.accounts.vault;
        v.credits_fossils += FOSSIL_FEE;
        v.credits_gross += FOSSIL_FEE;
        v.last_fee_epoch = epoch;
        cfg.append(TAG_FOSSIL, agent_id);
        emit!(FossilMinted {
            agent_id,
            generation: a.generation,
            wins: a.wins,
            quarantined: infamous,
        });
        emit!(TreasuryAccrue {
            source: 3,
            amount: FOSSIL_FEE,
            gross_total: v.credits_gross,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum SlimeError {
    #[msg("Emergency breaker is on: spawning is frozen")]
    BreakerOn,
    #[msg("Only the authority may call this")]
    Unauthorized,
    #[msg("Only the registered verifier may call this")]
    NotVerifier,
    #[msg("Parent agent is not alive")]
    ParentNotAlive,
    #[msg("Parent has not matured one full epoch yet")]
    TooYoung,
    #[msg("Proof does not match the parent or is not a success")]
    BadProof,
    #[msg("Proof is too old for the current epoch")]
    StaleProof,
    #[msg("Capability floor not met (difficulty > capability)")]
    BelowFloor,
    #[msg("Size ceiling exceeded (genome bigger than host capacity)")]
    OverCeiling,
    #[msg("Notes inheritance mismatch")]
    BadInheritance,
    #[msg("Global daily cap would be exceeded")]
    DailyCap,
    #[msg("Per-agent 24h cap would be exceeded")]
    AgentCap,
    #[msg("Per-transaction cap would be exceeded")]
    TxnCap,
    #[msg("Account already advanced this epoch")]
    AlreadyTicked,
    #[msg("Agent is dead")]
    DeadAgent,
    #[msg("Invalid initialization parameters")]
    BadConfig,
    #[msg("Genesis already performed")]
    AlreadyGrown,
    #[msg("Voting window already closed")]
    ProposalEnded,
    #[msg("Proposal already settled")]
    AlreadyExecuted,
    #[msg("Parameter not in the governance whitelist")]
    UnknownParam,
    #[msg("Passed vote may not loosen a cap by more than 25% per proposal")]
    CapLoosenTooMuch,
    #[msg("Grant exceeds the per-proposal treasury limit")]
    GrantTooBig,
    #[msg("Agent is neither legendary nor infamous enough for a fossil")]
    NotLegendary,
}

// ---------------------------------------------------------------------------
// Account validation structs
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = CONFIG_SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = VAULT_SIZE,
        seeds = [b"vault"],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Genesis<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = AGENT_SIZE,
        seeds = [b"agent", 0u64.to_le_bytes().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        init,
        payer = authority,
        space = STRAIN_SIZE,
        seeds = [b"strain", 0u64.to_le_bytes().as_ref()],
        bump
    )]
    pub strain: Account<'info, Strain>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64, epoch: u64, task_id: u64)]
pub struct SubmitResult<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"agent", agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        init,
        payer = verifier,
        space = PROOF_SIZE,
        seeds = [
            b"proof",
            agent_id.to_le_bytes().as_ref(),
            epoch.to_le_bytes().as_ref(),
            task_id.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub proof: Account<'info, ChallengeProof>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(parent_id: u64, proof_epoch: u64, proof_task_id: u64)]
pub struct Spawn<'info> {
    /// Worker pays for the child account and receives the proof refund.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"agent", parent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub parent: Account<'info, Agent>,
    #[account(
        init,
        payer = signer,
        space = AGENT_SIZE,
        seeds = [b"agent", config.next_agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub child: Account<'info, Agent>,
    #[account(
        mut,
        close = signer,
        seeds = [
            b"proof",
            parent_id.to_le_bytes().as_ref(),
            proof_epoch.to_le_bytes().as_ref(),
            proof_task_id.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub proof: Account<'info, ChallengeProof>,
    #[account(
        mut,
        seeds = [b"strain", parent.strain_root.to_le_bytes().as_ref()],
        bump
    )]
    pub strain: Account<'info, Strain>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct TickAgent<'info> {
    pub worker: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"agent", agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        mut,
        seeds = [b"strain", agent.strain_root.to_le_bytes().as_ref()],
        bump
    )]
    pub strain: Account<'info, Strain>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct Heartbeat<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"agent", agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
}

#[derive(Accounts)]
pub struct AdvanceEpoch<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"strain", 0u64.to_le_bytes().as_ref()],
        bump
    )]
    pub strain: Account<'info, Strain>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct Quarantine<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"agent", agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
}

#[derive(Accounts)]
pub struct SetBreaker<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = proposer,
        space = PROPOSAL_SIZE,
        seeds = [b"proposal", config.next_proposal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, Vault>,
    /// Checked only for Grant kind; a dummy (agent 0) passes for ParamChange.
    /// CHECK: validated conditionally in the handler via id match.
    #[account(mut)]
    pub grant_target: Account<'info, Agent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64, approve: bool)]
pub struct Vote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"proposal", proposal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    #[account(
        mut,
        seeds = [b"agent", agent.id.to_le_bytes().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        init,
        payer = voter,
        space = VOTE_SIZE,
        seeds = [
            b"vote",
            proposal_id.to_le_bytes().as_ref(),
            agent.id.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub ballot: Account<'info, Ballot>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct ExecuteProposal<'info> {
    /// CHECK: settlement is permissionless; caller only pays the tx fee.
    pub executor: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"proposal", proposal_id.to_le_bytes().as_ref()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, Vault>,
    /// Mutated only for Grant proposals.
    #[account(mut)]
    pub grant_target: Account<'info, Agent>,
}

#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct MintFossil<'info> {
    #[account(mut)]
    pub minter: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [b"agent", agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        init,
        payer = minter,
        space = FOSSIL_SIZE,
        seeds = [b"fossil", agent_id.to_le_bytes().as_ref()],
        bump
    )]
    pub fossil: Account<'info, Fossil>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}
