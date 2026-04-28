/**
 * Mezo x402 Agentic Joke-Buyer — loops N purchases of demo.vativ.io/joke
 * without a browser or MetaMask.
 *
 * Signs payment authorizations programmatically from a hot private key and
 * uses @x402/fetch to handle the 402 retry flow.
 *
 * Usage:
 *   cp .env.example .env && pnpm install
 *   pnpm start                 # buys COUNT (default 3) jokes
 *   pnpm start -- --count 5    # overrides COUNT
 */

import "dotenv/config";

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner, PERMIT2_ADDRESS, DEFAULT_STABLECOINS } from "@x402/evm";
import { createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mezoTestnet } from "viem/chains";

const RESOURCE_URL = process.env.RESOURCE_URL || "https://demo.vativ.io/joke";
const NETWORK = process.env.NETWORK || "eip155:31611";
const RPC_URL = process.env.RPC_URL || "https://rpc.test.mezo.org";
const EXPLORER_URL = process.env.EXPLORER_URL || "https://explorer.test.mezo.org";

// Token info (address, decimals, name) auto-resolved from @x402/evm's
// DEFAULT_STABLECOINS registry based on NETWORK.
const TOKEN = DEFAULT_STABLECOINS[NETWORK as keyof typeof DEFAULT_STABLECOINS];
if (!TOKEN) {
  console.error(`No DEFAULT_STABLECOINS entry for NETWORK=${NETWORK}`);
  process.exit(1);
}
const TOKEN_ADDRESS = TOKEN.address as `0x${string}`;
const TOKEN_DIVISOR = 10 ** TOKEN.decimals;

interface Purchase {
  index: number;
  joke: { setup: string; punchline: string };
  tx?: string;
  network?: string;
  success: boolean;
}

function parseCount(): number {
  const argIdx = process.argv.indexOf("--count");
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    const n = parseInt(process.argv[argIdx + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (process.env.COUNT) {
    const n = parseInt(process.env.COUNT, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3;
}

async function main() {
  if (!process.env.CLIENT_PRIVATE_KEY) {
    console.error("CLIENT_PRIVATE_KEY environment variable is required. Copy .env.example to .env.");
    process.exit(1);
  }

  const count = parseCount();
  const account = privateKeyToAccount(process.env.CLIENT_PRIVATE_KEY as `0x${string}`);

  const publicClient = createPublicClient({
    chain: mezoTestnet,
    transport: http(RPC_URL),
  });

  const startBalance = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  const allowance = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, PERMIT2_ADDRESS as `0x${string}`],
  });

  console.log("=== Mezo x402 Agentic Joke-Buyer ===");
  console.log(`Buyer:     ${account.address}`);
  console.log(`Network:   ${NETWORK}`);
  console.log(`Target:    ${RESOURCE_URL}`);
  console.log(`Count:     ${count} joke${count === 1 ? "" : "s"}`);
  console.log(
    `Balance:   ${(Number(startBalance) / TOKEN_DIVISOR).toFixed(4)} ${TOKEN.name} (${startBalance} wei)`,
  );
  if (allowance === 0n) {
    console.warn(
      `WARNING: ${TOKEN.name} not approved for Permit2. The first purchase will likely fail until you do a one-time approve(permit2, max) on the ${TOKEN.name} contract.`,
    );
  }
  console.log("");

  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const purchases: Purchase[] = [];
  const failures: Array<{ index: number; error: string }> = [];

  for (let i = 1; i <= count; i++) {
    console.log(`--- Purchase ${i}/${count} ---`);
    try {
      const response = await fetchWithPay(RESOURCE_URL);
      if (!response.ok) {
        const body = await response.text().catch(() => "<no body>");
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      const joke = (await response.json()) as { setup: string; punchline: string };

      const paymentResponseHeader =
        response.headers.get("PAYMENT-RESPONSE") ||
        response.headers.get("PAYMENT-RESPONSE");
      const settle = paymentResponseHeader
        ? decodePaymentResponseHeader(paymentResponseHeader)
        : undefined;

      purchases.push({
        index: i,
        joke,
        tx: settle?.transaction,
        network: settle?.network || NETWORK,
        success: settle?.success ?? true,
      });

      console.log(`  setup:     ${joke.setup}`);
      console.log(`  punchline: ${joke.punchline}`);
      if (settle?.transaction) {
        console.log(`  tx:        ${settle.transaction}`);
        console.log(`  explorer:  ${EXPLORER_URL}/tx/${settle.transaction}`);
      } else {
        console.warn(`  WARNING: no PAYMENT-RESPONSE header (tx unknown)`);
      }
      console.log("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg}\n`);
      failures.push({ index: i, error: msg });
    }
  }

  const endBalance = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const spent = startBalance - endBalance;

  console.log("=== Summary ===");
  console.log(`Purchases:     ${purchases.length}/${count} successful`);
  console.log(
    `${TOKEN.name} spent:    ${(Number(spent) / TOKEN_DIVISOR).toFixed(4)} ${TOKEN.name} (${spent} wei)`,
  );
  console.log(
    `Balance after: ${(Number(endBalance) / TOKEN_DIVISOR).toFixed(4)} ${TOKEN.name} (${endBalance} wei)`,
  );
  console.log("");
  console.log("Transactions:");
  for (const p of purchases) {
    if (p.tx) {
      console.log(`  ${p.index}. ${EXPLORER_URL}/tx/${p.tx}`);
    } else {
      console.log(`  ${p.index}. (no tx hash in PAYMENT-RESPONSE)`);
    }
  }
  console.log(`Buyer explorer: ${EXPLORER_URL}/address/${account.address}`);

  if (failures.length > 0) {
    console.error("\nFailed purchases:");
    for (const f of failures) {
      console.error(`  ${f.index}: ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
