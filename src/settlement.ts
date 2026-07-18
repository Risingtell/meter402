/**
 * Settlement abstraction. The streaming meter is decoupled from *how* a tick is paid.
 *
 *  - MOCK mode: MockSettlementProvider simulates a settlement so the whole streaming UX + /impact
 *    proof feed are buildable offline with no creds.
 *  - LIVE mode: back this interface with an x402 facilitator (e.g. @x402/express settling a real
 *    CEP-18 / EIP-3009 `transfer_with_authorization`), returning the real on-chain tx hash.
 *
 * Because the meter only sees `settle(quote) -> SettlementResult`, the same core runs on any chain.
 */

import { randomBytes } from "node:crypto";
import type { SettlementResult, TickQuote } from "./meter.js";

export interface SettlementProvider {
  readonly network: string;
  readonly mock: boolean;
  /** Settle one quoted tick. Must throw if the tick was not paid. */
  settle(quote: TickQuote): Promise<SettlementResult>;
}

/** Simulates settlement with a synthetic 64-hex tx hash. No chain, no creds. */
export class MockSettlementProvider implements SettlementProvider {
  readonly network = "mock";
  readonly mock = true;

  constructor(private readonly latencyMs = 40) {}

  async settle(_quote: TickQuote): Promise<SettlementResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    return { txHash: randomBytes(32).toString("hex"), explorerUrl: "", network: this.network };
  }
}
