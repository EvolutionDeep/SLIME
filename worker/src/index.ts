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
//   GET /api/chronicle          recent lifecycle events
// Everything else falls through to static assets (public/).

import { SlimeChain } from "./rpc";
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
        const deployed = rpcOk ? await c.programDeployed().catch(() => false) : false;
        return json({
          ok: true,
          ts: Date.now(),
          rpcOk,
          programDeployed: deployed,
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
