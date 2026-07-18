/**
 * Express adapter — mount a full streaming-settlement API in one line:
 *
 *   app.use("/meter", createMeterRouter({ store, meter, provider }));
 *
 * Endpoints:
 *   GET  /streams                list metered resources
 *   POST /streams                register a resource ({ id, title, ratePerSecond, asset, ... })
 *   POST /sessions               open a session ({ streamId, agent, policy?, objective? })
 *   POST /sessions/:id/tick      pay one tick (quote -> settle -> commit) and get the next chunk
 *   POST /sessions/:id/close     close the gate ({ reason? })
 *   GET  /impact                 public proof snapshot (totals + recent settlements + decisions)
 *
 * `express` is a peer dependency so meter402's core stays framework-free.
 */

import { type Request, type Response, type Router } from "express";
import express from "express";
import { MeterError, type StreamingMeter } from "./meter.js";
import type { SettlementProvider } from "./settlement.js";
import type { MemoryStore } from "./store.js";
import type { StreamSpec } from "./types.js";

export interface MeterRouterOptions {
  store: MemoryStore;
  meter: StreamingMeter;
  provider: SettlementProvider;
  /** Optional: produce the next chunk of streamed content after a paid tick. */
  deliver?: (streamId: string, sessionId: string) => unknown;
}

export function createMeterRouter(opts: MeterRouterOptions): Router {
  const { store, meter, provider, deliver } = opts;
  const r = express.Router();
  r.use(express.json());

  const fail = (res: Response, e: unknown) => {
    if (e instanceof MeterError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: (e as Error).message });
  };

  r.get("/streams", (_req, res) => {
    res.json([...store.streams.values()]);
  });

  r.post("/streams", (req: Request, res: Response) => {
    const s = req.body as StreamSpec;
    if (!s?.id || !s?.ratePerSecond || !s?.asset) {
      return res.status(400).json({ error: "id, ratePerSecond and asset are required" });
    }
    res.status(201).json(store.addStream(s));
  });

  r.post("/sessions", (req: Request, res: Response) => {
    try {
      const { streamId, agent, policy, objective } = req.body ?? {};
      if (!streamId || !agent) return res.status(400).json({ error: "streamId and agent are required" });
      res.status(201).json(meter.openSession(streamId, agent, { policy, objective }));
    } catch (e) {
      fail(res, e);
    }
  });

  r.post("/sessions/:id/tick", async (req: Request, res: Response) => {
    try {
      const quote = meter.quoteTick(req.params.id);
      const result = await provider.settle(quote);
      const { session, event } = meter.commitTick(quote, result);
      const data = deliver ? deliver(session.streamId, session.id) : undefined;
      res.json({ session, settlement: event, data });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post("/sessions/:id/close", (req: Request, res: Response) => {
    try {
      res.json(meter.closeSession(req.params.id, req.body?.reason));
    } catch (e) {
      fail(res, e);
    }
  });

  r.get("/impact", (_req, res) => {
    res.json(meter.impact());
  });

  return r;
}
