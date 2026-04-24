# apps/joke-buyer — Mezo x402 agentic joke-buyer

A headless Node.js agent that buys jokes from [`demo.vativ.io/joke`](https://demo.vativ.io/joke) in a loop, signing x402 payment authorizations programmatically from a hot private key. No browser, no MetaMask — just a script that pays and gets paid.

This is Demo 1 of the Mezo agentic-payments series. It reuses the deployed humor seller on Mezo Testnet — the seller doesn't know or care that the client is a program.

## How it works

1. Reads `CLIENT_PRIVATE_KEY` from `.env`.
2. Derives a viem account and wraps `fetch` with `@x402/fetch`'s `wrapFetchWithPayment`.
3. Loops `COUNT` times:
   - `GET https://demo.vativ.io/joke` — server returns `402 Payment Required` with an x402 challenge (0.001 mUSD, scheme: `exact`, network: `eip155:31611`, asset: mUSD).
   - `@x402/fetch` signs a permit2 `SignatureTransferDetails` authorization from the client's wallet to the server's payee, retries the request with an `X-PAYMENT` header.
   - Humor's middleware forwards the payload to `facilitator.vativ.io`, which submits the on-chain `permitTransferFrom` tx and returns a settlement receipt.
   - Server returns `200 OK` with the joke and a `PAYMENT-RESPONSE` header containing the tx hash.
4. At the end, logs total mUSD spent and an explorer URL for each tx.

Exit code is `0` if every purchase succeeded, non-zero otherwise.

## Prerequisites

- Node.js 20+
- pnpm
- A Mezo Testnet wallet with a small balance of testnet mUSD (0.003 mUSD minimum for `COUNT=3`). See the [humor quickstart](../humor/README.md#get-testnet-musd) for how to get some.
- One-time: the client wallet has approved canonical Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) to spend mUSD. Without this, the first purchase fails — the script warns if allowance is zero.

## Setup

```bash
cp .env.example .env
# Fill in CLIENT_PRIVATE_KEY (and optionally COUNT, RESOURCE_URL)
pnpm install
```

## Run

```bash
pnpm start                 # buys COUNT (default 3) jokes
pnpm start -- --count 5    # one-off override
COUNT=10 pnpm start        # env override
```

Expected output:

```
=== Mezo x402 Agentic Joke-Buyer ===
Buyer:     0xfD9cC31Bab44C3d62335d82FA5F17ecf59c8e8f8
Network:   eip155:31611
Target:    https://demo.vativ.io/joke
Count:     3 jokes
Balance:   0.7540 mUSD (754000000000000000 wei)

--- Purchase 1/3 ---
  setup:     Why did Satoshi cross the road?
  punchline: Because he was tired of being chained to his block.
  tx:        0xabc...
  explorer:  https://explorer.test.mezo.org/tx/0xabc...

... (2 more) ...

=== Summary ===
Purchases:     3/3 successful
mUSD spent:    0.0030 mUSD (3000000000000000 wei)
Balance after: 0.7510 mUSD (751000000000000000 wei)

Transactions:
  1. https://explorer.test.mezo.org/tx/0xabc...
  2. https://explorer.test.mezo.org/tx/0xdef...
  3. https://explorer.test.mezo.org/tx/0x123...
Buyer explorer: https://explorer.test.mezo.org/address/0xfD9cC31Bab44C3d62335d82FA5F17ecf59c8e8f8
```

## Configuration

| Variable            | Default                                 | Meaning                                    |
| ------------------- | --------------------------------------- | ------------------------------------------ |
| `CLIENT_PRIVATE_KEY`| —                                       | **Required.** Hot wallet key (testnet only)|
| `RESOURCE_URL`      | `https://demo.vativ.io/joke`           | Paywalled endpoint to hit                  |
| `COUNT`             | `3`                                     | Number of purchases per run                |
| `NETWORK`           | `eip155:31611`                          | CAIP-2 chain id (Mezo Testnet)             |
| `RPC_URL`           | `https://rpc.test.mezo.org`             | Read-only RPC for balance/allowance checks |
| `MUSD_ADDRESS`      | `0x118917...Ac503`                      | mUSD token on Mezo Testnet                 |
| `EXPLORER_URL`      | `https://explorer.test.mezo.org`        | Base URL for tx + address links            |

Also accepts `--count <N>` on the CLI, which takes precedence over `COUNT` in env.

## Troubleshooting

- **`CLIENT_PRIVATE_KEY environment variable is required`** — you didn't create `.env` from `.env.example`, or left the placeholder value.
- **`WARNING: mUSD not approved for Permit2`** — one-time setup is missing. Do `approve(permit2, max)` on the mUSD contract (`0x118917...Ac503`) for your client wallet. Canonical Permit2 is at `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
- **All purchases fail with HTTP 402 after retry** — `@x402/fetch` couldn't complete the sign-and-retry flow. Common causes: no mUSD balance, wrong chain in the `RESOURCE_URL`'s 402 challenge vs. what your wallet is configured for, facilitator offline. Run `curl https://facilitator.vativ.io/health` and `curl https://demo.vativ.io/health` to sanity check the seller and facilitator.
- **`does not provide an export named 'DEFAULT_STABLECOINS'`** — `pnpm.overrides` isn't forcing `@x402/evm` through the preview tarball. Canonical `@x402/evm@2.10.0` on npm omits Mezo-specific exports; the preview tarball restores them.
- **Tx hash missing from output** — the seller didn't attach a `PAYMENT-RESPONSE` header. Script continues (joke still arrived) but logs a warning.

## Install from npm/yarn (not pnpm)

The `pnpm.overrides` block is pnpm-specific. For npm use [`npm overrides`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#overrides); for yarn use [`resolutions`](https://yarnpkg.com/configuration/manifest#resolutions). Same tarball URL, same idea — force the `@x402/evm` resolution through the preview tarball so nothing falls back to canonical npm.
