/**
 * Mezo x402 Trove Mandate — Demo 3 agent.
 *
 * Same three tools as Demo 2 (trove-advisor), but the x402 client runs every
 * payment through a single `onBeforePaymentCreation` hook that enforces a
 * plain JS spend policy BEFORE any MUSD moves. Denied calls never produce
 * an on-chain transaction — the policy aborts the payment creation.
 *
 * The agent catches policy denials and returns them to Claude as structured
 * tool errors, so the model can see what got blocked and continue with the
 * tools that were approved.
 */

import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mezoTestnet } from "viem/chains";

import { SpendPolicy } from "./policy.js";

const RPC_URL = process.env.RPC_URL || "https://rpc.test.mezo.org";
const EXPLORER_URL = process.env.EXPLORER_URL || "https://explorer.test.mezo.org";
const TROVE_ADVISOR_URL = process.env.TROVE_ADVISOR_URL || "http://localhost:4402";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const AGENT_PROMPT =
  process.env.AGENT_PROMPT ||
  "I hold 0.5 BTC and I'm considering borrowing 20,000 MUSD against it on Mezo. " +
    "Check current BTC price, stress-test this position at −10%, −20%, and −30% BTC drops, " +
    "and if possible show me the top 5 liquidation targets right now. " +
    "You have a MUSD spend cap of $0.05 total per session — try to stay within it.";

// Merchant addresses must match the server's env (ORACLE_PAYTO / RISK_PAYTO /
// HUNTER_PAYTO). Hardcoded here because the policy is a client-side budget
// mandate, not something driven by the server's config.
const MERCHANT_A = "0xca66faaea61365bd94da74bcbfa86518e30dccab"; // oracle
const MERCHANT_B = "0x7f6ac6a84783b44c59238a7f950a3ccfafdbc0f6"; // risk
const MERCHANT_C = "0x92cc276667ab0efcab4b021d0cb5d0669b993cdb"; // hunter

if (!process.env.CLIENT_PRIVATE_KEY) {
  console.error("CLIENT_PRIVATE_KEY env var is required. Copy .env.example to .env.");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY env var is required. Copy .env.example to .env.");
  process.exit(1);
}

// ─── Policy ────────────────────────────────────────────────────────
// Tight on `liquidations` so the default limit=5 call (0.0025 MUSD) trips the
// per-call cap (0.002 MUSD) — this is the reader-visible "policy fires" moment.

const policy = new SpendPolicy({
  maxPerCall: {
    oracle: 0.001, // 2× actual 0.0005 — normal calls pass
    risk: 0.005, // up to ~6 scenarios
    liquidations: 0.002, // DELIBERATELY TIGHT — limit=5 (0.0025) is denied
  },
  maxPerMerchant: {
    [MERCHANT_A]: 0.005,
    [MERCHANT_B]: 0.02,
    [MERCHANT_C]: 0.01,
  },
  maxTotal: 0.05,
  merchantAllowlist: [MERCHANT_A, MERCHANT_B, MERCHANT_C],
  timeWindow: 5 * 60_000,
  rateLimit: {
    liquidations: { max: 2, perMs: 60_000 },
  },
});

// ─── x402 client + paid fetch wrapper ──────────────────────────────
const account = privateKeyToAccount(process.env.CLIENT_PRIVATE_KEY as `0x${string}`);
const pub = createPublicClient({ chain: mezoTestnet, transport: http(RPC_URL) });
const signer = toClientEvmSigner(account, pub);
const xClient = new x402Client()
  .register("eip155:*", new ExactEvmScheme(signer))
  .onBeforePaymentCreation(policy.asHook());
const fetchWithPay = wrapFetchWithPayment(fetch, xClient);

interface Tx {
  tool: string;
  tx: string;
  explorer: string;
}
const txLog: Tx[] = [];
interface Denial {
  tool: string;
  reason: string;
}
const denials: Denial[] = [];

