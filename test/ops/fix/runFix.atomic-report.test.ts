// Split provenance: test/ops/fix/runFix.test.ts was split by subject into
// runFix.compare-links.test.ts, runFix.fixes-per-run.test.ts,
// runFix.composition-context.test.ts, runFix.composition-metrics.test.ts,
// runFix.pr-base.test.ts and runFix.atomic-report.test.ts (this file).
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { writeAtomicFixReport } from '../../../src/ops/fix/runFix.js';

test('atomic report replaces complete files and cleans up failed replacements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-atomic-report-'));
  try {
    const path = join(root, 'report.json');
    await writeFile(path, 'previous');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(writeAtomicFixReport(path, cyclic)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('previous');
    await writeAtomicFixReport(path, { complete: true });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ complete: true });
    const directory = join(root, 'blocked');
    await mkdir(directory);
    await writeFile(join(directory, 'previous'), 'preserved');
    await expect(writeAtomicFixReport(directory, {})).rejects.toThrow();
    expect(await readFile(join(directory, 'previous'), 'utf8')).toBe('preserved');
    expect((await readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
