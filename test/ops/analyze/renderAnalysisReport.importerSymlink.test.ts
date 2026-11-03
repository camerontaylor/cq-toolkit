// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus renderAnalysisReport.helpers.ts (shared fixtures, no tests).
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { pathAnalysisFileStore } from '../../../src/ops/analyze/analysisStore.js';
import {
  reportFingerprint,
  sidecarFileName,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import { registry } from '../../../src/ops/analyze/registry.js';
import { fixtureReport } from './renderAnalysisReport.helpers.js';

afterEach(async () => {
  if (scratchDir !== '') {
    await rm(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
});
let scratchDir = '';

describe('the render op importer resolves end-to-end (real fs over a mkdtemp dir)', () => {
  test('a pre-planted LEAF SYMLINK at the write target is refused, the link target untouched (M1)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'analyze-render-'));
    // The attack: a PR author plants a symlink at the deterministic output
    // name BEFORE the render op runs; writeFileSync would follow it outside
    // the root. The store must lstat the exact write target and refuse.
    const sentinelPath = join(scratchDir, '..', 'analyze-render-sentinel.md');
    await writeFile(sentinelPath, 'sentinel bytes\n', 'utf8');
    scratchDir = await mkdtemp(join(tmpdir(), 'analyze-render-leaf-'));
    const planted = join(scratchDir, 'analysis-00000000.md');
    await symlink(sentinelPath, planted);
    const store = pathAnalysisFileStore(scratchDir);
    await expect(store.writeBytes('analysis-00000000.md', Buffer.from('owned\n'))).rejects.toThrow(
      /symlink at the write target/,
    );
    // The link target is untouched and the link itself still stands.
    expect(await readFile(sentinelPath, 'utf8')).toBe('sentinel bytes\n');
    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
    await rm(sentinelPath, { force: true });
  });

  test('the render op fails closed when a leaf symlink sits at a deterministic OUTPUT name (M1, op level)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'analyze-render-'));
    await mkdir(join(scratchDir, 'src'), { recursive: true });
    await writeFile(join(scratchDir, 'src', 'a.ts'), 'const x = 1;\nexport { x };\n', 'utf8');
    await writeFile(
      join(scratchDir, 'src', 'b.ts'),
      'export const y = 2;\nexport { y };\n',
      'utf8',
    );
    const fp = reportFingerprint(fixtureReport());
    const sentinelPath = join(scratchDir, '..', 'analyze-render-op-sentinel.json');
    await writeFile(sentinelPath, 'sentinel\n', 'utf8');
    // Planted at the FIRST write (the sidecar), so the op faults before any
    // byte lands anywhere.
    await symlink(sentinelPath, join(scratchDir, sidecarFileName(fp)));
    const entry = registry.find((candidate) => candidate.name === 'analyze.renderAnalysisReport');
    if (!entry) throw new Error('analyze.renderAnalysisReport missing from the registry');
    const op = await entry.importer();
    const result = await op({ report: fixtureReport(), dir: scratchDir });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('symlink at the write target');
    }
    // The planted link's target is untouched.
    expect(await readFile(sentinelPath, 'utf8')).toBe('sentinel\n');
    await rm(sentinelPath, { force: true });
  });
});
