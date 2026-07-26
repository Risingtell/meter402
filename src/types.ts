/**
 * Wire types for meter402. Chain-agnostic by design: amounts are integer strings in the
 * asset's smallest unit (e.g. "1000000" = 1 USDC at 6 decimals, or motes for CSPR). The meter
 * never assumes a chain — settlement and verification are pluggable.
 */

export type SessionStatus = "active" | "halted" | "closed";

/** A continuously-metered resource an agent can stream and pay for by the second. */
export interface StreamSpec {
  id: string;
  title: string;
  description?: string;
  /** Price per second of consumption, in the asset's smallest unit. */
  ratePerSecond: string;
  /** Token symbol settlements are denominated in (e.g. "USDC"). */
  asset: string;
  /** Display name of the provider that supplies this stream. */
  provider?: string;
  /** Address the provider receives payment at. */
  payTo?: string;
}

/** A live consumption session: one agent streaming one resource. */
export interface Session {
  id: string;
  streamId: string;
  /** Agent's address / public key (or a mock id in MOCK mode). */
  agent: string;
  status: SessionStatus;
  startedAt: number;
  /** Wall-clock ms of metered consumption that has been settled. */
  settledMs: number;
  /** Cumulative smallest-units settled across all ticks of this session. */
  totalPaid: string;
  /** Number of settlements (ticks) so far. */
  ticks: number;
  lastSettledAt: number;
  haltedReason?: string;
  /** The agent's policy + goal for this session (its autonomy). */
  policy?: string;
  objective?: string;
  /** Why the agent closed the gate (objective met / not worth it / budget / cap). */
  closedReason?: string;
  closedAt?: number;
}

/** One settlement event — the unit of the /impact proof feed. Real on-chain tx when live. */
export interface SettlementEvent {
  id: string;
  sessionId: string;
  streamId: string;
  agent: string;
  payTo: string;
  provider?: string;
  /** Smallest-units moved in this single tick. */
  amount: string;
  asset: string;
  /** Seconds of consumption this tick covers. */
  seconds: number;
  /** "mock" or a live network id (e.g. "casper-test", "base-sepolia"). */
  network: string;
  /** Settlement / tx hash. Synthetic in MOCK mode, a real transfer hash when live. */
  txHash: string;
  /** Deep link to a block explorer when live; empty in MOCK mode. */
  explorerUrl: string;
  settledAt: number;
  /** Set when this tick was settled via BatchSettlementProvider — ticks sharing a batchId
   *  share one real on-chain transfer, reconciled onto every tick's event once the batch flushes. */
  batchId?: string;
}

/** A recorded autonomous decision: an agent that closed its own stream, and why. */
export interface AgentDecision {
  agent: string;
  streamId: string;
  provider?: string;
  objective?: string;
  closedReason: string;
  ticks: number;
  totalPaid: string;
  at: number;
}

export interface ImpactSnapshot {
  network: string;
  mock: boolean;
  totals: {
    settlements: number;
    totalPaid: string;
    asset: string;
    activeSessions: number;
    uniqueAgents: number;
    uniqueProviders: number;
    secondsStreamed: number;
  };
  recent: SettlementEvent[];
  decisions: AgentDecision[];
}

/**
 * Pluggable persistence. Ship the in-memory store for demos; back it with a DB in production.
 * The meter only touches this interface — it never assumes where state lives.
 */
export interface MeterStore {
  readonly streams: Map<string, StreamSpec>;
  getSession(id: string): Session | undefined;
  putSession(s: Session): void;
  addEvent(e: SettlementEvent): void;
  listEvents(): SettlementEvent[];
  listSessions(): Session[];
  /** Optional: patch every event sharing a batchId once BatchSettlementProvider flushes it onto
   *  a real on-chain transfer. Stores that don't implement this just keep each tick's pending
   *  placeholder txHash — the sum-of-amounts proof still holds, only the per-tick hash link doesn't. */
  updateEventsByBatchId?(batchId: string, patch: { txHash: string; explorerUrl: string }): void;
}
