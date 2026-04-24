/**
 * Spend policy + onBeforePaymentCreation hook for the trove-mandate demo.
 *
 * Every x402 payment the client is about to sign funnels through a single
 * entry point (`checkPayment`). The policy object is plain data — no cron,
 * no external service, no on-chain call. The rules are:
 *
 *   1. Merchant allowlist           — hard reject if payTo is unknown
 *   2. Per-call cap (by endpoint)    — reject if this single call's amount > cap
 *   3. Per-merchant running cap      — reject if cumulative spend for this
 *                                       merchant would exceed the merchant's cap
 *   4. Total session cap             — reject if cumulative spend across all
 *                                       merchants would exceed the session cap
 *   5. Rate limit (by endpoint)      — sliding window: reject if the endpoint
 *                                       has been called too many times recently
 *   6. Time window                   — session cap only counts payments inside
 *                                       the first window-duration from the first
 *                                       approved payment
 *
 * Errors are thrown as PolicyDenied and surfaced to the agent's tool handler,
 * which returns the denial to Claude as a tool error so the model can reason
 * about why the budget refused and continue with remaining tools.
 */

import type { BeforePaymentCreationHook } from "@x402/core/client";

export type EndpointKey = "oracle" | "risk" | "liquidations";

export interface PolicyConfig {
  /** Max MUSD per single call, by endpoint. Missing endpoint = unlimited. */
  maxPerCall: Partial<Record<EndpointKey, number>>;
  /** Max MUSD cumulative per merchant address (lowercased). */
  maxPerMerchant: Record<string, number>;
  /** Max MUSD cumulative across all merchants in the session. */
  maxTotal: number;
  /** Merchant addresses the agent is allowed to pay (lowercased). */
  merchantAllowlist: string[];
  /** Rolling session window (ms) — session counters reset if the window closes. */
  timeWindow: number;
  /** Rate limits per endpoint: max calls per `perMs` milliseconds. */
  rateLimit?: Partial<Record<EndpointKey, { max: number; perMs: number }>>;
}

export class PolicyDenied extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: Record<string, unknown>,
  ) {
    super(`${code}: ${JSON.stringify(detail)}`);
    this.name = "PolicyDenied";
  }
}

interface Spend {
  /** Cumulative spend in MUSD wei (as BigInt) per merchant. */
  perMerchant: Map<string, bigint>;
  /** Cumulative spend in MUSD wei across all merchants. */
  total: bigint;
  /** Per-endpoint timestamps of approved calls, for rate limiting. */
  timestamps: Map<EndpointKey, number[]>;
  /** ms timestamp of the first approved call — anchors the timeWindow. */
  sessionStart: number | null;
}

export class SpendPolicy {
  private readonly config: PolicyConfig;
  private readonly spend: Spend = {
    perMerchant: new Map(),
    total: 0n,
    timestamps: new Map(),
    sessionStart: null,
  };

