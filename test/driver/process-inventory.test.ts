import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Known process entry points only. This guard cannot discover a new helper
 * that launches a process transitively; the inventory is a conscious review
 * list, not a complete dynamic process detector.
 */
const PROCESS_ENTRY_POINTS = [
  /from ['"]node:child_process['"]/,
  /from ['"]child_process['"]/,
  /\bspawnAcpProcess\s*\(/,
  /\bspawnManaged\s*\(/,
  /\bmakeSubprocessWorktreeEffects\s*\(/,
  /\bgenerateScratchRepo\s*\(/,
  /\bcreateGitTemplate\s*\(/,
  /\brunSweepPlan\s*\(/,
] as const;

/** Process-backed test files. Keep this list synchronized deliberately. */
const COMMITTED_PROCESS_TEST_FILES = [
  'test/cli/i1.test.ts',
  'test/driver/acp.test.ts',
  'test/driver/subprocess.test.ts',
  'test/e2e/analyze/analyze.e2e.test.ts',
  'test/e2e/merge/live.test.ts',
  'test/e2e/sweep/sweep.e2e.test.ts',
  'test/helpers/git-template.test.ts',
  'test/ops/ratchet/captureBaseline.test.ts',
  'test/ops/ratchet/monotonicGuard.test.ts',
  'test/ops/review/registry.test.ts',
  'test/ops/sweep/cleanup.test.ts',
  'test/ops/sweep/ledger-suppression.test.ts',
  'test/ops/sweep/unit-registry.test.ts',
  'test/ops/sweep/worktreeFor.test.ts',
  'test/scripts/demo-eval-axes.test.ts',
  'test/scripts/knip.test.ts',
  'test/scripts/oxlint-boundaries.test.ts',
  'test/scripts/ratchet-baseline.test.ts',
  'test/scripts/static-conformance.test.ts',
  'test/scripts/tooling-commands.test.ts',
  'test/workflows/merge-queue-gate.test.ts',
] as const;

async function processBackedTestFiles(): Promise<string[]> {
  const root = join(process.cwd(), 'test');
  const entries = await readdir(root, { recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.test.ts')) continue;
    const path = join(root, entry);
    const source = await readFile(path, 'utf8');
    if (PROCESS_ENTRY_POINTS.some((pattern) => pattern.test(source))) {
      files.push(relative(process.cwd(), path).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

describe('real-process inventory', () => {
  test('the committed process-backed test list matches the known entry points', async () => {
    expect(await processBackedTestFiles()).toEqual([...COMMITTED_PROCESS_TEST_FILES].sort());
  });
});
