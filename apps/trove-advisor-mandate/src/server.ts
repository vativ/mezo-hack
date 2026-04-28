/**
 * Mezo x402 Trove Advisor — Demo 2 server.
 *
 * Three paywalled Mezo-native data services, each routed to a different
 * merchant address, paid in MUSD via x402:
 *
 *   GET  /oracle/btc                → Merchant A (Oracle Relay)      0.0005 MUSD flat
 *   POST /risk/trove-assessment     → Merchant B (Risk Engine)       0.0008 MUSD per scenario
 *   GET  /liquidations/queue?limit  → Merchant C (Hunter Feed)       0.0005 MUSD per returned row
 *
 * Reads live Mezo testnet state (Skip oracle + SortedTroves + TroveManager).
 * No LLM on this side — the only LLM in the loop is the agent client
 * (src/agent.ts) which calls these endpoints as tools.
 *
 * Usage: cp .env.example .env && pnpm install && pnpm server
 */

import "dotenv/config";

import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import { createPublicClient, http, type Address } from "viem";
import { mezoTestnet } from "viem/chains";

import { skipOracleAbi, sortedTrovesAbi, troveManagerAbi } from "./abi.js";

const PORT = parseInt(process.env.PORT || "4402", 10);
const NETWORK = (process.env.NETWORK || "eip155:31611") as Network;
const RPC_URL = process.env.RPC_URL || "https://rpc.test.mezo.org";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://facilitator.vativ.io";

const MUSD_ADDRESS = (process.env.MUSD_ADDRESS as Address) ||
  "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
const SKIP_ORACLE = (process.env.SKIP_ORACLE as Address) ||
  "0x7b7c000000000000000000000000000000000015";
const SORTED_TROVES = (process.env.SORTED_TROVES as Address) ||
  "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA";
const TROVE_MANAGER = (process.env.TROVE_MANAGER as Address) ||
  "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0";

const ORACLE_PAYTO = (process.env.ORACLE_PAYTO as Address) ||
  "0xca66faaea61365bd94da74bcbfa86518e30dccab";
const RISK_PAYTO = (process.env.RISK_PAYTO as Address) ||
  "0x7f6ac6a84783b44c59238a7f950a3ccfafdbc0f6";
const HUNTER_PAYTO = (process.env.HUNTER_PAYTO as Address) ||
  "0x92cc276667ab0efcab4b021d0cb5d0669b993cdb";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const MCR_BPS = 11000n; // 110% Minimum Collateralization Ratio, basis points

const MUSD_EXTRA = {
  name: "Mezo USD",
  version: "1",
  assetTransferMethod: "permit2",
  supportsEip2612: true,
} as const;

const pub = createPublicClient({ chain: mezoTestnet, transport: http(RPC_URL) });

// ─── Pricing helpers ────────────────────────────────────────────────
// Prices are in MUSD wei (18 decimals). Each endpoint declares its own
// price + payTo. Multi-scenario/multi-row endpoints return a dynamic
// AssetAmount computed from the request body/query.

const ORACLE_PRICE_WEI = 500000000000000n; // 0.0005 MUSD
const RISK_PER_SCENARIO_WEI = 800000000000000n; // 0.0008 MUSD
const HUNTER_PER_ROW_WEI = 500000000000000n; // 0.0005 MUSD

function musdPrice(amountWei: bigint) {
  return {
    asset: MUSD_ADDRESS,
    amount: amountWei.toString(),
    extra: MUSD_EXTRA,
  };
}

// ─── Oracle cache (30s) ─────────────────────────────────────────────

interface OracleReading {
  btcUsd: string;
  roundId: string;
  updatedAt: number;
  source: "skip-oracle";
  contract: string;
  /** Internal: 18-decimal scaled price used by TroveManager.getCurrentICR. */
  price1e18: bigint;
  /** When this reading was fetched (server wall clock ms). */
  fetchedAtMs: number;
}

let oracleCache: OracleReading | null = null;
const ORACLE_CACHE_MS = 30_000;

async function readOracle(): Promise<OracleReading> {
  const now = Date.now();
  if (oracleCache && now - oracleCache.fetchedAtMs < ORACLE_CACHE_MS) {
    return oracleCache;
  }
  const [roundId, answer, , updatedAt] = await pub.readContract({
    address: SKIP_ORACLE,
    abi: skipOracleAbi,
    functionName: "latestRoundData",
  });
  const decimals = await pub.readContract({
    address: SKIP_ORACLE,
    abi: skipOracleAbi,
    functionName: "decimals",
  });
  // Scale the oracle answer up to 1e18 for Liquity-style ICR math.
  const raw = BigInt(answer);
  const d = Number(decimals);
  const price1e18 = d <= 18
    ? raw * 10n ** BigInt(18 - d)
    : raw / 10n ** BigInt(d - 18);
  const btcUsd = (Number(price1e18) / 1e18).toFixed(2);
  oracleCache = {
    btcUsd,
    roundId: roundId.toString(),
    updatedAt: Number(updatedAt),
    source: "skip-oracle",
    contract: SKIP_ORACLE,
    price1e18,
    fetchedAtMs: now,
  };
  return oracleCache;
}

