/** meter402 — per-second metered & streaming settlement for x402. */

export { StreamingMeter, MeterError } from "./meter.js";
export type { MeterConfig, TickQuote, SettlementResult } from "./meter.js";
export { MemoryStore } from "./store.js";
export { MockSettlementProvider } from "./settlement.js";
export type { SettlementProvider } from "./settlement.js";
export { BatchSettlementProvider } from "./batch.js";
export type { BatchThreshold } from "./batch.js";
export { verifyAgainst, createEvmVerifier } from "./verify.js";
export type { VerifierAdapter, OnChainTotals, VerifyReport, EvmRpc, EvmVerifierOptions } from "./verify.js";
export type {
  StreamSpec,
  Session,
  SessionStatus,
  SettlementEvent,
  AgentDecision,
  ImpactSnapshot,
  MeterStore,
} from "./types.js";
