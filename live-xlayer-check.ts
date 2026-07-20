/**
 * Live proof #2: meter402's createEvmVerifier against OKX X Layer mainnet (eip155:196),
 * re-deriving the REAL USD₮0 settlement history of Argus (our own live OKX.AI ASP #5246).
 * Agent = Argus's auditor/patron buyer wallet; providers = whoever it actually paid
 * (Argus treasury for screen/audit/certify calls, target ASPs paid during audit probes).
 */
import { createEvmVerifier } from "./src/verify.js";

const LATEST = 65_735_727;

const verifier = createEvmVerifier({
  network: "xlayer-mainnet",
  rpcUrl: "https://xlayer.drpc.org",
  token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", // USD₮0 (6 decimals)
  agents: ["0x9f67a13C0c78912e537cb401cA3D5cdFa1249bf8"], // Argus auditor/patron buyer
  providerNames: {
    "0x70146b6152ad60dda4628a618f0515f6305a34c2": "Argus treasury",
  },
  fromBlock: 64_590_000, // ≈ 2026-07-06 19:00 UTC (verified via block timestamp) — covers Argus's full live history
  toBlock: LATEST,
  chunkSize: 10_000, // drpc free-tier getLogs cap
});

const t0 = Date.now();
const totals = await verifier.reDeriveTotals();
console.log(JSON.stringify(totals, null, 2));
console.log(`(scanned 500k blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
