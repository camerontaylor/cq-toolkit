// review-debt #186 (the cheap half): the two self-host automation workflows
// share ONE concurrency group. The review loop's fix pushes/replies and the
// merge dispatch's server-side merges mutate the same repository state, so
// they must serialize with each other — a review push racing a merge
// executor would invalidate the merge's head pin. This test pins:
//   1. both INSTANTIATED workflows (.github/workflows/self-*.yml) declare the
//      SAME `concurrency.group`;
//   2. both TEMPLATES (policy/templates/self-host/self-*.yml) declare the
//      same group, so a re-instantiation cannot drift back to per-workflow
//      groups;
//   3. `cancel-in-progress: false` on both sides — cancelling mid-loop could
//      strand half-dispatched replies, cancelling mid-merge a half-executed
//      plan, so a queued sibling WAITS.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INSTANTIATED = [
  join(ROOT, '.github/workflows/self-review-loop.yml'),
  join(ROOT, '.github/workflows/self-merge-prs.yml'),
];
const TEMPLATES = [
  join(ROOT, 'policy/templates/self-host/self-review-loop.yml'),
  join(ROOT, 'policy/templates/self-host/self-merge-prs.yml'),
];

/** The `concurrency:` block's `group` and `cancel-in-progress` values. */
function concurrencyOf(text: string): { group?: string; cancelInProgress?: string } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^concurrency:\s*$/.test(line));
  if (start < 0) return {};
  const out: { group?: string; cancelInProgress?: string } = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || /^\S/.test(line)) break; // dedented — block over
    const group = /^\s+group:\s*(\S+)\s*$/.exec(line);
    if (group?.[1] !== undefined) out.group = group[1];
    const cancel = /^\s+cancel-in-progress:\s*(\S+)\s*$/.exec(line);
    if (cancel?.[1] !== undefined) out.cancelInProgress = cancel[1];
  }
  return out;
}

describe('self-host workflows share ONE concurrency group (#186)', () => {
  it('the two instantiated workflows declare the same group and never cancel in progress', () => {
    const [review, merge] = INSTANTIATED.map((path) => concurrencyOf(readFileSync(path, 'utf8')));
    expect(review?.group).toBeDefined();
    expect(review?.group).toBe(merge?.group);
    expect(review?.cancelInProgress).toBe('false');
    expect(merge?.cancelInProgress).toBe('false');
  });

  it('the two templates agree with each other and with the instantiations (no re-instantiation drift)', () => {
    const templateGroups = TEMPLATES.map((path) => concurrencyOf(readFileSync(path, 'utf8')));
    expect(templateGroups[0]?.group).toBeDefined();
    expect(templateGroups[0]?.group).toBe(templateGroups[1]?.group);
    expect(templateGroups[0]?.group).toBe(
      concurrencyOf(readFileSync(INSTANTIATED[0] as string, 'utf8')).group,
    );
  });
});
