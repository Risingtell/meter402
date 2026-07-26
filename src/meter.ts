/**
 * StreamingMeter — the core meter402 primitive.
 *
 * x402 is a per-request protocol; streaming is modelled as a pull loop where each tick settles for
 * the wall-clock time the agent held the stream since its last paid tick. Pay the tick → get the
 * next chunk. Skip/refuse a tick → the next chunk never comes (the gate shuts). Every successful
 * tick is one real (or, in MOCK mode, simulated) settlement.
 *
 * Billing is split into two phases so the same core serves both paths:
 *   - quoteTick():  pure computation of what this tick owes (no mutation). In LIVE mode this feeds
 *                   the x402 dynamic-price function BEFORE the facilitator settles.
 *   - commitTick(): records the settlement + advances the session AFTER it has been paid (in LIVE
 *                   mode, from the after-settle hook with the real on-chain tx hash).
 */

import { randomUUID } from "node:crypto";
import type {
  AgentDecision,
  ImpactSnapshot,
  MeterStore,
  Session,
  SettlementEvent,
  StreamSpec,
} from "./types.js";

export interface MeterConfig {
  /** Default payee when a stream doesn't specify its own. */
  payTo: string;
  /** Hard cap on seconds billed in a single tick (guards against clock jumps / long sleeps). */
  maxTickSeconds: number;
  /** Network id recorded on the impact snapshot ("mock", "casper-test", "base-sepolia", …). */
  network?: string;
}

/** A computed-but-not-yet-settled charge for one tick. */
export interface TickQuote {
  session: Session;
  stream: StreamSpec;
  at: number;
  elapsedMs: number;
  seconds: number;
  /** Smallest-units owed for this tick, as a decimal string. */
  amount: string;
}

/** The outcome of paying a tick — synthetic in MOCK mode, a real transfer when live. */
export interface SettlementResult {
  txHash: string;
  explorerUrl: string;
  network: string;
  /** Set by BatchSettlementProvider — ticks sharing a batchId share one deferred on-chain transfer. */
  batchId?: string;
}

export class StreamingMeter {
  constructor(
    private readonly store: MeterStore,
    private readonly cfg: MeterConfig,
  ) {}

  openSession(streamId: string, agent: string, opts: { policy?: string; objective?: string } = {}): Session {
    const stream = this.requireStream(streamId);
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      streamId: stream.id,
      agent,
      status: "active",
      startedAt: now,
      settledMs: 0,
      totalPaid: "0",
      ticks: 0,
      lastSettledAt: now,
      policy: opts.policy,
      objective: opts.objective,
    };
    this.store.putSession(session);
    return session;
  }

  /** Compute what the next tick owes, without mutating anything. Throws if the session can't tick. */
  quoteTick(sessionId: string): TickQuote {
    const session = this.store.getSession(sessionId);
    if (!session) throw new MeterError(404, "unknown session");
    if (session.status !== "active") throw new MeterError(409, `session is ${session.status}`);

    const stream = this.requireStream(session.streamId);
    const at = Date.now();
    const elapsedMs = Math.min(at - session.lastSettledAt, this.cfg.maxTickSeconds * 1000);
    const amount = (BigInt(stream.ratePerSecond) * BigInt(elapsedMs)) / 1000n;
    return { session, stream, at, elapsedMs, seconds: elapsedMs / 1000, amount: amount.toString() };
  }

  /** Record a paid tick: append the settlement event and advance the session up to quote.at. */
  commitTick(quote: TickQuote, result: SettlementResult): { session: Session; event: SettlementEvent } {
    const session = this.store.getSession(quote.session.id);
    if (!session) throw new MeterError(404, "unknown session");

    const event: SettlementEvent = {
      id: randomUUID(),
      sessionId: session.id,
      streamId: session.streamId,
      agent: session.agent,
      payTo: quote.stream.payTo ?? this.cfg.payTo,
      provider: quote.stream.provider,
      amount: quote.amount,
      asset: quote.stream.asset,
      seconds: quote.seconds,
      network: result.network,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      settledAt: quote.at,
      batchId: result.batchId,
    };
    this.store.addEvent(event);

    session.lastSettledAt = quote.at;
    session.settledMs += quote.elapsedMs;
    session.ticks += 1;
    session.totalPaid = (BigInt(session.totalPaid) + BigInt(quote.amount)).toString();
    this.store.putSession(session);

    return { session, event };
  }

  streamOf(sessionId: string | undefined): StreamSpec | undefined {
    if (!sessionId) return undefined;
    const session = this.store.getSession(sessionId);
    return session ? this.store.streams.get(session.streamId) : undefined;
  }

  halt(sessionId: string, reason: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    session.status = "halted";
    session.haltedReason = reason;
    this.store.putSession(session);
  }

  closeSession(sessionId: string, reason?: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new MeterError(404, "unknown session");
    if (session.status === "active") {
      session.status = "closed";
      if (reason) session.closedReason = reason;
      session.closedAt = Date.now();
      this.store.putSession(session);
    }
    return session;
  }

  /** Build the public proof snapshot from settled events + sessions. Never over-claims. */
  impact(recentLimit = 20): ImpactSnapshot {
    const events = this.store.listEvents();
    const sessions = this.store.listSessions();
    const agents = new Set(events.map((e) => e.agent));
    const providers = new Set(events.map((e) => e.payTo));
    const totalPaid = events.reduce((sum, e) => sum + BigInt(e.amount), 0n);
    const secondsStreamed = events.reduce((sum, e) => sum + e.seconds, 0);
    const decisions: AgentDecision[] = sessions
      .filter((s) => s.status === "closed" && s.closedReason)
      .map((s) => ({
        agent: s.agent,
        streamId: s.streamId,
        objective: s.objective,
        closedReason: s.closedReason as string,
        ticks: s.ticks,
        totalPaid: s.totalPaid,
        at: s.closedAt ?? s.startedAt,
      }));

    return {
      network: this.cfg.network ?? "mock",
      mock: (this.cfg.network ?? "mock") === "mock",
      totals: {
        settlements: events.length,
        totalPaid: totalPaid.toString(),
        asset: events[0]?.asset ?? "",
        activeSessions: sessions.filter((s) => s.status === "active").length,
        uniqueAgents: agents.size,
        uniqueProviders: providers.size,
        secondsStreamed,
      },
      recent: events.slice(-recentLimit).reverse(),
      decisions: decisions.slice(-recentLimit).reverse(),
    };
  }

  private requireStream(streamId: string): StreamSpec {
    const stream = this.store.streams.get(streamId);
    if (!stream) throw new MeterError(404, `unknown stream: ${streamId}`);
    return stream;
  }
}

export class MeterError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
