import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { StreamingMeter } from "../src/meter.js";
import { BatchSettlementProvider } from "../src/batch.js";
import type { SettlementProvider } from "../src/settlement.js";
import type { SettlementResult, TickQuote } from "../src/meter.js";

/** Records every real settlement it's asked to make, so tests can assert on chain-call count. */
class RecordingProvider implements SettlementProvider {
  readonly network = "test-chain";
  readonly mock = false;
  calls: TickQuote[] = [];
  fail = false;

  async settle(quote: TickQuote): Promise<SettlementResult> {
    if (this.fail) throw new Error("chain call failed");
    this.calls.push(quote);
    return { txHash: `real-${this.calls.length}`, explorerUrl: `https://explorer/${this.calls.length}`, network: this.network };
  }
}

function setup() {
  const store = new MemoryStore([
    { id: "s1", title: "Stream", ratePerSecond: "1000", asset: "USDC", payTo: "0xProvider" },
  ]);
  const meter = new StreamingMeter(store, { payTo: "0xProvider", maxTickSeconds: 60 });
  return { store, meter };
}

/** Ticks with a caller-chosen amount/elapsed time instead of relying on real wall-clock gaps
 *  between calls, which makes the batching threshold tests deterministic and fast. */
async function tick(
  meter: StreamingMeter,
  provider: SettlementProvider,
  sessionId: string,
  amount = "1000",
  elapsedMs = 1000,
) {
  const quote = { ...meter.quoteTick(sessionId), amount, elapsedMs, seconds: elapsedMs / 1000 };
  const result = await provider.settle(quote);
  return meter.commitTick(quote, result);
}

test("batches ticks and settles once maxTicks is hit", async () => {
  const { store, meter } = setup();
  const chain = new RecordingProvider();
  const batched = new BatchSettlementProvider(chain, store, { maxTicks: 3 });
  const session = meter.openSession("s1", "agent-1");

  await tick(meter, batched, session.id);
  await tick(meter, batched, session.id);
  assert.equal(chain.calls.length, 0, "no on-chain settlement before threshold");

  await tick(meter, batched, session.id);
  assert.equal(chain.calls.length, 1, "exactly one on-chain settlement once threshold crosses");

  const events = store.listEvents();
  assert.equal(events.length, 3);
  const batchId = events[0].batchId;
  assert.ok(batchId, "earlier ticks are tagged with the batchId");
  for (const e of events) {
    assert.equal(e.txHash, "real-1", "every tick in the batch reconciles onto the one real tx");
    assert.equal(e.explorerUrl, "https://explorer/1");
  }
});

test("pending ticks get a placeholder txHash before the batch flushes", async () => {
  const { store, meter } = setup();
  const chain = new RecordingProvider();
  const batched = new BatchSettlementProvider(chain, store, { maxTicks: 5 });
  const session = meter.openSession("s1", "agent-1");

  await tick(meter, batched, session.id);
  const [event] = store.listEvents();
  assert.match(event.txHash, /^pending:/);
  assert.equal(event.explorerUrl, "");
});

test("flushAll settles a partial batch that never hit its threshold", async () => {
  const { store, meter } = setup();
  const chain = new RecordingProvider();
  const batched = new BatchSettlementProvider(chain, store, { maxTicks: 100 });
  const session = meter.openSession("s1", "agent-1");

  await tick(meter, batched, session.id);
  await tick(meter, batched, session.id);
  assert.equal(chain.calls.length, 0);

  await batched.flushAll();
  assert.equal(chain.calls.length, 1, "flushAll makes exactly one settlement for the whole partial batch");
  for (const e of store.listEvents()) assert.equal(e.txHash, "real-1");
});

test("different agents and payees never share a batch", async () => {
  const store = new MemoryStore([
    { id: "s1", title: "Stream", ratePerSecond: "1000", asset: "USDC", payTo: "0xProviderA" },
    { id: "s2", title: "Stream2", ratePerSecond: "1000", asset: "USDC", payTo: "0xProviderB" },
  ]);
  const meter = new StreamingMeter(store, { payTo: "0xDefault", maxTickSeconds: 60 });
  const chain = new RecordingProvider();
  const batched = new BatchSettlementProvider(chain, store, { maxTicks: 2 });

  const sessionA = meter.openSession("s1", "agent-1");
  const sessionB = meter.openSession("s2", "agent-2");

  await tick(meter, batched, sessionA.id);
  await tick(meter, batched, sessionB.id);
  assert.equal(chain.calls.length, 0, "one tick each, neither group has hit maxTicks=2 yet");

  await tick(meter, batched, sessionA.id);
  assert.equal(chain.calls.length, 1, "only agent-1's group flushed");

  await tick(meter, batched, sessionB.id);
  assert.equal(chain.calls.length, 2, "agent-2's group flushes independently");
});

test("a failed on-chain settlement keeps the batch intact for retry, nothing accrued is lost", async () => {
  const { store, meter } = setup();
  const chain = new RecordingProvider();
  const batched = new BatchSettlementProvider(chain, store, { maxTicks: 2 });
  const session = meter.openSession("s1", "agent-1");

  await tick(meter, batched, session.id);

  chain.fail = true;
  const quote = { ...meter.quoteTick(session.id), amount: "1000", elapsedMs: 1000, seconds: 1 };
  await assert.rejects(() => batched.settle(quote), /chain call failed/);
  // the failed tick was never committed (settle threw), so the store only has the first tick
  assert.equal(store.listEvents().length, 1);

  chain.fail = false;
  await batched.flushAll();
  assert.equal(chain.calls.length, 1, "retry succeeds and settles the full accrued amount in one call");
  // both the first committed tick (1000) and the retried one queued during the failure (1000)
  // must still be in the flushed total — nothing accrued was dropped by the failed attempt.
  assert.equal(chain.calls[0].amount, "2000");
});

test("maxAmount threshold flushes based on accrued value, not tick count", async () => {
  const { store, meter } = setup();
  const chain = new RecordingProvider();
  const batched = new BatchSettlementProvider(chain, store, { maxAmount: "1500" });
  const session = meter.openSession("s1", "agent-1");

  await tick(meter, batched, session.id, "1000");
  assert.equal(chain.calls.length, 0, "1000 < 1500, still pending");
  await tick(meter, batched, session.id, "600");
  assert.equal(chain.calls.length, 1, "1000 + 600 = 1600 crosses the 1500 threshold");
  assert.equal(chain.calls[0].amount, "1600");
});
