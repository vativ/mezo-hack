/**
 * Mezo x402 Humor Server — joke paywall demo.
 *
 * One paywalled route: GET /joke returns a random bitcoin joke for 0.001 mUSD.
 *
 * Usage: cp .env.example .env && pnpm install && pnpm run humor
 */

import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Network } from "@x402/core/types";

dotenv.config();

if (!process.env.PAYEE_ADDRESS) {
  console.error("PAYEE_ADDRESS is required. Copy .env.example to .env and fill in your wallet address.");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000");
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://facilitator.vativ.io";
const PAYEE_ADDRESS = process.env.PAYEE_ADDRESS as `0x${string}`;
const NETWORK = (process.env.NETWORK || "eip155:31611") as Network;

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOKES_PATH = join(__dirname, "jokes.json");

interface Joke { setup: string; punchline: string }

async function readJokes(): Promise<Joke[]> {
  return JSON.parse(await readFile(JOKES_PATH, "utf-8")) as Joke[];
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withConfig({ appName: "Mezo x402 Humor Server", testnet: true })
  .build();

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(
  paymentMiddleware(
    {
      "GET /joke": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          payTo: PAYEE_ADDRESS,
          price: "$0.001",
          maxTimeoutSeconds: 300,
        },
        description: "Unlock a Bitcoin joke",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register("eip155:*", new ExactEvmScheme()),
    undefined,
    paywall,
  ),
);

app.get("/joke", async (_req, res) => {
  const jokes = await readJokes();
  const joke = jokes[Math.floor(Math.random() * jokes.length)];
  console.log(`[humor] GET /joke → paid (punchline: "${joke.punchline}")`);
  res.json(joke);
});

app.listen(PORT, () => {
  console.log(`Mezo x402 Humor Server on port ${PORT}`);
  console.log(`  GET /joke — 0.001 mUSD (x402 paywalled)`);
  console.log(`  Facilitator: ${FACILITATOR_URL}`);
  console.log(`  Payee: ${PAYEE_ADDRESS}`);
});