  constructor(config: PolicyConfig) {
    this.config = {
      ...config,
      merchantAllowlist: config.merchantAllowlist.map(a => a.toLowerCase()),
      maxPerMerchant: Object.fromEntries(
        Object.entries(config.maxPerMerchant).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
  }

  /** @returns a BeforePaymentCreationHook wired to this policy instance. */
  asHook(): BeforePaymentCreationHook {
    return async context => {
      const endpoint = endpointFromUrl(context.paymentRequired.resource?.url);
      const req = context.selectedRequirements;
      const amountWei = BigInt(req.amount ?? "0");
      const payTo = req.payTo.toLowerCase();
      try {
        this.check(endpoint, payTo, amountWei);
      } catch (err) {
        if (err instanceof PolicyDenied) {
          // Return abort directive per BeforePaymentCreationHook contract.
          return { abort: true as const, reason: err.message };
        }
        throw err;
      }
      return undefined;
    };
  }

  /** Explicit check — useful for the agent tool wrapper to surface denials as structured tool errors. */
  check(endpoint: EndpointKey | null, payTo: string, amountWei: bigint): void {
    const now = Date.now();
    const amountMusd = Number(amountWei) / 1e18;

    // 1. Merchant allowlist
    if (!this.config.merchantAllowlist.includes(payTo)) {
      throw new PolicyDenied("merchant_not_allowed", {
        payTo,
        allowlist: this.config.merchantAllowlist,
      });
    }

    // 2. Per-call cap (per endpoint)
    if (endpoint && this.config.maxPerCall[endpoint] !== undefined) {
      const cap = this.config.maxPerCall[endpoint]!;
      if (amountMusd > cap + 1e-12) {
        throw new PolicyDenied("per_call_cap_exceeded", {
          endpoint,
          amountMusd,
          capMusd: cap,
        });
      }
    }

    // Window refresh: if the session has been idle longer than timeWindow,
    // reset counters so the cap is per-window not per-process.
    if (
      this.spend.sessionStart !== null &&
      now - this.spend.sessionStart > this.config.timeWindow
    ) {
      this.spend.perMerchant.clear();
      this.spend.total = 0n;
      this.spend.timestamps.clear();
      this.spend.sessionStart = null;
    }

    // 3. Per-merchant cumulative cap
    const prevMerchant = this.spend.perMerchant.get(payTo) ?? 0n;
    const projectedMerchant = prevMerchant + amountWei;
    const merchantCap = this.config.maxPerMerchant[payTo];
    if (merchantCap !== undefined) {
      const projectedMusd = Number(projectedMerchant) / 1e18;
      if (projectedMusd > merchantCap + 1e-12) {
        throw new PolicyDenied("merchant_cap_exceeded", {
          payTo,
          projectedMusd,
          capMusd: merchantCap,
        });
      }
    }

    // 4. Total session cap
    const projectedTotal = this.spend.total + amountWei;
    const projectedTotalMusd = Number(projectedTotal) / 1e18;
    if (projectedTotalMusd > this.config.maxTotal + 1e-12) {
      throw new PolicyDenied("session_cap_exceeded", {
        projectedMusd: projectedTotalMusd,
        capMusd: this.config.maxTotal,
      });
    }

    // 5. Rate limit (per endpoint, sliding window)
    if (endpoint && this.config.rateLimit?.[endpoint]) {
      const { max, perMs } = this.config.rateLimit[endpoint]!;
      const existing = (this.spend.timestamps.get(endpoint) ?? []).filter(
        t => now - t <= perMs,
      );
      if (existing.length >= max) {
        throw new PolicyDenied("rate_limit_exceeded", {
          endpoint,
          max,
          perMs,
          current: existing.length,
        });
      }
    }

    // All checks passed — commit the spend intent.
    this.spend.perMerchant.set(payTo, projectedMerchant);
    this.spend.total = projectedTotal;
    if (endpoint) {
      const ts = this.spend.timestamps.get(endpoint) ?? [];
      ts.push(now);
      this.spend.timestamps.set(endpoint, ts);
    }
    if (this.spend.sessionStart === null) {
      this.spend.sessionStart = now;
    }
  }

  summary(): { totalMusd: number; perMerchant: Record<string, number> } {
    const perMerchant: Record<string, number> = {};
    for (const [k, v] of this.spend.perMerchant.entries()) {
      perMerchant[k] = Number(v) / 1e18;
    }
    return { totalMusd: Number(this.spend.total) / 1e18, perMerchant };
  }
}

/**
 * Infer the endpoint key from the resource URL on PaymentRequired.
 * Returns null if the URL doesn't match a known endpoint — which will
 * make per-call / rate-limit checks fall through to "no limit" for that
 * specific rule while still applying allowlist, merchant, and total caps.
 */
export function endpointFromUrl(url?: string): EndpointKey | null {
  if (!url) return null;
  try {
    const { pathname } = new URL(url);
    if (pathname.startsWith("/oracle/")) return "oracle";
    if (pathname.startsWith("/risk/")) return "risk";
    if (pathname.startsWith("/liquidations/")) return "liquidations";
  } catch {
    // fall through
  }
  return null;
}
