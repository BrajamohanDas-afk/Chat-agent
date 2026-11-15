export type PriceValue = {
  kind: 'price';
  amount: number;
  currency: string;
  period: 'month' | 'year' | 'one_time';
  mode: 'flat' | 'per_user' | 'per_workspace';
  unit: string;
  plan: string;
  region: string | null;
  conditions: string[];
};

export type ChangeReason =
  | 'price_increased'
  | 'price_decreased'
  | 'billing_period_changed'
  | 'billing_mode_changed'
  | 'conditions_changed'
  | 'unit_changed'
  | 'plan_changed'
  | 'region_changed'
  | 'currency_changed'
  | 'limit_changed'
  | 'feature_added'
  | 'feature_removed'
  | 'discontinued'
  | 'no_material_change'
  | 'insufficient_evidence';

export type FieldDiff = { field: string; before: unknown; after: unknown };

export type PriceComparison = {
  verdict: 'changed' | 'unchanged' | 'unclear';
  reasons: ChangeReason[];
  fields: FieldDiff[];
};

const REQUIRED = ['plan', 'unit', 'period', 'currency'] as const;
const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** "Starter Customer Platform" and "Starter" are the same plan. */
export function planKey(value: string): string {
  return norm(value)
    .replace(/\b(customer platform|crm|software|plan|edition)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "user" and "seat" are the same billing unit. */
const unitKey = (value: string): string => {
  const key = norm(value);
  return key === 'user' || key === 'seat' ? 'seat' : key;
};

const sameConditions = (before: string[], after: string[]): boolean =>
  JSON.stringify(before.map(norm).sort()) === JSON.stringify(after.map(norm).sort());

export function comparePrices(before: PriceValue, after: PriceValue): PriceComparison {
  const missing = REQUIRED.filter((key) => !before[key] || !after[key]);
  if (missing.length > 0) {
    return { verdict: 'unclear', reasons: ['insufficient_evidence'], fields: [] };
  }

  const reasons: ChangeReason[] = [];
  const fields: FieldDiff[] = [];
  const diff = (field: string, a: unknown, b: unknown) => {
    if (a !== b) fields.push({ field, before: a, after: b });
  };
  const conditionsChanged = !sameConditions(before.conditions, after.conditions);

  if (planKey(before.plan) !== planKey(after.plan)) reasons.push('plan_changed');
  if (norm(before.region ?? '') !== norm(after.region ?? '')) reasons.push('region_changed');
  if (before.currency.toUpperCase() !== after.currency.toUpperCase()) {
    reasons.push('currency_changed');
  }
  if (before.period !== after.period) reasons.push('billing_period_changed');
  if (before.mode !== after.mode) reasons.push('billing_mode_changed');
  if (unitKey(before.unit) !== unitKey(after.unit)) reasons.push('unit_changed');
  if (conditionsChanged) reasons.push('conditions_changed');
  if (before.amount !== after.amount) {
    reasons.push(after.amount > before.amount ? 'price_increased' : 'price_decreased');
  }

  diff('amount', before.amount, after.amount);
  diff('plan', before.plan, after.plan);
  diff('unit', before.unit, after.unit);
  diff('period', before.period, after.period);
  diff('mode', before.mode, after.mode);
  diff('currency', before.currency, after.currency);
  diff('region', before.region, after.region);
  if (conditionsChanged) {
    fields.push({ field: 'conditions', before: before.conditions, after: after.conditions });
  }

  if (reasons.length === 0) {
    return { verdict: 'unchanged', reasons: ['no_material_change'], fields: [] };
  }
  if (
    reasons.includes('plan_changed') ||
    reasons.includes('region_changed') ||
    reasons.includes('currency_changed')
  ) {
    return { verdict: 'unclear', reasons, fields };
  }
  return { verdict: 'changed', reasons, fields };
}

export function compareLimit(before: number, after: number, unit: string): PriceComparison {
  if (before === after) {
    return { verdict: 'unchanged', reasons: ['no_material_change'], fields: [] };
  }
  return {
    verdict: 'changed',
    reasons: ['limit_changed'],
    fields: [{ field: `limit:${unit}`, before, after }],
  };
}
