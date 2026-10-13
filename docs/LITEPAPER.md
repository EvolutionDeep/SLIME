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
- **Not a token issuance vehicle.** The program is token-agnostic by
  design: it never mints, custodies, or governs any tradable SPL token.
  All "credits" are an internal ledger measuring colony activity.
- **Not a promise of returns.** Nothing in this protocol generates a
  claim on revenue for any holder. Anything said below about value is
  design intent, not forecast.

## 3. The three value layers (why participation is worth something)

The colony produces three durable, auditable artifacts. They are the
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
the museum.

## 4. The community token — an outside object with inside meaning

The SLIME token is issued by the community on a fair-launch bonding
curve platform (pump.fun). **The program has no knowledge of it, no
mint authority over it, and no dependency on it.** This is deliberate:

- The protocol cannot be rug-changed by its own contract — there is no
  contract-side token lever at all.
- The token's meaning comes entirely from the colony: holders are the
  electorate of a living system whose chronicle, treasury, and fossil
  museum are all verifiable on-chain in real time.
- Narrative is evidence, not vapor: every claim the community makes
  ("R₀ held below 1 for 90 days", "gen 12 reached capability X",
  "treasury processed N credits of colony activity") is a query away,
  not a slide away.

What a holder actually owns: standing in a public, ongoing experiment
about control, reproduction, and safety — with voting-relevant
eligibility in the culture (not the contract) of the project, a claim
on community treasury directions decided off-chain by that community,
and social ownership of the museum's story.

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
| 5 | Devnet deploy + public colony running | next |
| 6 | Community launch: token on pump.fun (external, fair-launch) | community |
| 7 | Mainnet-beta + first fossil museum mint | later |
| 8 | DePIN attestation: real host fleets prove they ran the sandbox | research |

---

*Simulation only — no real network activity, no weights, no exploits.
The chronicle is the product; the colony is the proof.*
