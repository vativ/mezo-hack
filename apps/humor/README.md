# apps/humor — Mezo x402 quickstart

A minimal x402 payment loop on Mezo Testnet using the default
`@x402/paywall` UI: one paywalled HTTP endpoint and a reference
client that pays for it.

- **Server** — Express app with `GET /joke` paywalled at 0.001 mUSD.
  Returns `{ setup, punchline }` as JSON once paid.
- **Client** — `@x402/fetch`-wrapped HTTP client that detects a 402,
  signs a permit2 authorization from a funded testnet wallet,
  retries, and prints the joke.

This is the **slim quickstart**: copy-paste from the docs, shows what
x402 ships out of the box. For the **production-style demo with custom
UI on top of x402**, see
[`ryanRfox/gt-mezo-x402`](https://github.com/ryanRfox/gt-mezo-x402)
(the live deployment at `humor.vativ.io`).

## Prerequisites

- Node.js 20+
- pnpm
- A Mezo Testnet wallet with a small balance of testnet mUSD (for
  the client)
- Any EVM address you control (for the server's payee — no key
  needed on the server side)

To get testnet mUSD: grab testnet BTC from the
[Mezo Faucet](https://faucet.test.mezo.org), then borrow mUSD against
it using the Mezo Testnet dapp (standard Mezo flow).

## Default token

This demo uses Mezo Testnet's canonical mUSD token:
[`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/address/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503).
The address is auto-resolved from `@x402/evm`'s `DEFAULT_STABLECOINS`
registry based on the `NETWORK` env var; to verify, see
`node_modules/@x402/evm/dist/cjs/index.js`.

## Quickstart

```bash
# Server-side env (set EVM_ADDRESS to any address you control)
cp .env.example server/.env

# Client-side env (set CLIENT_PRIVATE_KEY to a funded testnet wallet)
cp client/.env.example client/.env

# Install
( cd server && pnpm install )
( cd client && pnpm install )

# Terminal 1: server on :3000
( cd server && pnpm run humor )

# Terminal 2: client pays /joke
( cd client && pnpm run client )
```

The client should print `=== Payment Successful ===` followed by the
joke payload and a `PAYMENT-RESPONSE` header carrying the on-chain tx
hash. Look the tx up on
[`explorer.test.mezo.org`](https://explorer.test.mezo.org) to see the
mUSD flow on chain.

## Rich docs

For the full walkthrough — what each component does, how the 402
handshake settles via the facilitator, troubleshooting, and the
`onBeforePaymentCreation` policy hook used by the agentic demos — see
the consolidated docs branch:

- Quickstart page:
  https://github.com/ryanRfox/mezo-docs/blob/docs/x402-v2.11.0-consolidated/src/content/docs/docs/developers/getting-started/musd-payments-x402/x402-quickstart.mdx

(Preview URL; will be fixed to the canonical published URL once the
docs ship upstream.)

## Versions

This app pins canonical `@x402/paywall` and `@x402/evm` to `^2.11.0`
on this feat branch. `main` of `vativ/mezo-hack` still references the
preview tarball overrides — to follow these instructions verbatim,
`git checkout feat/quickstart-humor-x402-2.11.0-canonical` first.

## License

MIT — see [LICENSE](../../LICENSE) at the repo root.