async function paidFetch(tool: string, url: string, init?: RequestInit): Promise<unknown> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp: Response;
    try {
      resp = await fetchWithPay(url, init);
    } catch (err) {
      // Policy aborts surface as "Failed to create payment payload: <reason>".
      // Recognize and report as a structured denial rather than a raw throw.
      const msg = err instanceof Error ? err.message : String(err);
      const m = msg.match(/Failed to create payment payload:\s*(.*)$/s);
      const reason = (m ? m[1].trim() : msg).replace(/\s+/g, " ");
      console.log(`  [denied] ${tool} — policy blocked: ${reason}`);
      denials.push({ tool, reason });
      throw new PolicyDenialError(`policy_denied: ${reason}`);
    }
    const paymentResponseHeader =
      resp.headers.get("PAYMENT-RESPONSE") || resp.headers.get("PAYMENT-RESPONSE");
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
    if (resp.ok) return resp.json();
    const retriable =
      settle?.errorReason === "invalid_transaction_state" && attempt < MAX_ATTEMPTS;
    if (!retriable) {
      const body = await resp.text().catch(() => "<no body>");
      throw new Error(`${tool}: HTTP ${resp.status} — ${body}`);
    }
    console.log(`  [retry ${attempt}/${MAX_ATTEMPTS - 1}] ${tool}: transient settle failure, retrying…`);
    await new Promise(r => setTimeout(r, 750));
  }
  throw new Error(`${tool}: exhausted retries`);
}

class PolicyDenialError extends Error {}

// ─── Tools ─────────────────────────────────────────────────────────

const tools = [
  {
    name: "get_btc_price",
    description:
      "Fetch the current BTC/USD spot price from the Mezo Skip oracle. Costs 0.0005 MUSD per call.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "assess_trove_risk",
    description:
      "Stress-test a Mezo trove at one or more BTC price-drop scenarios. Costs 0.0008 MUSD per scenario.",
    input_schema: {
      type: "object" as const,
      properties: {
        collateralBtc: { type: "number" },
        debtMusd: { type: "number" },
        scenarios: { type: "array", items: { type: "number" } },
      },
      required: ["collateralBtc", "debtMusd", "scenarios"],
    },
  },
  {
    name: "get_liquidation_queue",
    description:
      "Fetch the top-N Mezo troves closest to liquidation. Costs 0.0005 MUSD per row returned.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number" },
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
  console.log("=== Mezo x402 Trove Mandate — Agent ===");
  console.log(`Buyer:        ${account.address}`);
  console.log(`Server:       ${TROVE_ADVISOR_URL}`);
  console.log(`Claude model: ${ANTHROPIC_MODEL}`);
  console.log("");
  console.log("Policy:");
  console.log("  maxPerCall:     oracle=0.001  risk=0.005  liquidations=0.002  (MUSD)");
  console.log("  maxPerMerchant: A=0.005  B=0.02  C=0.01");
  console.log("  maxTotal:       0.05   timeWindow: 5 min   rate: liquidations 2/min");
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

    for (const block of resp.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log(`[claude, turn ${turn}]\n${block.text}\n`);
      }
    }

    if (resp.stop_reason !== "tool_use") break;

    const toolUses = resp.content.filter(
      (b): b is Extract<Anthropic.ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
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
        if (!(err instanceof PolicyDenialError)) {
          console.error(`  [error] ${msg}`);
        }
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

  const s = policy.summary();
  console.log("=== Summary ===");
  console.log(`Paid tool calls:   ${txLog.length}`);
  console.log(`Denied tool calls: ${denials.length}`);
  console.log(`Policy spend:      ${s.totalMusd.toFixed(4)} MUSD total`);
  for (const [m, v] of Object.entries(s.perMerchant)) {
    console.log(`                   ${m} = ${v.toFixed(4)} MUSD`);
  }
  console.log("");
  if (txLog.length > 0) {
    console.log("On-chain transactions:");
    for (const t of txLog) {
      console.log(`  ${t.tool}`);
      console.log(`    ${t.explorer}`);
    }
  }
  if (denials.length > 0) {
    console.log("Policy denials (no on-chain tx for these):");
    for (const d of denials) {
      console.log(`  ${d.tool} — ${d.reason}`);
    }
  }
  console.log("");
  console.log(`Buyer explorer: ${EXPLORER_URL}/address/${account.address}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
