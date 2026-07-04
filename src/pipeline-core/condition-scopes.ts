import type { Condition } from './types.js';

export function conditionReadsAnyScope(cond: Condition, scopes: ReadonlySet<string>): boolean {
  switch (cond.op) {
    case 'counter.lt':
    case 'counter.gte':
      return scopes.has(cond.scope);
    case 'all':
    case 'any':
      return cond.of.some((item) => conditionReadsAnyScope(item, scopes));
    case 'not':
      return conditionReadsAnyScope(cond.cond, scopes);
    default:
      return false;
  }
}
