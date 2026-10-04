import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Known process entry points only. This guard cannot discover a new helper
 * that launches a process transitively; it is a source-derived cross-check
 * of the hand-maintained test/suite-classes.json, not a complete dynamic
 * process detector.
 */
const PROCESS_ENTRY_POINTS = [
  /^import(?!\s+type\b)[^;]*from ['"](node:)?child_process['"]/m,
  /\bspawnAcpProcess\s*\(/,
  /\bspawnManaged\s*\(/,
  /\bmakeSubprocessWorktreeEffects\s*\(/,
  /\bgenerateScratchRepo\s*\(/,
  /\bcreateGitTemplate\s*\(/,
  /\brunSweepPlan\s*\(/,
] as const;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function processBackedTestFiles(): Promise<string[]> {
  const root = join(REPOSITORY_ROOT, 'test');
  const entries = await readdir(root, { recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.test.ts')) continue;
    const path = join(root, entry);
    const source = await readFile(path, 'utf8');
    if (PROCESS_ENTRY_POINTS.some((pattern) => pattern.test(source))) {
      files.push(relative(REPOSITORY_ROOT, path).replaceAll('\\', '/'));
    }
  }
  return files.sort();
}

async function suiteClasses(): Promise<Record<string, string>> {
  const manifest = await readFile(join(REPOSITORY_ROOT, 'test/suite-classes.json'), 'utf8');
  return JSON.parse(manifest) as Record<string, string>;
}

describe('real-process inventory', () => {
  test('the entry-point scan still finds the known process-backed suites', async () => {
    // A scan that silently matched nothing would make the check below vacuous.
    expect(await processBackedTestFiles()).toEqual(
      expect.arrayContaining(['test/driver/subprocess.test.ts', 'test/ops/ratchet/git.test.ts']),
    );
  });

  test('no file that reaches a process entry point is classified pure', async () => {
    // Unlisted files default to `process` in vitest.config.ts, so only an
    // explicit `pure` entry can put a process-backed file under pure budgets.
    const classes = await suiteClasses();
    const misclassified = (await processBackedTestFiles()).filter(
      (file) => classes[file] === 'pure',
    );
    expect(misclassified).toEqual([]);
  });
});
