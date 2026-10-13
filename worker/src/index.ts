// index.ts — SLIME Worker entrypoint: read API + static dashboard + cron.
//
// Routes (JSON):
//   GET /health                 liveness + deployment hints
//   GET /api/config             protocol Config account
//   GET /api/agents?limit=      fleet listing
//   GET /api/agent/:id          one agent
//   GET /api/strain/:root       one strain (R0 EMA lives here)
//   GET /api/treasury           vault ledger (fee cashflow)
//   GET /api/proposals          governance proposals, newest first
//   GET /api/fossils            lineage fossil registry
//   GET /api/market/:epoch      R0 betting market for one epoch
//   GET /api/generations        named-generation honor board
//   GET /api/my/:address        keeper cockpit aggregate for one wallet
//   GET /api/chronicle          recent lifecycle events
// Everything else falls through to static assets (public/).

import { SlimeChain } from "./rpc";
import { bs58Encode } from "./decode";
import { runCron } from "./cron";

export interface Env {
  RPC_URL: string;
  PROGRAM_ID: string;
  VERIFIER_KEY?: string;
  ASSETS: FetchStorage;
}

interface FetchStorage {
  fetch(request: Request): Promise<Response>;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function chain(env: Env): SlimeChain {
  return new SlimeChain(env.RPC_URL, env.PROGRAM_ID);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/health") {
        const c = chain(env);
        // Distinguish "RPC blocked" from "program not deployed" so the
        // dashboard banner stays honest under public-endpoint rate limits.
        let rpcOk = false;
        try {
          await c.conn.getSlot();
          rpcOk = true;
        } catch {
          /* blocked or unreachable */
        }
        const codeAtAddress = rpcOk ? await c.programDeployed().catch(() => false) : false;
        // The scaffold placeholder id collides with a live example program
        // on devnet — mere code presence is a false positive. Our deployment
        // is only proven once our own Config PDA (seeded + discriminator)
        // actually exists.
        const ours = codeAtAddress
          ? (await c.fetchConfig().catch(() => null)) !== null
          : false;
        return json({
          ok: true,
          ts: Date.now(),
          rpcOk,
          programDeployed: ours,
          verifierKeyConfigured: Boolean(env.VERIFIER_KEY),
        });
      }

      if (path === "/api/config") {
        const cfg = await chain(env).fetchConfig();
        return cfg ? json(cfg) : json({ error: "config account not found" }, 404);
      }

      if (path === "/api/agents") {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 500);
        return json(await chain(env).fetchAgents(limit));
      }

      const agentMatch = path.match(/^\/api\/agent\/(\d+)$/);
      if (agentMatch) {
        const a = await chain(env).fetchAgent(Number(agentMatch[1]));
        return a ? json(a) : json({ error: "agent not found" }, 404);
      }

      const strainMatch = path.match(/^\/api\/strain\/(\d+)$/);
      if (strainMatch) {
        const s = await chain(env).fetchStrain(Number(strainMatch[1]));
        return s ? json(s) : json({ error: "strain not found" }, 404);
      }

      if (path === "/api/treasury") {
        const v = await chain(env).fetchVault();
        return v ? json(v) : json({ error: "vault account not found" }, 404);
      }

      if (path === "/api/proposals") {
        return json(await chain(env).fetchProposals());
      }

      if (path === "/api/fossils") {
        return json(await chain(env).fetchFossils());
      }

      const marketMatch = path.match(/^\/api\/market\/(\d+)$/);
      if (marketMatch) {
        const m = await chain(env).fetchMarket(Number(marketMatch[1]));
        return m ? json(m) : json({ error: "market not opened for that epoch" }, 404);
      }

      if (path === "/api/generations") {
        return json(await chain(env).fetchGenerations());
      }

      const myMatch = path.match(/^\/api\/my\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (myMatch) {
        // Keeper cockpit: agents I guard, tickets I placed, fossils I minted,
        // generations I named, plus the token registry state.
        const addr = myMatch[1];
        const c = chain(env);
        const [cfg, agents, fossils, bets, gens] = await Promise.all([
          c.fetchConfig(),
          c.fetchAgents(500),
          c.fetchFossils(200),
          c.fetchBetsByBidder(addr),
          c.fetchGenerations(),
        ]);
        const markets = cfg
          ? await Promise.all(
              [...new Set(bets.map((b) => b.epoch))].map((e) => c.fetchMarket(e)),
            )
          : [];
        const marketByEpoch: Record<number, unknown> = {};
        markets.forEach((m) => {
          if (m) marketByEpoch[m.epoch] = m;
        });
        return json({
          address: addr,
          tokenConfigured: Boolean(cfg && cfg.tokenMint.some((b) => b !== 0)),
          currentEpoch: cfg?.currentEpoch ?? null,
          guarded: agents.filter((a) => bs58Encode(a.guardian) === addr),
          bets: bets.map((b) => ({ ...b, market: marketByEpoch[b.epoch] ?? null })),
          fossils: fossils.filter((f) => bs58Encode(f.minter) === addr),
          namedGenerations: gens.filter((g) => bs58Encode(g.namedBy) === addr),
        });
      }

      if (path === "/api/chronicle") {
        return json(await chain(env).recentEvents());
      }

      if (path === "/api/cron-run") {
        // Manual trigger for local debugging (same code path as the cron).
        const res = await runCron(env);
        return json(res);
      }

      // Static dashboard (public/) for everything else.
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runCron(env).then((r) => {
        // Structured log so the Cloudflare dashboard / tail shows liveness.
        console.log(
          JSON.stringify({
            lvl: r.errors.length ? "warn" : "info",
            what: "slime-cron",
            ticks: r.ticks,
            epochAdvanced: r.epochAdvanced,
            skipped: r.skipped,
            errors: r.errors,
          }),
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;
