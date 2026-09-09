import { afterEach, describe, expect, it } from 'vitest';
import { plans } from './billing.js';

describe('plans', () => {
  afterEach(() => {
    delete process.env.TOJI_CHECKOUT_URL_ULTRA;
  });

  it('lists each tier once, cheapest first, with exactly one highlighted', () => {
    const ids = plans().map((p) => p.id);
    expect(ids).toEqual(['free', 'pro', 'max', 'ultra']);
    expect(plans().filter((p) => p.highlight)).toHaveLength(1);
  });

  it('opens each paid tier with what it inherits from the one below', () => {
    const byId = Object.fromEntries(plans().map((p) => [p.id, p]));
    expect(byId.pro.features).toContain('Everything in Free');
    expect(byId.max.features[0]).toBe('Everything in Pro');
    expect(byId.ultra.features[0]).toBe('Everything in Max');
  });

  it('prices free as free, the middle tiers monthly, and ultra by usage', () => {
    const byId = Object.fromEntries(plans().map((p) => [p.id, p]));
    expect(byId.free).toMatchObject({ pricing: 'free', priceUsd: 0 });
    expect(byId.pro).toMatchObject({ pricing: 'monthly', priceUsd: 20 });
    expect(byId.max).toMatchObject({ pricing: 'monthly', priceUsd: 60 });
    expect(byId.ultra).toMatchObject({ pricing: 'usage', wide: true });
  });

  it('is not for sale until a checkout link is configured', () => {
    expect(plans().find((p) => p.id === 'ultra')?.checkoutUrl).toBe('');
    process.env.TOJI_CHECKOUT_URL_ULTRA = ' https://buy.example/ultra ';
    expect(plans().find((p) => p.id === 'ultra')?.checkoutUrl).toBe('https://buy.example/ultra');
  });
});
