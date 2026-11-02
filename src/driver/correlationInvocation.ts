import type { WorkCorrelation } from './types.js';
import { currentJobContext } from '../kernel/governor.js';

/**
 * Session-log correlation (preservation plan items 1.3–1.5): the invocation
 * fragment carrying the governed job's work identity, or `{}` outside a
 * governed dispatch (exactOptionalPropertyTypes-safe spread). Extracted from
 * fixReviewItem so other ops can attach the same governed correlation;
 * default role behavior is preserved here (`role` falls back to `'fixer'`
 * only when absent).
 */
export function correlationInvocation(): { correlation?: WorkCorrelation } {
  const info = currentJobContext()?.info;
  const correlation = info?.correlation;
  if (correlation === undefined) return {};
  return { correlation: { ...correlation, role: correlation.role ?? 'fixer' } };
}
