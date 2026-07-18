/**
 * MCP server — expose streaming settlement as tools any AI agent can call. This is what lets an
 * autonomous agent open a metered stream, decide tick-by-tick whether the next chunk is worth
 * paying for, and close its own gate — with every tick a real settlement.
 *
 *   const server = createMeterMcpServer({ store, meter, provider });
 *   await server.connect(new StdioServerTransport());
 *
 * Tools: list_streams · open_session · tick · close_session · impact
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StreamingMeter } from "./meter.js";
import type { SettlementProvider } from "./settlement.js";
import type { MemoryStore } from "./store.js";

export interface MeterMcpOptions {
  store: MemoryStore;
  meter: StreamingMeter;
  provider: SettlementProvider;
  name?: string;
  version?: string;
}

const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function createMeterMcpServer(opts: MeterMcpOptions): McpServer {
  const { store, meter, provider } = opts;
  const server = new McpServer({ name: opts.name ?? "meter402", version: opts.version ?? "0.1.0" });

  server.tool("list_streams", "List the metered resources available to stream.", {}, async () =>
    asText([...store.streams.values()]),
  );

  server.tool(
    "open_session",
    "Open a metered streaming session against a resource. Returns the session id used to tick.",
    {
      streamId: z.string().describe("id of the stream to consume"),
      agent: z.string().describe("the agent's address / identifier"),
      policy: z.string().optional().describe("the agent's spending policy for this session"),
      objective: z.string().optional().describe("what the agent is trying to achieve"),
    },
    async ({ streamId, agent, policy, objective }) =>
      asText(meter.openSession(streamId, agent, { policy, objective })),
  );

  server.tool(
    "tick",
    "Pay for the next tick of a session (settles the time held since the last tick) and receive the next chunk. Skipping this call shuts the gate.",
    { sessionId: z.string().describe("id from open_session") },
    async ({ sessionId }) => {
      const quote = meter.quoteTick(sessionId);
      const result = await provider.settle(quote);
      const { session, event } = meter.commitTick(quote, result);
      return asText({ session, settlement: event });
    },
  );

  server.tool(
    "close_session",
    "Close the gate on a session and record why (objective met, not worth it, budget reached).",
    { sessionId: z.string(), reason: z.string().optional() },
    async ({ sessionId, reason }) => asText(meter.closeSession(sessionId, reason)),
  );

  server.tool(
    "impact",
    "Get the public proof snapshot: totals, recent settlements, and autonomous gate-closure decisions.",
    {},
    async () => asText(meter.impact()),
  );

  return server;
}
