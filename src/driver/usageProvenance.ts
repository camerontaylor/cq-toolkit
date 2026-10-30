import type { WorkerResult } from './types.js';

/**
 * The three usage-provenance states a consumer must distinguish. `'unknown'`
 * exists only here: it is what an ABSENT declaration means, it is never
 * persisted, and it is never derived from the token values.
 */
export type UsageProvenance = 'measured' | 'unmeasured' | 'unknown';

/**
 * Read a result's declared usage provenance (seam v3).
 *
 * A missing declaration is `'unknown'` — a legacy/custom result that did not
 * report provenance, or a lane that cannot observe it. Callers must treat
 * `'unknown'` like a placeholder for accounting: it never contributes an
 * aggregate measurement. Only an explicit `'measured'` counts.
 */
export function usageProvenanceOf(result: Pick<WorkerResult, 'usageProvenance'>): UsageProvenance {
  return result.usageProvenance ?? 'unknown';
}
