/**
 * BatchSettlementProvider — defers on-chain settlement while still confirming every tick
 * instantly, the pattern Circle Nanopayments proved out for USDC/Gateway. It wraps any
 * SettlementProvider (mock or a real chain adapter) so ticks that belong together settle in
 * one transfer, amortizing gas across many ticks instead of paying it per tick.
 *
 * Grouping is per (agent, payTo, asset) by default — those are the ticks that can legally
 * collapse into one transfer (same sender, same recipient, same token). A batch flushes once
 * any configured threshold is crossed, either by the next incoming tick or by an explicit
 * flushAll() call (e.g. on session close or process shutdown, so a provider is never left
 * holding delivered time that never got paid).
 *
 * Every tick still gets its own SettlementEvent, so the /impact feed and secondsStreamed totals
 * are unaffected. Only txHash/explorerUrl differ before vs after a flush: pre-flush ticks get a
 * `pending:<batchId>` placeholder and empty explorerUrl; once the batch settles, every tick that
 * shared the batchId is patched onto the one real tx (requires MeterStore.updateEventsByBatchId —
 * MemoryStore ships this; a custom store without it just keeps the placeholder, the sum-of-amounts
 * proof still holds).
 */

import { randomUUID } from "node:crypto";
import type { MeterStore } from "./types.js";
import type { SettlementResult, TickQuote } from "./meter.js";
import type { SettlementProvider } from "./settlement.js";

export interface BatchThreshold {
  /** Flush once this many ticks have accumulated in the group. */
  maxTicks?: number;
  /** Flush once the group's accumulated amount reaches this many smallest-units. */
  maxAmount?: string;
  /** Flush once the group's oldest unsettled tick is at least this old. Checked on every
   *  incoming tick and by flushAll() — there is no background timer. */
  maxWaitMs?: number;
}

interface BatchGroup {
  batchId: string;
  quotes: TickQuote[];
  total: bigint;
  openedAt: number;
}

function defaultGroupKey(quote: TickQuote): string {
  const payTo = quote.stream.payTo ?? "";
  return `${quote.session.agent}|${payTo}|${quote.stream.asset}`;
}

export class BatchSettlementProvider implements SettlementProvider {
  readonly network: string;
  readonly mock: boolean;
  private readonly groups = new Map<string, BatchGroup>();

  constructor(
    private readonly underlying: SettlementProvider,
    private readonly store: MeterStore,
    private readonly threshold: BatchThreshold,
    private readonly groupKey: (quote: TickQuote) => string = defaultGroupKey,
  ) {
    this.network = underlying.network;
    this.mock = underlying.mock;
  }

  async settle(quote: TickQuote): Promise<SettlementResult> {
    const key = this.groupKey(quote);
    let group = this.groups.get(key);
    if (!group) {
      group = { batchId: randomUUID(), quotes: [], total: 0n, openedAt: Date.now() };
      this.groups.set(key, group);
    }
    group.quotes.push(quote);
    group.total += BigInt(quote.amount);

    if (this.shouldFlush(group)) {
      return this.flushGroup(key, group);
    }
    return {
      txHash: `pending:${group.batchId}`,
      explorerUrl: "",
      network: this.network,
      batchId: group.batchId,
    };
  }

  /** Force-settle every open group now, regardless of threshold. Call this on session close or
   *  process shutdown so no accrued tick is ever left permanently pending. */
  async flushAll(): Promise<void> {
    for (const key of [...this.groups.keys()]) {
      const group = this.groups.get(key);
      if (group && group.quotes.length > 0) await this.flushGroup(key, group);
    }
  }

  /** True if the given group (identified by its groupKey) currently has ticks waiting to settle. */
  hasPending(key: string): boolean {
    return (this.groups.get(key)?.quotes.length ?? 0) > 0;
  }

  private shouldFlush(g: BatchGroup): boolean {
    const { maxTicks, maxAmount, maxWaitMs } = this.threshold;
    if (maxTicks !== undefined && g.quotes.length >= maxTicks) return true;
    if (maxAmount !== undefined && g.total >= BigInt(maxAmount)) return true;
    if (maxWaitMs !== undefined && Date.now() - g.openedAt >= maxWaitMs) return true;
    return false;
  }

  private async flushGroup(key: string, group: BatchGroup): Promise<SettlementResult> {
    const last = group.quotes[group.quotes.length - 1];
    const totalElapsedMs = group.quotes.reduce((sum, q) => sum + q.elapsedMs, 0);
    const merged: TickQuote = {
      ...last,
      amount: group.total.toString(),
      elapsedMs: totalElapsedMs,
      seconds: totalElapsedMs / 1000,
    };

    // Settle first, drop the group only after it succeeds — if the underlying provider throws
    // (a real chain call can fail), the group and everything accrued in it survives for the next
    // tick (or the next flushAll()) to retry. Nothing accrued is ever silently lost on failure.
    const result = await this.underlying.settle(merged);
    this.groups.delete(key);

    if (group.quotes.length > 1) {
      this.store.updateEventsByBatchId?.(group.batchId, {
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
      });
    }
    return { ...result, batchId: group.batchId };
  }
}
