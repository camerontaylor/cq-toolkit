/**
 * Shared Cq-* commit trailer formatting for sweep evidence commits
 * (measurement M6a). Both the verified task commit and the failed-attempt
 * commit render their trailer block through this one helper so the key set
 * stays aligned across the two evidence surfaces.
 */

/**
 * Render `Key: value` trailer lines. Keys and values containing embedded
 * newlines are rejected: a trailer is a single physical line by construction,
 * and a smuggled newline in either tuple field could forge subsequent
 * trailers.
 */
export function formatCqTrailers(entries: ReadonlyArray<readonly [string, string]>): string {
  for (const [key, value] of entries) {
    if (/[\r\n]/.test(key)) throw new Error('Cq trailer key contains an embedded newline');
    if (/[\r\n]/.test(value)) throw new Error(`Cq trailer ${key} contains an embedded newline`);
  }
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}
