/**
 * Mezo x402 Client — pays for paywalled resources using mUSD via permit2.
 *
 * Uses @x402/fetch wrapFetchWithPayment to automatically handle 402 responses.
 * Mirrors coinbase/x402 typescript/examples/typescript/clients/fetch/index.ts.
 *
 * Usage: cp .env.example .env && npx tsx client.ts
 */

import "dotenv/config";

import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner, PERMIT2_ADDRESS, DEFAULT_STABLECOINS } from "@x402/evm";
import { createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mezoTestnet } from "viem/chains";

const RESOURCE_URL = process.env.RESOURCE_URL || "http://localhost:3000/joke";
const NETWORK = process.env.NETWORK || "eip155:31611";
const RPC_URL = process.env.RPC_URL || process.env.MEZO_RPC_URL || "https://rpc.test.mezo.org";

// Token info (address, decimals, name) auto-resolved from @x402/evm's
// DEFAULT_STABLECOINS registry based on NETWORK.
const TOKEN = DEFAULT_STABLECOINS[NETWORK as keyof typeof DEFAULT_STABLECOINS];
if (!TOKEN) {
  console.error(`No DEFAULT_STABLECOINS entry for NETWORK=${NETWORK}`);
  process.exit(1);
}
const TOKEN_DIVISOR = 10 ** TOKEN.decimals;

async function main() {
  if (!process.env.CLIENT_PRIVATE_KEY) {
    console.error("CLIENT_PRIVATE_KEY environment variable is required");
    process.exit(1);
  }

  const account = privateKeyToAccount(process.env.CLIENT_PRIVATE_KEY as `0x${string}`);
  console.log(`Client wallet: ${account.address}`);
  console.log(`Network: ${NETWORK}`);
  console.log(`RPC: ${RPC_URL}`);

  // Set up viem public client for balance/allowance checks
  const publicClient = createPublicClient({
    chain: mezoTestnet,
    transport: http(RPC_URL),
  });

  // Check token balance
  const tokenAddress = TOKEN.address as `0x${string}`;
  const startBalance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`${TOKEN.name} balance: ${startBalance} (${(Number(startBalance) / TOKEN_DIVISOR).toFixed(4)} ${TOKEN.name})`);

  // Check Permit2 allowance
  const permit2Addr = (process.env.PERMIT2_ADDRESS || PERMIT2_ADDRESS) as `0x${string}`;
  const allowance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, permit2Addr],
  });
  if (allowance === 0n) {
    console.warn(`WARNING: ${TOKEN.name} not approved for Permit2. Run the cast send approve recipe in the demo docs.`);
  }

  // Create x402 client with EVM exact scheme and wrap fetch
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  // Make paid request — wrapFetchWithPayment handles the 402 flow automatically
  console.log(`\nRequesting: ${RESOURCE_URL}`);
  const response = await fetchWithPay(RESOURCE_URL);

  if (!response.ok) {
    console.error(`Request failed: ${response.status}`);
    const body = await response.text();
    console.error(body);
    return;
  }

  const data = await response.json();
  console.log("\n=== Payment Successful ===");
  console.log("Data:", JSON.stringify(data, null, 2));

  // Extract settlement response (payment receipt) from PAYMENT-RESPONSE header
  const paymentResponseHeader = response.headers.get("PAYMENT-RESPONSE");
  if (paymentResponseHeader) {
    const settleResponse = decodePaymentResponseHeader(paymentResponseHeader);
    console.log("\nPAYMENT-RESPONSE received (payment receipt from resource server):");
    console.log(`  success:     ${settleResponse.success}`);
    console.log(`  transaction: ${settleResponse.transaction}`);
    console.log(`  network:     ${settleResponse.network}`);
    if (settleResponse.payer) console.log(`  payer:       ${settleResponse.payer}`);

    if (settleResponse.transaction) {
      console.log(`Tx hash: ${settleResponse.transaction}`);
    }
    console.log(`Network: ${settleResponse.network || NETWORK}`);
  } else {
    console.warn("WARNING: No PAYMENT-RESPONSE header received from resource server (spec violation)");
  }

  // Show ending balance and delta to confirm on-chain settlement
  const endBalance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const delta = startBalance - endBalance;
  console.log(`\n${TOKEN.name} balance after:  ${endBalance} (${(Number(endBalance) / TOKEN_DIVISOR).toFixed(4)} ${TOKEN.name})`);
  console.log(`${TOKEN.name} balance before: ${startBalance} (${(Number(startBalance) / TOKEN_DIVISOR).toFixed(4)} ${TOKEN.name})`);
  console.log(`${TOKEN.name} deducted:       ${delta} (${(Number(delta) / TOKEN_DIVISOR).toFixed(4)} ${TOKEN.name})`);
}

main().catch((err) => {
  console.error("Client error:", err);
  process.exit(1);
});
