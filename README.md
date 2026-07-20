# meter402

**Per-second metered & streaming settlement for [x402](https://x402.org).**

x402 is a per-*request* payment standard: one call, one payment. But agents increasingly consume
things *continuously* — a price feed, a GPU, an inference stream, a live dataset. Billing that as
one-shot 402 calls is clumsy and over/under-charges.

meter402 adds the missing primitive: **pay-as-you-consume streaming settlement.** An agent opens a
session, then pays one tick per interval for exactly the wall-clock time it held the stream. Pay the
tick → get the next chunk. Stop paying → the gate shuts. Every tick is one real settlement, and a
built-in verifier can **re-derive every total straight from the chain** — so nobody has to trust the
server's numbers.

```
open session ──▶ quote tick ──▶ settle (x402) ──▶ commit + deliver next chunk
                     ▲                                        │
                     └──────────  agent decides to keep paying ┘   (stop = gate shuts)
```

- **Framework-free core**, with a one-line **Express** adapter and an **MCP server** so any AI agent
  can stream and self-govern its spend.
- **Chain-agnostic.** The meter never assumes a chain; settlement + verification are pluggable. The
  same core has run on Casper and can back any EIP-3009 / x402 facilitator (Base, Arc, …).
- **Proof-first.** A public `/impact` snapshot never over-claims, and the on-chain verifier is the
  source of truth.

## Install

```bash
npm install meter402
# express is an optional peer dep, only needed for the Express adapter:
npm install express
```

## Quickstart — Express

```ts
import express from "express";
import { MemoryStore, MockSettlementProvider, StreamingMeter } from "meter402";
import { createMeterRouter } from "meter402/express";

const store = new MemoryStore([
  { id: "btc-feed", title: "BTC feed", ratePerSecond: "1000", asset: "USDC", payTo: "0xTreasury" },
]);
const meter = new StreamingMeter(store, { payTo: "0xTreasury", maxTickSeconds: 10, network: "mock" });

const app = express();
app.use("/meter", createMeterRouter({ store, meter, provider: new MockSettlementProvider() }));
app.listen(4021);
```

Runnable version: [`examples/server.ts`](./examples/server.ts) (`npm run example:server`).

## Quickstart — MCP (agent-native)

Expose streaming settlement as tools an autonomous agent can call — `open_session`, `tick`,
`close_session`, `impact`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryStore, MockSettlementProvider, StreamingMeter } from "meter402";
import { createMeterMcpServer } from "meter402/mcp";

const store = new MemoryStore([/* streams */]);
const meter = new StreamingMeter(store, { payTo: "0xTreasury", maxTickSeconds: 10 });
const server = createMeterMcpServer({ store, meter, provider: new MockSettlementProvider() });
await server.connect(new StdioServerTransport());
```

The agent decides, tick by tick, whether the next chunk is worth paying for — and records *why* it
closed the gate. That autonomous "not worth it → stop" decision is the interesting part.

## Going live

Swap `MockSettlementProvider` for a real x402 facilitator that settles an EIP-3009 /
`transfer_with_authorization` transfer and returns the on-chain tx hash. The meter is unchanged —
`quoteTick()` feeds the x402 dynamic price *before* settlement; `commitTick()` records it *after*,
from the facilitator's after-settle hook, with the real hash.

## Proof, not trust

`meter.impact()` publishes totals that are always `≤` what actually settled on-chain. The included
**EVM verifier** reads the settlement token's `Transfer` ledger directly over JSON-RPC, counts only
real settlements (agent → provider transfers, excluding mint + agent-funding), re-derives the totals,
and fails loudly if the feed ever claims more than the chain shows:

```ts
import { createEvmVerifier, verifyAgainst } from "meter402/verify";

const verifier = createEvmVerifier({
  network: "base-sepolia",
  rpcUrl: "https://sepolia.base.org",
  token: "0xUSDC",
  agents: ["0xAgent1", "0xAgent2"],   // the session payers
  fromBlock: 12_345_678,               // token deployment block
});

const report = await verifyAgainst(verifier, await fetchImpact());
if (!report.verified) throw new Error("feed over-claims");
```

Or run it as a CI gate: `RPC_URL=… TOKEN=… AGENTS=0xa1,0xa2 PROOF=./impact.json npm run verify:evm`
(exits non-zero if the feed over-claims). The RPC transport is injectable (`rpc`), so the same
adapter works with any provider — and the aggregation logic is unit-testable without a live chain.
A Casper reference verifier lives in the [`sluice`](https://github.com/Risingtell/sluice) project
this core was extracted from.

**Verified against live chains, not just fixtures:**

- **OKX X Layer mainnet** (`eip155:196`) — [`examples/verify-xlayer.ts`](./examples/verify-xlayer.ts)
  re-derives the real USD₮0 settlement history of a live [OKX.AI](https://www.okx.ai) buyer agent:
  34 settlements / $1.082 across two live services ([Argus](https://github.com/Risingtell/argus)
  ASP #5246 and [VigilOK](https://github.com/Risingtell/vigilok) ASP #6032). Run it yourself and
  check any row on [OKLink](https://www.oklink.com/x-layer).
- **Arc testnet** (`eip155:5042002`) — reconstructed a known x402 settlement from the token's
  Transfer ledger; that live run also caught (and fixed, in v0.1.1) the busy-chain
  max-results pitfall the `chunkSize` + agent-topic filtering now handle.

## Roadmap

- [x] Generic EVM verifier adapter (read ERC-20 transfers → re-derive totals)
- [ ] `bin/meter402-mcp` stdio entrypoint for drop-in agent configs
- [ ] Persistent store adapter (Postgres) alongside `MemoryStore`
- [ ] Budget/policy guardrails on the session (hard cap + rate ceiling)

## License

MIT © Oluwasogo "Israel" Ajala (Rising Technology)