// ─── Trove walk ─────────────────────────────────────────────────────

interface TroveRow {
  borrower: Address;
  icr: string; // percent as string, 2-decimal (e.g. "112.45")
  collateralBtc: string; // 8-decimal BTC (e.g. "0.12345678")
  debtMusd: string; // 2-decimal MUSD (e.g. "10000.00")
  liquidatableAt: string; // BTC price below which trove liquidates, 2-decimal USD
  estimatedProfit: string; // coarse MUSD-equivalent if liquidator captures full coll at current price
}

async function walkTroves(limit: number, price1e18: bigint): Promise<TroveRow[]> {
  const rows: TroveRow[] = [];
  // Bottom of SortedTroves is the lowest-ICR (most at-risk) — that's where a
  // liquidation hunter wants to start.
  let cur = (await pub.readContract({
    address: SORTED_TROVES,
    abi: sortedTrovesAbi,
    functionName: "getLast",
  })) as Address;

  while (cur && cur !== ZERO_ADDRESS && rows.length < limit) {
    const [icrScaled, debtAndColl] = await Promise.all([
      pub.readContract({
        address: TROVE_MANAGER,
        abi: troveManagerAbi,
        functionName: "getCurrentICR",
        args: [cur, price1e18],
      }) as Promise<bigint>,
      pub.readContract({
        address: TROVE_MANAGER,
        abi: troveManagerAbi,
        functionName: "getEntireDebtAndColl",
        args: [cur],
      }) as Promise<[bigint, bigint, bigint, bigint]>,
    ]);
    const [debtWei, collWei] = debtAndColl;
    const icrPct = Number(icrScaled) / 1e16; // scaled 1e18 → percent
    const collBtc = Number(collWei) / 1e18;
    const debtMusd = Number(debtWei) / 1e18;
    // liquidation price: price at which ICR falls below MCR (110%)
    //   ICR = (coll * price) / debt == MCR
    //   price = MCR * debt / coll
    const liqPriceWei = collWei > 0n ? (MCR_BPS * debtWei) / (100n * collWei) : 0n;
    const liqPriceUsd = Number(liqPriceWei) / 1e18;
    const btcUsdNow = Number(price1e18) / 1e18;
    // Coarse: "if I liquidate now at MCR, I net ~10% of debt in discount"
    // (Liquity-style liquidation rewards — not exact, but useful as signal.)
    const estProfit = Math.max(0, collBtc * btcUsdNow - debtMusd);
    rows.push({
      borrower: cur,
      icr: icrPct.toFixed(2),
      collateralBtc: collBtc.toFixed(8),
      debtMusd: debtMusd.toFixed(2),
      liquidatableAt: liqPriceUsd.toFixed(2),
      estimatedProfit: estProfit.toFixed(2),
    });
    cur = (await pub.readContract({
      address: SORTED_TROVES,
      abi: sortedTrovesAbi,
      functionName: "getPrev",
      args: [cur],
    })) as Address;
  }
  // Sort by ascending ICR (riskiest first) — the walk should already be in
  // that order but the linked-list traversal and on-chain state can drift;
  // stable sort is cheap and keeps the contract.
  rows.sort((a, b) => Number(a.icr) - Number(b.icr));
  return rows;
}

// ─── Server ─────────────────────────────────────────────────────────

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    network: NETWORK,
    facilitator: FACILITATOR_URL,
    endpoints: [
      "GET /oracle/btc",
      "POST /risk/trove-assessment",
      "GET /liquidations/queue",
    ],
  });
});

