# apps/trove-advisor — Mezo x402 trove advisor (Demo 2)

A Claude tool-use agent that buys three Mezo-native data services via x402, paying in real testnet MUSD to **three distinct merchant addresses**. Demonstrates multi-merchant settlement + dynamic (per-request) pricing in one local demo.

This is Demo 2 of the Mezo agentic-payments series. Demo 1 (`apps/joke-buyer/`) paid a single merchant in a loop; here the agent decides which of three paid endpoints to call, with per-call price that varies based on request content.

## What the agent does

With the default prompt: stress-tests a hypothetical Mezo trove.

1. Calls **`get_btc_price`** → hits `GET /oracle/btc` (0.0005 MUSD → Merchant A "Oracle Relay").
2. Calls **`assess_trove_risk`** with `{ collateralBtc, debtMusd, scenarios }` → hits `POST /risk/trove-assessment` (0.0008 MUSD **per scenario** → Merchant B "Risk Engine").
3. Calls **`get_liquidation_queue`** with `{ limit }` → hits `GET /liquidations/queue?limit=N` (0.0005 MUSD **per row returned** → Merchant C "Hunter Feed").

Total for the default prompt (3 scenarios + 5 liquidation rows): **0.0054 MUSD in 3 on-chain txs**.

## What the server does

Runs locally on port 4402 (configurable via `PORT`). Three paywalled endpoints backed by real Mezo testnet contracts:

| Route | Merchant | Price | Reads |
|-|-|-|-|
| `GET /oracle/btc` | Oracle Relay | 0.0005 MUSD flat, 30s cache | Skip oracle `latestRoundData()` |
| `POST /risk/trove-assessment` | Risk Engine | 0.0008 MUSD × `scenarios.length` | Skip oracle + local math |
| `GET /liquidations/queue?limit=N` | Hunter Feed | 0.0005 MUSD × rows returned (settlement refunded if fewer rows are available than requested) | SortedTroves + TroveManager |

The server is pure data+math. No LLM on the server side — the only LLM is the agent client.

## Prerequisites

- Node.js 20+
- pnpm
- An Anthropic API key (for the agent).
- A Mezo Testnet wallet with a small MUSD balance (0.0054+ MUSD for the default run). See [`../joke-buyer/README.md`](../joke-buyer/README.md#prerequisites) for how to get some.
- One-time: the client wallet has approved canonical Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) to spend MUSD. Without this, the first call fails.

## Setup

```bash
cp .env.example .env
# Fill in CLIENT_PRIVATE_KEY and ANTHROPIC_API_KEY
pnpm install
```

## Run (two terminals)

Terminal 1 — server:

```bash
pnpm server
# Mezo x402 Trove Advisor on port 4402
#   Endpoints:
#     GET  /oracle/btc              0.0005 MUSD flat          → 0xca66…
#     POST /risk/trove-assessment   0.0008 MUSD / scenario    → 0x7f6a…
#     GET  /liquidations/queue      0.0005 MUSD / row         → 0x92cc…
```

Terminal 2 — agent:

```bash
pnpm agent
```

Expected: ~10–15 sec of Claude thinking, 3 paid tool calls, 3 tx hashes with explorer links, a trove recommendation based on live data.

## Verifying the demo

Sanity checks you can run from a shell without the agent:

```bash
# Server responds to /health (no payment required)
curl -s http://localhost:4402/health

# /oracle/btc returns 402 with a real PAYMENT-REQUIRED challenge
curl -s -i http://localhost:4402/oracle/btc | head -12

# Dynamic pricing on /risk: 3 scenarios → 0.0024 MUSD
curl -s -i -X POST -H 'Content-Type: application/json' \
  -d '{"collateralBtc":0.5,"debtMusd":20000,"scenarios":[10,20,30]}' \
  http://localhost:4402/risk/trove-assessment \
  | grep -i payment-required | sed 's/payment-required: //i' \
  | tr -d '\r' | base64 -d | python3 -m json.tool
# → accepts[0].amount == "2400000000000000" (0.0024 MUSD)

# Dynamic pricing on /liquidations: limit=5 → 0.0025 MUSD
curl -s -i "http://localhost:4402/liquidations/queue?limit=5" \
  | grep -i payment-required | sed 's/payment-required: //i' \
  | tr -d '\r' | base64 -d | python3 -m json.tool
# → accepts[0].amount == "2500000000000000" (0.0025 MUSD)
```

After running `pnpm agent`, each printed tx on the Mezo explorer will show a buyer→merchant MUSD `Transfer`. Verify:

