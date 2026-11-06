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
  // Short names tolerate fewer edits, otherwise "x" would match any 3-letter key.
  const limit = Math.min(MAX_SUGGESTION_DISTANCE, Math.max(1, Math.floor(unknown.length / 2)));
  let bestDistance = limit + 1;
  for (const candidate of valid) {
    const distance = editDistance(unknown.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
