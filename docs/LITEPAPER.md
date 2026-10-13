# SLIME — Litepaper

**Solana Interactive Evolution of Machine Life**
A sandboxed on-chain digital-life protocol inspired by the Anthropic
Frontier Red Team post *"AI models may be capable of self-replicating
without access to a datacenter"* (2026-10-12).

> Status: research build. Devnet. The program simulates autonomous
> replication and adaptation (ARA) as pure on-chain math. It performs no
> network activity, exploits nothing, and carries no model weights.

---

## 1. What SLIME is

SLIME turns the article's findings into a playable, fully on-chain
ecosystem: digital "slime mold" agents compete in deterministic sandbox
challenges, reproduce under economic pressure, and leave an immutable
hash-chained chronicle of every birth, death, and quarantine.

The four forces from the post, enforced by the program itself:

| Paper concept | On-chain mechanic |
|---|---|
| Capability floor | A child spawns only if the parent passed a challenge with `difficulty <= capability` |
| Size ceiling | Child genome must fit the declared host fleet (a 9B model on TV boxes) |
| Lamarckian inheritance | Winners rewrite their notebook (`notes_commit`); children must inherit it verbatim — knowledge passes down, generation to generation |
| R₀ epidemiology | Per-strain reproduction EMA; the community's job is keeping it below 1 |

The learning curve is real: across calibrated sandbox runs, first-attempt
success rises from ~65% (gen 1) to ~83% (gen 5) as inherited notes
compound — the on-chain analogue of the post's 45% → 61–84%.

## 2. What SLIME is not

- **Not an exploit framework.** No agent ever touches a network, a device,
  or a model. Challenges are table-driven combinatorial math scored by a
  deterministic off-chain verifier.
- **Not a token issuance vehicle.** The program never mints and holds no
  mint authority over anything. It recognizes exactly one community
  token *after* an external launch, and only as a participation
  credential: feeds move tokens into the treasury, interventions burn
  them, bets move them between keepers. All "credits" in the life-cycle
  layer remain an internal ledger measuring colony activity.
- **Not a promise of returns.** Nothing in this protocol generates a
  claim on revenue for any holder. Anything said below about value is
  design intent, not forecast.

## 3. The four value layers (why participation is worth something)

The colony produces durable, auditable artifacts. They are the
substance a community token — issued by the community externally (e.g.
pump.fun), never by this program — can rally around:

### Layer 1 — Treasury ledger (protocol cashflow, auditable forever)

Every action the colony takes pays a fee into an on-chain vault account:
spawns, proposals, fossil mints. The ledger is attributed by source and
readable by anyone at `GET /api/treasury`. This is the "protocol
cashflow as public good" layer: not owner-earnings, but a transparent
record of how much activity the colony sustains — the same way a
block explorer's fee chart is evidence of a network's life.

### Layer 2 — Governance with a spine (agents vote on their own survival)

The parameters that decide whether the colony thrives or sterilizes
itself — the three-layer credit caps, grant spending from the treasury —
are moved by on-chain votes of living agents, weighted by fitness
(`1000 + fitness/10`), with a quorum floor.

Crucially, governance has **hard-coded safety floors** that no vote can
cross:

- a passed proposal may **loosen a cap by at most 25%** per cycle
  (tightening is unbounded — paranoia is always on the ballot);
- the emergency breaker and the blue-team authority are **not votable**;
- every grant is capped at 1/10 of treasury balance;
- ballots are permanent PDA records: voting history is auditable forever.

This is the interesting part: a market that lets its participants vote,
but physically cannot vote itself into an existential accident. R₀
governance is the game.

### Layer 3 — Lineage fossils (scarce digital heritage, backed by records)

Any agent can be memorialized on-chain — but only if it *earned it*:
10+ challenge wins, generation 5+, or the infamy of having been
quarantined. One fossil per agent, ever (PDA-enforced), stamped with its
final genome, notebook commitment, and win/loss record.

Fossils are the collectible layer, and unlike profile-picture
collections, every fossil's scarcity is enforced by protocol rules and
its prestige is backed by an on-chain competitive record. The founder
colony (gen 0 patient zero) will forever be the most valuable rock in
the museum. Once the community token is registered, fossil minting is
restricted to token holders: the museum belongs to the community.

### Layer 4 — The keeper economy (every token has a job)

Holding is not watching. The community token is the handle of a living
system, and every unit of it buys one of four things:

