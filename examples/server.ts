/**
 * Minimal meter402 server (MOCK mode — no chain, no creds). Run it:
 *
 *   npm run example:server
 *
 * Then drive a stream from another terminal:
 *
 *   # open a session
 *   curl -s -X POST localhost:4021/meter/sessions \
 *     -H 'content-type: application/json' \
 *     -d '{"streamId":"btc-feed","agent":"agent-1","objective":"track BTC until I have an entry"}'
 *
 *   # pay a tick (repeat every second to keep the gate open); paste the session id from above
 *   curl -s -X POST localhost:4021/meter/sessions/<SESSION_ID>/tick
 *
 *   # see the proof feed
 *   curl -s localhost:4021/meter/impact
 */

import express from "express";
import { MemoryStore, MockSettlementProvider, StreamingMeter } from "../src/index.js";
import { createMeterRouter } from "../src/express.js";

const store = new MemoryStore([
  {
    id: "btc-feed",
    title: "BTC price feed",
    description: "1s-resolution BTC/USD, streamed pay-as-you-go.",
    ratePerSecond: "1000", // 0.001 USDC/sec at 6 decimals
    asset: "USDC",
    provider: "Lumen Markets",
    payTo: "0xProviderTreasury",
  },
]);

const meter = new StreamingMeter(store, { payTo: "0xProviderTreasury", maxTickSeconds: 10, network: "mock" });
const provider = new MockSettlementProvider();

const app = express();
app.use(
  "/meter",
  createMeterRouter({
    store,
    meter,
    provider,
    // deliver the "next chunk" only because the tick was paid:
    deliver: () => ({ price: 64000 + Math.round(Math.random() * 500), at: Date.now() }),
  }),
);

const port = Number(process.env.PORT ?? 4021);
app.listen(port, () => console.log(`meter402 example on http://localhost:${port}/meter (MOCK mode)`));
