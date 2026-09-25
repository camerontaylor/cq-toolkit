import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Known process entry points only. This guard cannot discover a new helper
 * that launches a process transitively; the inventory is a conscious review
 * list, not a complete dynamic process detector.
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

async function documentedProcessTestFiles(): Promise<string[]> {
  const docs = await readFile(join(REPOSITORY_ROOT, 'docs/test-performance-notes.md'), 'utf8');
  const section = docs.split('## Process-entry inventory')[1]?.split(/^## /m)[0] ?? '';
  const files = [...section.matchAll(/^- `([^`]+\.test\.ts)`$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  if (files.length === 0) throw new Error('Process-entry inventory section is empty');
  return files.sort();
}

describe('real-process inventory', () => {
  test('the documented process-backed test list matches the known entry points', async () => {
    expect(await processBackedTestFiles()).toEqual(await documentedProcessTestFiles());
  });
});