- Oracle tx's ERC-20 Transfer destination = `ORACLE_PAYTO`
- Risk tx's Transfer destination = `RISK_PAYTO`
- Hunter tx's Transfer destination = `HUNTER_PAYTO`

All three merchants are burn-style test addresses — nobody controls their keys. That's fine; receivers don't need keys for permit2 transfers.

## Configuration

| Variable | Default | Meaning |
|-|-|-|
| `CLIENT_PRIVATE_KEY` | — | **Required**. Agent's hot wallet key (testnet only). |
| `ANTHROPIC_API_KEY` | — | **Required**. Anthropic API key for the tool-use loop. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Override the Claude model if needed. |
| `TROVE_ADVISOR_URL` | `http://localhost:4402` | Where the agent sends its paid fetches. |
| `PORT` | `4402` | Server listen port. |
| `ORACLE_PAYTO` / `RISK_PAYTO` / `HUNTER_PAYTO` | burn addresses (see `.env.example`) | Override to send MUSD to wallets you control. |
| `RPC_URL` | `https://rpc.test.mezo.org` | Mezo Testnet RPC. |
| `FACILITATOR_URL` | `https://facilitator.vativ.io` | x402 facilitator. |
| `AGENT_PROMPT` | see `src/agent.ts` | Override to try a different scenario. |

## How dynamic pricing works

Two endpoints charge per unit of work. `@x402/core`'s `PaymentOption.price` accepts a function (`DynamicPrice`) that runs on every request:

```ts
// apps/trove-advisor/src/server.ts
"POST /risk/trove-assessment": {
  accepts: {
    payTo: RISK_PAYTO,
    price: async ctx => {
      const body = ctx.adapter.getBody?.() as { scenarios?: unknown } | undefined;
      const n = Array.isArray(body?.scenarios) ? body!.scenarios!.length : 1;
      return musdPrice(RISK_PER_SCENARIO_WEI * BigInt(Math.max(1, n)));
    },
    // ...
  },
  // ...
},
```

The 402 response emitted to the client already reflects the request-specific amount, so `@x402/fetch` on the agent side signs exactly that and retries — no separate negotiation round trip.

For `/liquidations/queue`, the client pays upfront based on `?limit=N`, but if the on-chain SortedTroves list has fewer troves than `limit`, the handler sets the `Settlement-Overrides` response header so the middleware settles only for the rows actually returned.

## Troubleshooting

- **`CLIENT_PRIVATE_KEY environment variable is required`** — copy `.env.example` to `.env` and fill in.
- **`invalid_transaction_state` in the PAYMENT-RESPONSE** — transient Mezo testnet facilitator flake (permit2 pool warmup on first call per fresh signer session). The agent retries up to 4 times with backoff; if it still fails, check the facilitator health at `curl https://facilitator.vativ.io/health` and rerun.
- **`WARNING: mUSD not approved for Permit2`** — one-time: `approve(permit2, max)` on the MUSD contract (`0x118917…Ac503`) for your client wallet. Canonical Permit2 is at `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
- **`does not provide an export named 'DEFAULT_STABLECOINS'`** — `pnpm.overrides` isn't forcing `@x402/evm` through the preview tarball. Canonical `@x402/evm@2.10.0` on npm omits Mezo-specific exports; the preview tarball restores them.
- **`Error: Unsupported chain ID: 31611`** — `viem` doesn't know about Mezo Testnet. The agent pins `viem/chains` → `mezoTestnet`, which landed upstream in `viem@2.47.10+`.

## Install from npm/yarn (not pnpm)

The `pnpm.overrides` block is pnpm-specific. For npm use [`npm overrides`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#overrides); for yarn use [`resolutions`](https://yarnpkg.com/configuration/manifest#resolutions). Same tarball URL, same idea — force the `@x402/evm` resolution through the preview tarball so nothing falls back to canonical npm.

## Rich docs

For the full walkthrough — what each component does, how the
`onBeforePaymentCreation` hook fits in, troubleshooting, and
the canonical x402 v2.11.0 dependency setup — see the
consolidated docs branch on `ryanRfox/mezo-docs`:

- This demo's page:
  https://github.com/ryanRfox/mezo-docs/blob/docs/x402-v2.11.0-consolidated/src/content/docs/docs/developers/getting-started/musd-payments-x402/trove-advisor.mdx

(Preview URL; will be fixed to the canonical published URL once
the docs ship upstream.)

## Versions

This app pins canonical `@x402/*` packages to `^2.11.0` on this
feat branch. `main` of `vativ/mezo-hack` still references the
`v2.10.0-mezo.7` preview tarball overrides — to follow the
quickstart docs verbatim, `git checkout feat/agentic-2-trove-advisor-x402-2.11.0-canonical` first.
