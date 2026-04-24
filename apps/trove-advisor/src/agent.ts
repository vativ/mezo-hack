/**
 * Mezo x402 Trove Advisor — Demo 2 agent.
 *
 * A Claude tool-use loop that uses three paid Mezo-native data services
 * to stress-test a hypothetical trove. Each tool call becomes one x402
 * payment (real testnet MUSD), routed to a distinct merchant address.
 *
 * Usage: cp .env.example .env && pnpm install && pnpm server (in another
 * terminal), then `pnpm agent`.
 */

import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mezoTestnet } from "viem/chains";

const RPC_URL = process.env.RPC_URL || "https://rpc.test.mezo.org";
const EXPLORER_URL = process.env.EXPLORER_URL || "https://explorer.test.mezo.org";
const TROVE_ADVISOR_URL = process.env.TROVE_ADVISOR_URL || "http://localhost:4402";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const AGENT_PROMPT =
  process.env.AGENT_PROMPT ||
  "I hold 0.5 BTC collateral and I'm considering opening a Mezo trove with 20,000 MUSD of debt against it. " +
    "First, check current BTC price. Then, stress-test this position at −10%, −20%, and −30% BTC drops. " +
    "Finally, show me the top 5 troves currently closest to liquidation so I can see what the risk landscape looks like. " +
    "Use the tools available.";

if (!process.env.CLIENT_PRIVATE_KEY) {
  console.error("CLIENT_PRIVATE_KEY env var is required. Copy .env.example to .env.");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY env var is required. Copy .env.example to .env.");
  process.exit(1);
}

// ─── Paid fetch wrapper (shared across all three tools) ───────────
const account = privateKeyToAccount(process.env.CLIENT_PRIVATE_KEY as `0x${string}`);
const pub = createPublicClient({ chain: mezoTestnet, transport: http(RPC_URL) });
const signer = toClientEvmSigner(account, pub);
const xClient = new x402Client();
xClient.register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPay = wrapFetchWithPayment(fetch, xClient);

interface Tx {
  tool: string;
  tx: string;
  explorer: string;
}
const txLog: Tx[] = [];

async function paidFetch(tool: string, url: string, init?: RequestInit): Promise<unknown> {
  // The Mezo testnet facilitator occasionally returns `invalid_transaction_state`
  // on the first settle for a fresh signer session (appears to be a permit2
  // nonce / pool-warmup effect — subsequent calls clear). Retry once on that
  // specific failure.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const resp = await fetchWithPay(url, init);
    const paymentResponseHeader =
      resp.headers.get("PAYMENT-RESPONSE") || resp.headers.get("X-PAYMENT-RESPONSE");
    let settle: ReturnType<typeof decodePaymentResponseHeader> | undefined;
    if (paymentResponseHeader) {
      settle = decodePaymentResponseHeader(paymentResponseHeader);
      if (settle.transaction) {
        const explorer = `${EXPLORER_URL}/tx/${settle.transaction}`;
        const status = resp.ok ? "paid" : "failed";
        console.log(`  [${status}] ${tool} → tx ${settle.transaction}`);
        console.log(`            ${explorer}`);
        if (resp.ok) txLog.push({ tool, tx: settle.transaction, explorer });
      }
    }
    if (resp.ok) {
      return resp.json();
    }
    const retriable =
      settle?.errorReason === "invalid_transaction_state" && attempt < MAX_ATTEMPTS;
    if (!retriable) {
      const body = await resp.text().catch(() => "<no body>");
      throw new Error(`${tool}: HTTP ${resp.status} — ${body}`);
    }
    console.log(`  [retry ${attempt}/${MAX_ATTEMPTS - 1}] ${tool}: transient settle failure, retrying…`);
    // Brief backoff gives the facilitator time to catch up on nonce/state.
    await new Promise(r => setTimeout(r, 750));
  }
  throw new Error(`${tool}: exhausted retries`);
}

// ─── Tools ─────────────────────────────────────────────────────────

const tools = [
  {
    name: "get_btc_price",
    description:
      "Fetch the current BTC/USD spot price from the Mezo Skip oracle. Costs 0.0005 MUSD per call. Returns { btcUsd, roundId, updatedAt, source, contract }.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "assess_trove_risk",
    description:
      "Stress-test a Mezo trove position at one or more BTC price-drop scenarios (expressed as percent drops, e.g. [10, 20, 30]). Costs 0.0008 MUSD PER scenario. Returns current ICR, liquidation price, and per-scenario post-drop ICR + whether it would liquidate (ICR < 110%).",
    input_schema: {
      type: "object" as const,
      properties: {
        collateralBtc: {
          type: "number",
          description: "Collateral size in BTC (must be > 0).",
        },
        debtMusd: {
          type: "number",
          description: "Debt size in MUSD (must be > 0).",
        },
        scenarios: {
          type: "array",
          items: { type: "number" },
          description:
            "Array of BTC price-drop percentages to stress-test, e.g. [10, 20, 30] for −10%, −20%, −30%.",
        },
      },
      required: ["collateralBtc", "debtMusd", "scenarios"],
    },
  },
  {
    name: "get_liquidation_queue",
    description:
      "Fetch the top-N Mezo troves currently closest to liquidation (lowest ICR first). Costs 0.0005 MUSD PER row returned. Returns an array with per-trove borrower address, ICR, collateral BTC, debt MUSD, liquidation price, and estimated profit.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "How many troves to return (1–50). Default 5.",
        },
      },
      required: ["limit"],
    },
  },
];

async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === "get_btc_price") {
    return paidFetch(name, `${TROVE_ADVISOR_URL}/oracle/btc`);
  }
  if (name === "assess_trove_risk") {
    return paidFetch(name, `${TROVE_ADVISOR_URL}/risk/trove-assessment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  if (name === "get_liquidation_queue") {
    const limit = typeof input.limit === "number" ? input.limit : 5;
    return paidFetch(name, `${TROVE_ADVISOR_URL}/liquidations/queue?limit=${limit}`);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── Claude tool-use loop ──────────────────────────────────────────

async function main() {
  console.log("=== Mezo x402 Trove Advisor — Agent ===");
  console.log(`Buyer:        ${account.address}`);
  console.log(`Server:       ${TROVE_ADVISOR_URL}`);
  console.log(`Claude model: ${ANTHROPIC_MODEL}`);
  console.log("");
  console.log(`Prompt:\n  ${AGENT_PROMPT}`);
  console.log("");

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: AGENT_PROMPT },
  ];

  for (let turn = 1; turn <= 10; turn++) {
    const resp = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      tools,
      messages,
    });

    // Print any text the model emitted this turn.
    for (const block of resp.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`[claude, turn ${turn}]\n${block.text}\n`);
      }
    }

    if (resp.stop_reason !== "tool_use") {
      break;
    }

    const toolUses = resp.content.filter(
      (b): b is Extract<Anthropic.ContentBlock, { type: "tool_use" }> =>
        b.type === "tool_use",
    );
    messages.push({ role: "assistant", content: resp.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      console.log(`[tool] ${use.name}(${JSON.stringify(use.input)})`);
      try {
        const result = await runTool(use.name, use.input as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [error] ${msg}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Error: ${msg}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  console.log("=== Summary ===");
  console.log(`Paid tool calls: ${txLog.length}`);
  console.log("");
  for (const t of txLog) {
    console.log(`  ${t.tool}`);
    console.log(`    ${t.explorer}`);
  }
  console.log("");
  console.log(`Buyer explorer: ${EXPLORER_URL}/address/${account.address}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
