/**
 * CLI: re-derive settlement totals from an EVM chain and check them against a public impact feed.
 *
 *   RPC_URL=https://sepolia.base.org \
 *   TOKEN=0xToken AGENTS=0xa1,0xa2 FROM_BLOCK=12345678 \
 *   PROOF=./impact.json \
 *   npx tsx scripts/verify-evm.ts
 *
 * Exits non-zero if the feed over-claims — so it doubles as a CI gate.
 */
import { readFileSync } from "node:fs";
import { createEvmVerifier, verifyAgainst } from "../src/verify.js";
import type { ImpactSnapshot } from "../src/types.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

async function main() {
  const verifier = createEvmVerifier({
    network: process.env.NETWORK ?? "evm",
    rpcUrl: need("RPC_URL"),
    token: need("TOKEN"),
    agents: need("AGENTS").split(",").map((s) => s.trim()),
    fromBlock: process.env.FROM_BLOCK ? Number(process.env.FROM_BLOCK) : 0,
  });

  const impact = JSON.parse(readFileSync(process.env.PROOF ?? "impact.json", "utf8")) as ImpactSnapshot;
  const report = await verifyAgainst(verifier, impact);

  console.log(`ON-CHAIN (${report.network}):`);
  for (const [name, v] of Object.entries(report.perProvider)) {
    console.log(`  ${name.padEnd(24)} ${String(v.count).padStart(4)} settlements · ${v.total}`);
  }
  console.log(`  ${"TOTAL".padEnd(24)} ${String(report.chain.settlements).padStart(4)} settlements · ${report.chain.totalPaid}`);
  console.log(`\nFEED claims: ${report.claimed.settlements} settlements · ${report.claimed.totalPaid}`);
  console.log(report.verified ? `\n✅ VERIFIED — ${report.note}` : `\n⚠️  ${report.note}`);
  if (!report.verified) process.exit(1);
}

main().catch((e) => {
  console.error("❌", (e as Error).message);
  process.exit(1);
});