app.use(
  paymentMiddleware(
    {
      "GET /oracle/btc": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: ORACLE_PAYTO,
          price: musdPrice(ORACLE_PRICE_WEI),
          maxTimeoutSeconds: 300,
        },
        description: "Mezo Skip oracle BTC/USD spot read",
        mimeType: "application/json",
      },
      "POST /risk/trove-assessment": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: RISK_PAYTO,
          // Dynamic price: 0.0008 MUSD per stress scenario evaluated.
          price: async ctx => {
            const body = ctx.adapter.getBody?.() as
              | { scenarios?: unknown }
              | undefined;
            const n = Array.isArray(body?.scenarios) ? body!.scenarios!.length : 1;
            return musdPrice(RISK_PER_SCENARIO_WEI * BigInt(Math.max(1, n)));
          },
          maxTimeoutSeconds: 300,
        },
        description: "Stress-test a Mezo trove against BTC-drop scenarios",
        mimeType: "application/json",
      },
      "GET /liquidations/queue": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: HUNTER_PAYTO,
          // Dynamic price: 0.0005 MUSD per requested row (capped by ?limit).
          // If the queue has fewer troves than limit, the handler uses
          // setSettlementOverrides to settle only for the rows actually returned.
          price: async ctx => {
            const q = ctx.adapter.getQueryParams?.() ?? {};
            const raw = typeof q.limit === "string" ? q.limit : "5";
            const limit = Math.max(1, Math.min(50, parseInt(raw, 10) || 5));
            return musdPrice(HUNTER_PER_ROW_WEI * BigInt(limit));
          },
          maxTimeoutSeconds: 300,
        },
        description: "Mezo liquidation queue — troves closest to MCR, riskiest first",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register("eip155:*", new ExactEvmScheme()),
  ),
);

// ─── Handlers (run only after payment verifies) ────────────────────

app.get("/oracle/btc", async (_req: Request, res: Response) => {
  const o = await readOracle();
  res.json({
    btcUsd: o.btcUsd,
    roundId: o.roundId,
    updatedAt: o.updatedAt,
    source: o.source,
    contract: o.contract,
  });
});

app.post("/risk/trove-assessment", async (req: Request, res: Response) => {
  const { collateralBtc, debtMusd, scenarios } = req.body as {
    collateralBtc?: number;
    debtMusd?: number;
    scenarios?: number[];
  };
  if (typeof collateralBtc !== "number" || collateralBtc <= 0) {
    res.status(400).json({ error: "collateralBtc (positive number) is required" });
    return;
  }
  if (typeof debtMusd !== "number" || debtMusd <= 0) {
    res.status(400).json({ error: "debtMusd (positive number) is required" });
    return;
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    res.status(400).json({
      error: "scenarios (non-empty number[]) is required. Example: [10, 20, 30]",
    });
    return;
  }

  const o = await readOracle();
  const price = Number(o.btcUsd);
  const collValue = collateralBtc * price;
  const currentIcrPct = (collValue / debtMusd) * 100;
  // liquidation price such that (collateralBtc * liqPrice) / debtMusd == 110%
  const liquidationPrice = (debtMusd * 1.1) / collateralBtc;

  const results = scenarios.map(dropPct => {
    const postPrice = price * (1 - dropPct / 100);
    const postIcr = (collateralBtc * postPrice) / debtMusd * 100;
    const liquidates = postIcr < 110;
    return {
      dropPct,
      postPrice: postPrice.toFixed(2),
      postIcr: postIcr.toFixed(2),
      liquidates,
    };
  });

  res.json({
    btcUsd: o.btcUsd,
    position: {
      collateralBtc,
      debtMusd,
      collateralValueUsd: collValue.toFixed(2),
      currentIcrPct: currentIcrPct.toFixed(2),
      liquidationPrice: liquidationPrice.toFixed(2),
      mcrPct: 110,
    },
    scenarios: results,
  });
});

app.get("/liquidations/queue", async (req: Request, res: Response) => {
  const rawLimit = typeof req.query.limit === "string" ? req.query.limit : "5";
  const limit = Math.max(1, Math.min(50, parseInt(rawLimit, 10) || 5));
  const o = await readOracle();
  const rows = await walkTroves(limit, o.price1e18);
  // If we returned fewer rows than the client paid for, tell the middleware
  // to settle only for rows actually delivered. (See @x402/express
  // SETTLEMENT_OVERRIDES_HEADER mechanism.)
  if (rows.length < limit) {
    const refundedAmount = HUNTER_PER_ROW_WEI * BigInt(rows.length);
    setSettlementOverrides(res, { amount: refundedAmount.toString() });
  }
  res.json({
    btcUsd: o.btcUsd,
    requestedLimit: limit,
    returned: rows.length,
    queue: rows,
  });
});

app.listen(PORT, () => {
  console.log(`Mezo x402 Trove Advisor on port ${PORT}`);
  console.log(`  Facilitator: ${FACILITATOR_URL}`);
  console.log(`  Network:     ${NETWORK}`);
  console.log("");
  console.log("  Endpoints:");
  console.log(`    GET  /oracle/btc              0.0005 MUSD flat          → ${ORACLE_PAYTO}`);
  console.log(`    POST /risk/trove-assessment   0.0008 MUSD / scenario    → ${RISK_PAYTO}`);
  console.log(`    GET  /liquidations/queue      0.0005 MUSD / row         → ${HUNTER_PAYTO}`);
});
