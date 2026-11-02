import type { WorkCorrelation } from './types.js';

/**
 * Session-log correlation (preservation plan items 1.3–1.5): the invocation
 * fragment carrying the governed job's work identity, or `{}` when the
 * caller has no governed correlation (exactOptionalPropertyTypes-safe
 * spread). Pure over its argument — the KERNEL reads the job context, the
 * DRIVER module never imports src/kernel (ADR-0002 one-directional rule).
 * The `role` falls back to `'fixer'` only when absent (the original
 * fixReviewItem default, preserved).
 */
export function correlationInvocation(correlation: WorkCorrelation | undefined): {
  correlation?: WorkCorrelation;
} {
  if (correlation === undefined) return {};
  return { correlation: { ...correlation, role: correlation.role ?? 'fixer' } };
}
