/**
 * Live verification example — OKX X Layer mainnet (eip155:196).
 *
 * Re-derives, from chain data alone, every USD₮0 settlement paid by an agent wallet to the
 * services it consumed. The defaults below are REAL and independently checkable by anyone:
 * the buyer agent of Argus (OKX.AI ASP #5246, github.com/Risingtell/argus) and the treasuries
 * of the two live services it actually paid — run it as-is and compare against any explorer
 * (https://www.oklink.com/x-layer).
 *
 *   npx tsx examples/verify-xlayer.ts
 *
 * Note the RPC quirks this handles via `chunkSize`: rpc.xlayer.tech caps eth_getLogs at 100
 * blocks; xlayer.drpc.org's free tier allows 10k per query (and silently returns empty for
 * oversized ranges — always chunk).
 */
import { createEvmVerifier } from "../src/verify.js";

const verifier = createEvmVerifier({
  network: "xlayer-mainnet",
  rpcUrl: process.env.RPC_URL ?? "https://xlayer.drpc.org",
  token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", // USD₮0, 6 decimals
  agents: [process.env.AGENT ?? "0x9f67a13C0c78912e537cb401cA3D5cdFa1249bf8"], // Argus buyer agent
  providerNames: {
    "0x70146b6152ad60dda4628a618f0515f6305a34c2": "Argus treasury (ASP #5246)",
    "0x9646fd996777acf4c622669f6498edbdb3b53e0d": "VigilOK treasury (ASP #6032)",
  },
  fromBlock: Number(process.env.FROM_BLOCK ?? 64_590_000), // ≈ 2026-07-06, before the agent's first settlement
  toBlock: "latest",
  chunkSize: 10_000,
});

const t0 = Date.now();
const totals = await verifier.reDeriveTotals();
console.log(JSON.stringify(totals, null, 2));
console.log(`(re-derived from the X Layer USD₮0 Transfer ledger in ${((Date.now() - t0) / 1000).toFixed(1)}s — no server trusted)`);
