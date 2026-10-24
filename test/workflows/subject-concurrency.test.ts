// CI repair 2026-10-24: a merge-queue push is a promotion subject, and the
// gate reads cq/ratchet for EACH ordinary subject it selects. With the
// measurement workflows grouped by ref and `cancel-in-progress: true`, the
// next merge-queue push cancelled the previous subject's `ratchet` and
// `cq-measure` runs; cq-verify then posted "the measurement run concluded
// 'cancelled'" as a failure verdict and the gate refused that subject
// (84db7b45, runs 40043691034 / 40043691023). This test pins, in both the
// templates and their instantiations:
//   1. a merge-queue push run is keyed by its SHA, so no later push shares
//      (and cancels) its group;
//   2. every other run still groups by event + ref, so superseded PR heads
//      keep cancelling as before.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = ['ratchet', 'cq-measure'] as const;
const PATHS = WORKFLOWS.flatMap((name) => [
  [name, join(ROOT, `policy/templates/${name}.yml`)] as const,
  [name, join(ROOT, `.github/workflows/${name}.yml`)] as const,
]);

/** The workflow-level `concurrency:` block's `group` value. */
function groupOf(text: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^concurrency:\s*$/.test(line));
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) break;
    const group = /^\s+group:\s*(.+?)\s*$/.exec(line);
    if (group?.[1] !== undefined) return group[1];
  }
  return undefined;
}

describe('merge-queue subject measurements are never superseded', () => {
  it.each(PATHS)('%s (%s): a merge-queue push run is keyed by its SHA', (name, path) => {
    expect(groupOf(readFileSync(path, 'utf8'))).toBe(
      `${name}-\${{ github.event_name }}-\${{ github.ref }}` +
        "${{ github.event_name == 'push' && github.ref == 'refs/heads/merge-queue' " +
        "&& format('-{0}', github.sha) || '' }}",
    );
  });
});
