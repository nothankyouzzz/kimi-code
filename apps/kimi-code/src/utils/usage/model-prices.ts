/**
 * Kimi API list prices (USD per 1M tokens) and the token-usage → cost
 * estimate behind the `/usage` weekly API-value line.
 *
 * Source: https://platform.moonshot.ai/docs/pricing/chat (2026-08).
 * Cache creation is billed at the regular cache-miss input rate. The table
 * is matched by substring against the model segment of the id (the part
 * after the last `/` — wire usage records the model alias, which for
 * managed models is provider-qualified, e.g. `kimi-code/k3-256k`); unknown
 * Kimi models fall back to the current coding-model rate so the estimate
 * never disappears mid-rotation. Keep this table in sync with the pricing
 * page — it is list price only, not what a subscription actually bills.
 */

import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

export interface ModelPrice {
  /** Cache-miss input, USD per 1M tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

interface ModelPriceEntry {
  /** Lowercase substring matched against the model segment of the id / alias. */
  readonly match: string;
  readonly price: ModelPrice;
}

const K2_CODE_PRICE: ModelPrice = {
  input: 0.95,
  output: 4.0,
  cacheRead: 0.15,
  cacheCreation: 0.95,
};

const K2_CODE_HIGHSPEED_PRICE: ModelPrice = {
  input: 1.15,
  output: 8.0,
  cacheRead: 0.15,
  cacheCreation: 1.15,
};

const K3_PRICE: ModelPrice = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.3,
  cacheCreation: 3.0,
};

const MODEL_PRICES: readonly ModelPriceEntry[] = [
  // Highspeed ids (`kimi-for-coding-highspeed`, `kimi-k2.7-code-highspeed`)
  // also contain the plainer coding-model markers below, so this entry must
  // stay first.
  { match: 'highspeed', price: K2_CODE_HIGHSPEED_PRICE },
  { match: 'k3', price: K3_PRICE },
  { match: 'for-coding', price: K2_CODE_PRICE },
  { match: 'k2', price: K2_CODE_PRICE },
];

/** Price used when no table entry matches (the current coding-model rate). */
export const DEFAULT_MODEL_PRICE: ModelPrice = K2_CODE_PRICE;

export function modelPriceFor(model: string): ModelPrice {
  const id = model.toLowerCase();
  // Match only the model segment after the last `/` so a provider prefix can
  // never produce a false hit.
  const segment = id.slice(id.lastIndexOf('/') + 1);
  for (const entry of MODEL_PRICES) {
    if (segment.includes(entry.match)) return entry.price;
  }
  return DEFAULT_MODEL_PRICE;
}

export function usageCostUsd(usage: TokenUsage, price: ModelPrice): number {
  return (
    (usage.inputOther * price.input +
      usage.output * price.output +
      usage.inputCacheRead * price.cacheRead +
      usage.inputCacheCreation * price.cacheCreation) /
    1_000_000
  );
}

export interface WeeklyValueEstimate {
  readonly totalUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * Fold a per-model usage aggregate into one USD estimate + token totals.
 * `resolveModelId` maps a recorded model id to the id used for pricing —
 * e.g. the synthesized `__secondary__` alias resolves to the configured
 * secondary (subagent) model's underlying id.
 */
export function estimateWeeklyValue(
  byModel: Record<string, TokenUsage>,
  resolveModelId?: (model: string) => string,
): WeeklyValueEstimate {
  let totalUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  for (const [model, usage] of Object.entries(byModel)) {
    totalUsd += usageCostUsd(usage, modelPriceFor(resolveModelId?.(model) ?? model));
    inputTokens += usage.inputOther + usage.inputCacheCreation;
    outputTokens += usage.output;
    cacheReadTokens += usage.inputCacheRead;
  }
  return { totalUsd, inputTokens, outputTokens, cacheReadTokens };
}

/** `$12.34` for amounts ≥ 1, `$0.012` for small ones — estimates stay honest. */
export function formatUsd(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}
