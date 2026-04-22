# apps/humor — Mezo x402 joke paywall demo

A minimal working x402 payment loop on Mezo Testnet: one paywalled HTTP endpoint and a reference client that pays for it.

- **Server** — Express app with `GET /joke` paywalled at 0.001 mUSD. Returns `{ setup, punchline }` as JSON once paid.
- **Client** — `@x402/fetch`-wrapped HTTP client that detects a 402, signs a permit2 authorization from a funded testnet wallet, retries, and prints the joke.

This is a hackathon starter template. Fork it, swap `/joke` for your own paywalled route, keep the middleware wiring.

## Prerequisites

- Node.js 20+
- pnpm (npm/yarn work too — see note on `overrides` below)
- A Mezo Testnet wallet with a small balance of testnet mUSD (for the client)
- Any address you control (for the server's payee — no key needed)

### Get testnet mUSD

1. Grab testnet BTC from the [Mezo Faucet](https://faucet.test.mezo.org).
2. Borrow mUSD against that BTC using the Mezo Testnet dapp (standard Mezo flow).

## Setup

```bash
cp .env.example server/.env
cp .env.example client/.env
# Edit both: fill PAYEE_ADDRESS in server/.env, CLIENT_PRIVATE_KEY in client/.env
```

Install dependencies (each workspace installs its own tarball set):

```bash
( cd server && pnpm install )
( cd client && pnpm install )
```

## Run

Terminal 1 — server:

```bash
cd server
pnpm run humor
# Mezo x402 Humor Server on port 3000
#   GET /joke — 0.001 mUSD (x402 paywalled)
#   Facilitator: https://facilitator.vativ.io
```

Terminal 2 — client:

```bash
cd client
pnpm run client
# Client wallet: 0x...
# mUSD balance: 10000000000000000000 (10.0000 mUSD)
# Requesting: http://localhost:3000/joke
#
# === Payment Successful ===
# Data: { "setup": "...", "punchline": "..." }
#
# PAYMENT-RESPONSE received (payment receipt from resource server):
#   success:     true
#   transaction: 0x...
#   network:     eip155:31611
# mUSD deducted: 1000000000000000 (0.0010 mUSD)
```

## How it works

1. Client GETs `/joke` with no payment → server returns `402 Payment Required` with an x402 challenge (scheme: `exact`, asset: mUSD, amount: `1000000000000000`).
2. `wrapFetchWithPayment` signs a permit2 `SignatureTransferDetails` authorization for `amount` from the client wallet to the server's `PAYEE_ADDRESS`, retries the request with an `X-PAYMENT` header.
3. Server's `paymentMiddleware` forwards the payload to the facilitator at `FACILITATOR_URL`. The facilitator submits the on-chain `permitTransferFrom` tx.
4. Facilitator returns settlement receipt; server sends `200 OK` with the joke + a `PAYMENT-RESPONSE` header containing the tx hash.

## Install from npm/yarn (not pnpm)

The `pnpm.overrides` block in each `package.json` is pnpm-specific. For npm use [`npm overrides`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#overrides); for yarn use [`resolutions`](https://yarnpkg.com/configuration/manifest#resolutions). Same tarball URLs, same idea — force every `@x402/*` resolution in the dep graph through the preview tarballs so nothing falls back to canonical npm (which lacks the Mezo-specific exports).

## Troubleshooting

- **Client exits with `CLIENT_PRIVATE_KEY environment variable is required`** — you skipped the `.env` step in the client workspace.
- **`WARNING: mUSD not approved for Permit2`** — your wallet has never approved the canonical Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) to spend mUSD. Do a one-time `approve(permit2, max)` on the mUSD contract for your client wallet.
- **`402` with no retry / payment fails** — check the client wallet has non-zero testnet mUSD and that `RESOURCE_URL` matches where the server is listening.
- **`does not provide an export named 'DEFAULT_STABLECOINS'`** — `pnpm.overrides` (or npm/yarn equivalent) isn't forcing the `@x402/*` graph through the preview tarballs. Canonical `@x402/evm@2.10.0` on npm omits that export; the preview tarball restores it.
- **Wrong chain in wallet UI** — the paywall uses Mezo Testnet (`eip155:31611`). Make sure your wallet has the chain added with RPC `https://rpc.test.mezo.org`.

## Live reference deployment

A live version of this exact server runs at `https://humor.vativ.io/joke` against facilitator fleet `https://facilitator.vativ.io`. Hitting it with no payment returns a 402 + paywall HTML; hitting it with this client (pointed at `RESOURCE_URL=https://humor.vativ.io/joke`) settles a real on-chain payment.

## License

MIT — see [LICENSE](../../LICENSE) at the repo root.
