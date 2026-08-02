import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_PRICE,
  estimateWeeklyValue,
  formatUsd,
  modelPriceFor,
  usageCostUsd,
} from '#/utils/usage/model-prices';

describe('modelPriceFor', () => {
  it('matches model ids by substring, most specific first', () => {
    expect(modelPriceFor('kimi-k2.7-code').input).toBe(0.95);
    expect(modelPriceFor('kimi-k2.7-code-highspeed').output).toBe(8.0);
    expect(modelPriceFor('kimi-k2.6').input).toBe(0.95);
    expect(modelPriceFor('kimi-k3').output).toBe(15.0);
  });

  it('matches provider-qualified aliases on the model segment', () => {
    expect(modelPriceFor('kimi-code/k3-256k')).toEqual({
      input: 3.0,
      output: 15.0,
      cacheRead: 0.3,
      cacheCreation: 3.0,
    });
    expect(modelPriceFor('kimi-code/k3').output).toBe(15.0);
    expect(modelPriceFor('kimi-code/kimi-for-coding').input).toBe(0.95);
    expect(modelPriceFor('kimi-code/kimi-for-coding-highspeed').output).toBe(8.0);
  });

  it('does not let the provider prefix produce a false hit', () => {
    expect(modelPriceFor('k3-relay/some-future-model')).toBe(DEFAULT_MODEL_PRICE);
  });

  it('falls back to the default coding-model rate for unknown models', () => {
    expect(modelPriceFor('some-future-model')).toBe(DEFAULT_MODEL_PRICE);
  });
});

describe('usageCostUsd', () => {
  it('prices each token class at its own rate', () => {
    const usd = usageCostUsd(
      { inputOther: 1_000_000, output: 1_000_000, inputCacheRead: 1_000_000, inputCacheCreation: 1_000_000 },
      { input: 1, output: 2, cacheRead: 0.5, cacheCreation: 1 },
    );
    expect(usd).toBeCloseTo(4.5);
  });
});

describe('estimateWeeklyValue', () => {
  it('folds per-model usage into a total and token sums', () => {
    const estimate = estimateWeeklyValue({
      'kimi-k2.6': {
        inputOther: 1_000_000,
        output: 500_000,
        inputCacheRead: 2_000_000,
        inputCacheCreation: 0,
      },
    });
    // 1M × $0.95 + 0.5M × $4.00 + 2M × $0.15 = 0.95 + 2.00 + 0.30
    expect(estimate.totalUsd).toBeCloseTo(3.25);
    expect(estimate.inputTokens).toBe(1_000_000);
    expect(estimate.outputTokens).toBe(500_000);
    expect(estimate.cacheReadTokens).toBe(2_000_000);
  });

  it('returns zeros for an empty aggregate', () => {
    expect(estimateWeeklyValue({})).toEqual({
      totalUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it('prices resolved aliases (e.g. __secondary__) at the target model rate', () => {
    const usage = {
      inputOther: 0,
      output: 1_000_000,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };
    const estimate = estimateWeeklyValue(
      { __secondary__: usage, 'kimi-code/k3-256k': usage },
      (model) => (model === '__secondary__' ? 'kimi-for-coding' : model),
    );
    // __secondary__ → kimi-for-coding ($4.00/M output) + k3-256k ($15.00/M output)
    expect(estimate.totalUsd).toBeCloseTo(19.0);
    expect(estimate.outputTokens).toBe(2_000_000);
  });
});

describe('formatUsd', () => {
  it('keeps two decimals for amounts ≥ $1 and three for small ones', () => {
    expect(formatUsd(12.34)).toBe('$12.34');
    expect(formatUsd(1)).toBe('$1.00');
    expect(formatUsd(0.0123)).toBe('$0.012');
  });
});
