// Nearest-name suggestion ("did you mean") shared by cq.json and env diagnostics.
// Small local Levenshtein; no dependency.
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

const MAX_SUGGESTION_DISTANCE = 3;

export function nearestKey(unknown: string, valid: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  const typo = unknown.toLowerCase();
  for (const candidate of valid) {
    // The cap scales with the longer of the two names, so "hi" can reach
    // "high"; short-vs-short ("x" vs "run") still needs a near match.
    const limit = Math.min(
      MAX_SUGGESTION_DISTANCE,
      Math.max(1, Math.floor(Math.max(unknown.length, candidate.length) / 2)),
    );
    const distance = editDistance(typo, candidate.toLowerCase());
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
