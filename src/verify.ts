/**
 * Trustless verification — don't trust the server's /impact numbers; re-derive them straight from
 * the chain's token-transfer ledger.
 *
 * A "settlement" is a transfer of the settlement token FROM an agent (a session payer) TO a
 * non-agent (a provider treasury). That definition cleanly excludes the initial mint and any
 * agent-funding transfers, no matter which provider address a stream used. The verifier sums those
 * settlements and proves the public feed never claims more than the chain actually shows.
 *
 * `createEvmVerifier` reads ERC-20 `Transfer` logs over JSON-RPC (no extra deps — uses global
 * fetch). The RPC transport is injectable so the aggregation logic is testable without a live chain.
 */

import type { ImpactSnapshot } from "./types.js";

/** Totals re-derived from the on-chain ledger, independent of any server. */
export interface OnChainTotals {
  network: string;
  settlements: number;
  /** Smallest-units, as a decimal string. */
  totalPaid: string;
  perProvider: Record<string, { count: number; total: string }>;
}

export interface VerifierAdapter {
  readonly network: string;
  reDeriveTotals(): Promise<OnChainTotals>;
}

/** The outcome of checking a public feed against the chain. */
export interface VerifyReport {
  verified: boolean;
  network: string;
  chain: { settlements: number; totalPaid: string };
  claimed: { settlements: number; totalPaid: string };
  perProvider: Record<string, { count: number; total: string }>;
  note: string;
}

/**
 * Compare a public ImpactSnapshot against the chain. Passes iff the chain shows *at least* what the
 * feed claims — meter402's invariant is "never over-claim", so chain ≥ feed is success.
 */
export async function verifyAgainst(adapter: VerifierAdapter, impact: ImpactSnapshot): Promise<VerifyReport> {
  const chain = await adapter.reDeriveTotals();
  const claimedSettlements = impact.totals.settlements;
  const claimedPaid = BigInt(impact.totals.totalPaid || "0");
  const chainPaid = BigInt(chain.totalPaid);
  const verified = chain.settlements >= claimedSettlements && chainPaid >= claimedPaid;
  return {
    verified,
    network: chain.network,
    chain: { settlements: chain.settlements, totalPaid: chain.totalPaid },
    claimed: { settlements: claimedSettlements, totalPaid: claimedPaid.toString() },
    perProvider: chain.perProvider,
    note: verified
      ? "Every settlement the feed claims is backed by a real on-chain transfer."
      : "Chain total is below the feed's claim — the feed over-claims. Investigate.",
  };
}

// ---------------------------------------------------------------------------------------------
// EVM adapter
// ---------------------------------------------------------------------------------------------

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Minimal JSON-RPC transport: (method, params) -> result. Injectable for tests/custom providers. */
export type EvmRpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface EvmVerifierOptions {
  network: string;
  /** ERC-20 settlement token address. */
  token: string;
  /** Agent addresses that send settlements. */
  agents: string[];
  /** Optional friendly names for provider treasuries, keyed by lowercase address. */
  providerNames?: Record<string, string>;
  fromBlock?: number;
  toBlock?: number | "latest";
  /** Provide one of rpcUrl or rpc. */
  rpcUrl?: string;
  rpc?: EvmRpc;
  /** eth_getLogs block window (some RPCs cap this). Default 5000. */
  chunkSize?: number;
}

interface RawLog {
  topics: string[];
  data: string;
}

const toHexBlock = (n: number) => "0x" + n.toString(16);
/** Last 20 bytes of a 32-byte topic word → lowercase 0x address. */
const topicToAddress = (topic: string) => ("0x" + topic.slice(-40)).toLowerCase();
/** Left-pad a 20-byte address into a 32-byte indexed-topic word. */
const addressToTopic = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function defaultRpc(url: string): EvmRpc {
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return json.result;
  };
}

export function createEvmVerifier(opts: EvmVerifierOptions): VerifierAdapter {
  const rpc = opts.rpc ?? (opts.rpcUrl ? defaultRpc(opts.rpcUrl) : null);
  if (!rpc) throw new Error("createEvmVerifier: provide either rpc or rpcUrl");

  const token = opts.token.toLowerCase();
  const agents = new Set(opts.agents.map((a) => a.toLowerCase()));
  const names = opts.providerNames ?? {};
  const chunk = opts.chunkSize ?? 5000;

  return {
    network: opts.network,
    async reDeriveTotals(): Promise<OnChainTotals> {
      const from = opts.fromBlock ?? 0;
      const to =
        opts.toBlock === undefined || opts.toBlock === "latest"
          ? Number(BigInt((await rpc("eth_blockNumber", [])) as string))
          : opts.toBlock;

      // Filter server-side on the indexed `from` topic (any of our agents) — on a busy chain,
      // scanning every Transfer on the token can exceed the RPC's max-results cap; this keeps
      // the query scoped to only the transfers that could possibly be one of our settlements.
      const agentTopics = [...agents].map(addressToTopic);

      const logs: RawLog[] = [];
      for (let start = from; start <= to; start += chunk) {
        const end = Math.min(start + chunk - 1, to);
        const page = (await rpc("eth_getLogs", [
          {
            address: token,
            topics: [TRANSFER_TOPIC, agentTopics],
            fromBlock: toHexBlock(start),
            toBlock: toHexBlock(end),
          },
        ])) as RawLog[];
        logs.push(...page);
      }

      const perProvider: Record<string, { count: number; total: bigint }> = {};
      let settlements = 0;
      let totalPaid = 0n;
      for (const log of logs) {
        if (!log.topics || log.topics.length < 3) continue; // not an indexed ERC-20 Transfer
        const fromAddr = topicToAddress(log.topics[1]);
        const toAddr = topicToAddress(log.topics[2]);
        if (!agents.has(fromAddr) || agents.has(toAddr)) continue; // skip mint + agent-funding
        const amount = BigInt(log.data === "0x" ? "0x0" : log.data);
        const label = names[toAddr] ?? `provider ${toAddr.slice(0, 10)}…`;
        (perProvider[label] ??= { count: 0, total: 0n }).count++;
        perProvider[label].total += amount;
        settlements++;
        totalPaid += amount;
      }

      return {
        network: opts.network,
        settlements,
        totalPaid: totalPaid.toString(),
        perProvider: Object.fromEntries(
          Object.entries(perProvider).map(([k, v]) => [k, { count: v.count, total: v.total.toString() }]),
        ),
      };
    },
  };
}
