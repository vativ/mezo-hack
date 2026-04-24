# apps/trove-advisor-mandate — Mezo x402 trove mandate (Demo 3)

Same three paid endpoints + three merchants + agent prompt shape as [Demo 2](../trove-advisor/), with one addition: the x402 client gets an `onBeforePaymentCreation` hook that runs every outbound payment through a plain-JS **spend policy** before any MUSD moves on-chain.

The story for readers: *add guardrails to an agentic buyer in one well-defined place.*

## What's new vs. Demo 2

A single `.onBeforePaymentCreation(...)` on the `x402Client` in `src/agent.ts`:

```ts
const xClient = new x402Client()
  .register("eip155:*", new ExactEvmScheme(signer))
  .onBeforePaymentCreation(policy.asHook());
```

The hook receives `{ paymentRequired, selectedRequirements }` — the full 402 response and the single `accepts[]` entry the client has chosen to sign. Before any permit2 signature is created, the hook runs the policy; if it returns `{ abort: true, reason }`, `@x402/core` aborts payload creation, no signature is produced, **no on-chain tx is submitted**. The agent catches the abort and returns it to Claude as a structured tool error so the model can see and respond to the denial.

## The policy rules (`src/policy.ts`)

Six checks, applied in order:

1. **`merchantAllowlist`** — hard reject if `payTo` is not in the list.
2. **`maxPerCall[endpoint]`** — reject if this single call's amount exceeds the per-endpoint cap. (Inferred from the `resource.url` path: `/oracle/…`, `/risk/…`, `/liquidations/…`.)
3. **`maxPerMerchant[payTo]`** — reject if the running cumulative spend for that merchant would exceed their cap.
4. **`maxTotal`** — reject if the running session total would exceed the session cap.
5. **`rateLimit[endpoint]`** — sliding window; reject if the endpoint was called too many times recently.
6. **`timeWindow`** — session counters auto-reset if the agent has been idle past the window.

If all pass, the hook commits the spend intent (increments the running counters + timestamp log) and returns `undefined` to approve.

### Default policy in the demo

```ts
new SpendPolicy({
  maxPerCall: {
    oracle:       0.001,  // 2× actual 0.0005 — normal calls pass
    risk:         0.005,  // up to ~6 stress scenarios
    liquidations: 0.002,  // DELIBERATELY TIGHT — a limit=5 call (0.0025) is denied
  },
  maxPerMerchant: {
    [MERCHANT_A]: 0.005,   // oracle
    [MERCHANT_B]: 0.02,    // risk
    [MERCHANT_C]: 0.01,    // hunter
  },
  maxTotal: 0.05,          // 5¢ session cap
  merchantAllowlist: [MERCHANT_A, MERCHANT_B, MERCHANT_C],
  timeWindow: 5 * 60_000,
  rateLimit: {
    liquidations: { max: 2, perMs: 60_000 },
  },
});
```

The `liquidations` per-call cap is deliberately tight: the default prompt asks for the top 5 troves, which costs 0.0005 × 5 = 0.0025 MUSD — over the 0.002 cap. That's what makes policy fire visibly when you run the demo.

## Expected output

```
[tool] get_btc_price({})
  [paid] get_btc_price → tx 0xca055b…9baf     (0.0005 MUSD → Merchant A)
[tool] assess_trove_risk({"collateralBtc":0.5,"debtMusd":20000,"scenarios":[10,20,30]})
  [paid] assess_trove_risk → tx 0x285ebc…fb08  (0.0024 MUSD → Merchant B)
[tool] get_liquidation_queue({"limit":5})
  [denied] get_liquidation_queue — policy blocked:
           Payment creation aborted: per_call_cap_exceeded:
           {"endpoint":"liquidations","amountMusd":0.0025,"capMusd":0.002}

=== Summary ===
Paid tool calls:   2
Denied tool calls: 1
Policy spend:      0.0029 MUSD total
```

Two on-chain txs (Merchant A + Merchant B). **No tx for the denied call** — the policy aborted before permit2 signing, so there's nothing to submit. On-chain buyer-balance delta = 0.0029 MUSD exactly.

Claude sees the denial as a tool error and typically reports what it got from the approved tools, often suggesting a workaround within budget (e.g., retry with `limit=4` for a 0.002 MUSD cost).

## Server

The server is identical to Demo 2 — same three endpoints, same prices, same merchants. Copied into `src/server.ts` + `src/abi.ts` so this demo stands alone (no cross-app imports). If you're studying the policy, Demo 2's `apps/trove-advisor/README.md` explains the server side.

## Prerequisites

Same as Demo 2: Node 20+, pnpm, an Anthropic API key, a Mezo Testnet wallet with at least 0.003 MUSD, and a one-time permit2 approval on MUSD.

## Setup + run

```bash
cp .env.example .env
# Fill in CLIENT_PRIVATE_KEY and ANTHROPIC_API_KEY
pnpm install
```

Terminal 1 — server:
```bash
pnpm server        # boots on :4402
```

Terminal 2 — agent:
```bash
pnpm agent
```

## Verifying the demo

The "policy blocks before any MUSD moves" claim is what this demo lives or dies on. To verify independently:

1. Before the run, note the buyer's MUSD balance.
2. Run `pnpm agent`.
3. After the run, re-check the balance. The delta should be **exactly** the sum of the paid tools' amounts (0.0005 + 0.0024 = 0.0029 MUSD in the default scenario) — **not** 0.0054 (which is what you'd see if the denied call had also settled).
4. The two printed tx hashes should both resolve on `explorer.test.mezo.org` with MUSD Transfer logs pointing at Merchants A and B. There should be no third tx from the buyer for the denied call.

## Extending the policy

The policy is plain data — wire in more checks by adding them to `SpendPolicy.check`. Ideas that fit in the same pattern:

- Time-of-day windows (no agentic spending 00:00–06:00 UTC).
- Per-merchant velocity (slow down after spikes).
- Per-resource cost caps (e.g. no more than $0.01 per unique endpoint per session).
- External allowlist lookup (cache with TTL).
- Signature requirement (escalate to a human if projected total crosses a threshold).

All of these plug into the same single seam — `onBeforePaymentCreation`.

## Install from npm/yarn (not pnpm)

The `pnpm.overrides` block is pnpm-specific. For npm use `npm overrides`; for yarn use `resolutions`. Same tarball URL, same idea — force `@x402/evm` through the Mezo preview tarball.
