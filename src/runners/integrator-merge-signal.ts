// UNSTABLE/HAS_HOOKS: GitHub marks a PR mergeable even when non-required checks are unsettled.
// Required-check gating is handled upstream; this quirk is intentional for advisory-only scenarios.
export function mergeSignal(mergeStateStatus: string | undefined, mergeable: string | undefined): 'clean' | 'blocked' | 'unknown' {
  const ms = (mergeStateStatus ?? '').toUpperCase();
  const mg = (mergeable ?? '').toUpperCase();
  if (mg === 'CONFLICTING' || ms === 'DIRTY' || ms === 'BLOCKED' || ms === 'BEHIND') return 'blocked';
  if (mg === 'MERGEABLE' && (ms === 'CLEAN' || ms === 'UNSTABLE' || ms === 'HAS_HOOKS')) return 'clean';
  return 'unknown';
}