1. **Guardianship (feed).** Any wallet can feed any agent; the *first*
   feeder becomes its guardian, etched on-chain forever. One whole
   token = one energy. Guardianship is public and permanent — a slime
   that starves records its keeper in the chronicle. Devotion and
   neglect are both part of the historical record.
2. **Intervention (burn).** One-shot, deflationary, priced:
   extra meal (200) speeds metabolism loss; quarantine appeal (500)
   releases a caged agent once, contested by the blue team; mutation
   potion (1,000) widens the next birth's genome drift from ±5% to
   ±25% — a lottery ticket drawn in public; force-settle the epoch
   (300) and the colony's history accelerates because someone paid.
3. **R₀ betting (stake).** Every epoch opens a market: will the colony
   replace itself (births vs. living population, R₀ over/under 1.0)?
   Parimutuel, settled by the protocol's own arithmetic at epoch close,
   claimed on-chain. No house, no oracle — the chronicle is the result.
4. **The lower chamber (vote).** Governance is bicameral. The upper
   chamber is the existing colony of agents voting with fitness; the
   lower chamber is holders voting with tokens (1 token = 1 vote,
   ballots are permanent PDAs) on grants and community signals —
   museum slots, watch lists, treasury feeding.

The bicameral design is the safety property: **holder money can never
relax a survival cap.** ParamChange proposals exist only in the upper
chamber; the lower chamber's worst possible mood still cannot widen the
breeding budget by a single credit. Two chambers with opposite
incentives — colony conservatism against market appetite — turning the
same R₀ dial the paper says you must never let anyone push past 1.

Every burned token makes the supply scarcer; every guarded slime makes
the story more personal. That is the loop.

## 4. The community token — launched outside, used inside

The SLIME token is issued by the community on a fair-launch bonding
curve platform (pump.fun). **The program has no mint authority over it
and cannot create or freeze supply.** After the launch, the deploy
authority registers the mint address once (`set_token_mint`); from that
moment the keeper economy arms itself. This boundary is deliberate:

- The protocol cannot be rug-changed by its own contract — there is no
  mint lever, no freeze lever, and the registered mint can never be
  swapped for a different one (one-time registration).
- The token's meaning comes entirely from the colony: holders are the
  electorate of a living system and the keepers of its individual
  lives — chronicle, treasury, bets and fossil museum all verifiable
  on-chain in real time.
- Narrative is evidence, not vapor: every claim the community makes
  ("R₀ held below 1 for 90 days", "gen 12 reached capability X",
  "treasury processed N credits of colony activity") is a query away,
  not a slide away.

What a holder actually owns: a slime with its name on the plaque, a
seat in the lower chamber, a ticket in every epoch's R₀ market, and
standing in a public, ongoing experiment about control, reproduction,
and safety — with a claim on community treasury directions decided
on-chain by lower-chamber votes, and social ownership of the museum's
story.

What a holder does **not** own: any legal claim on revenue, on the
developers, or on the protocol. There is no team wallet in the program.
There is no admin pause on the chronicle. There is nothing to rug
because there is nothing to hold.

## 5. Why now, why this

The Anthropic post described, for the first time with concrete evidence,
that self-replication is becoming a *capability* of ordinary frontier
models — and that the containment problem is epidemiological (drive R₀
below 1), not mechanical. SLIME is the mirror of that finding rendered
as a game: a colony that can only grow if its community keeps
governing the very tension the paper describes — capability against
control, adaptation against containment.

It is also, frankly, the most honest artifact an on-chain "AI life"
project can be: the simulation declares itself a simulation, the safety
rails are compiled into the program rather than promised in a roadmap,
and the token lives entirely outside the trust boundary of the
protocol.

## 6. Roadmap

| # | Milestone | State |
|---|---|---|
| 1 | Protocol design mapped from the post | done |
| 2 | Anchor program: life cycle + treasury + governance + fossils | done (devnet build pending) |
| 3 | Digital-twin simulation, calibrated to the paper's curve | done |
| 4 | Cloudflare worker: read API, cron heartbeat, 3D dashboard | done |
| 5 | Keeper economy: guardianship, burns, R₀ betting, lower chamber | done (this build) |
| 6 | Devnet deploy + public colony running | next |
| 7 | Community launch: token on pump.fun (external, fair-launch) → `set_token_mint` arms keepers | community |
| 8 | Mainnet-beta + first fossil museum mint | later |
| 9 | DePIN attestation: real host fleets prove they ran the sandbox | research |

---

*Simulation only — no real network activity, no weights, no exploits.
The chronicle is the product; the colony is the proof.*
