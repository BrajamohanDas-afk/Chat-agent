import { describe, expect, it } from 'vitest';
import { compareLimit, comparePrices, type PriceValue } from '../src/domain/pricing.js';

const BASE: PriceValue = {
  kind: 'price',
  amount: 20,
  currency: 'USD',
  period: 'month',
  mode: 'per_user',
  unit: 'user',
  plan: 'Pro',
  region: null,
  conditions: [],
};

const price = (overrides: Partial<PriceValue> = {}): PriceValue => ({ ...BASE, ...overrides });

describe('comparePrices', () => {
  it('reports identical prices as unchanged', () => {
    const result = comparePrices(price(), price({ plan: ' pro ' }));

    expect(result.verdict).toBe('unchanged');
    expect(result.reasons).toEqual(['no_material_change']);
    expect(result.fields).toEqual([]);
  });

  it('treats a different unit as a change even when the amount is the same', () => {
    const result = comparePrices(
      price(),
      price({ mode: 'per_workspace', unit: 'workspace' }),
    );

    expect(result.verdict).toBe('changed');
    expect(result.reasons).toContain('unit_changed');
    expect(result.fields).toContainEqual({ field: 'unit', before: 'user', after: 'workspace' });
  });

  it('treats user and seat as the same billing unit', () => {
    const result = comparePrices(price(), price({ unit: 'seat' }));

    expect(result.verdict).toBe('unchanged');
    expect(result.reasons).toEqual(['no_material_change']);
  });

  it('treats a different billing mode as a change even when the amount is the same', () => {
    const result = comparePrices(price(), price({ mode: 'flat' }));

    expect(result.verdict).toBe('changed');
    expect(result.reasons).toEqual(['billing_mode_changed']);
  });

  it('treats billed-annually conditions as a conditions change', () => {
    const result = comparePrices(
      price({ amount: 25 }),
      price({ amount: 25, conditions: ['billed annually'] }),
    );

    expect(result.verdict).toBe('changed');
    expect(result.reasons).toEqual(['conditions_changed']);
    expect(result.fields).toContainEqual({
      field: 'conditions',
      before: [],
      after: ['billed annually'],
    });
  });

  it('reports a price increase', () => {
    const result = comparePrices(price(), price({ amount: 29 }));

    expect(result.verdict).toBe('changed');
    expect(result.reasons).toEqual(['price_increased']);
    expect(result.fields).toContainEqual({ field: 'amount', before: 20, after: 29 });
  });

  it('reports a price decrease', () => {
    const result = comparePrices(price(), price({ amount: 15 }));

    expect(result.verdict).toBe('changed');
    expect(result.reasons).toEqual(['price_decreased']);
  });

  it('reports a different billing period', () => {
    const result = comparePrices(price(), price({ period: 'year' }));

    expect(result.verdict).toBe('changed');
    expect(result.reasons).toContain('billing_period_changed');
    expect(result.fields).toContainEqual({ field: 'period', before: 'month', after: 'year' });
  });

  it('is unclear when the plan changed', () => {
    const result = comparePrices(price(), price({ plan: 'Business' }));

    expect(result.verdict).toBe('unclear');
    expect(result.reasons).toEqual(['plan_changed']);
  });

  it('is unclear when a required field is missing', () => {
    for (const missing of [price({ plan: '' }), price({ unit: '' })]) {
      const result = comparePrices(price(), missing);
      expect(result.verdict).toBe('unclear');
      expect(result.reasons).toEqual(['insufficient_evidence']);
      expect(result.fields).toEqual([]);
    }
  });

  it('is unclear when the currency changed', () => {
    const result = comparePrices(price(), price({ currency: 'EUR' }));

    expect(result.verdict).toBe('unclear');
    expect(result.reasons).toContain('currency_changed');
    expect(result.fields).toContainEqual({ field: 'currency', before: 'USD', after: 'EUR' });
  });

  it('is unclear when the region changed', () => {
    const result = comparePrices(price(), price({ region: 'EU' }));

    expect(result.verdict).toBe('unclear');
    expect(result.reasons).toEqual(['region_changed']);
    expect(result.fields).toContainEqual({ field: 'region', before: null, after: 'EU' });
  });
});

describe('compareLimit', () => {
  it('reports a changed included limit', () => {
    const result = compareLimit(100, 50, 'GB');

    expect(result.verdict).toBe('changed');
    expect(result.reasons).toEqual(['limit_changed']);
    expect(result.fields).toContainEqual({ field: 'limit:GB', before: 100, after: 50 });
  });

  it('reports an unchanged included limit', () => {
    const result = compareLimit(100, 100, 'GB');

    expect(result.verdict).toBe('unchanged');
    expect(result.reasons).toEqual(['no_material_change']);
    expect(result.fields).toEqual([]);
  });
});
