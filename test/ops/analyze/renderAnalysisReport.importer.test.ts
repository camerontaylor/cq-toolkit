// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus renderAnalysisReport.helpers.ts (shared fixtures, no tests).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { pathAnalysisFileStore } from '../../../src/ops/analyze/analysisStore.js';
import {
  markdownFileName,
  parseAnalysisSidecar,
  reportFingerprint,
  serializeAnalysisSidecar,
  sidecarFileName,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import { registry } from '../../../src/ops/analyze/registry.js';
import type { RenderedAnalysisPaths } from '../../../src/ops/analyze/renderAnalysisReport.js';
import { fixtureReport } from './renderAnalysisReport.helpers.js';

afterEach(async () => {
  if (scratchDir !== '') {
    await rm(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
});
let scratchDir = '';

describe('the render op importer resolves end-to-end (real fs over a mkdtemp dir)', () => {
  test('the registry-bound default writes the pair into dir with content-derived names', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'analyze-render-'));
    await mkdir(join(scratchDir, 'src'), { recursive: true });
    await writeFile(join(scratchDir, 'src', 'a.ts'), 'const x = 1;\nexport { x };\n', 'utf8');
    await writeFile(
      join(scratchDir, 'src', 'b.ts'),
      'export const y = 2;\nexport { y };\n',
      'utf8',
    );
    const entry = registry.find((candidate) => candidate.name === 'analyze.renderAnalysisReport');
    if (!entry) throw new Error('analyze.renderAnalysisReport missing from the registry');
    const op = await entry.importer();
    const result = await op({ report: fixtureReport(), dir: scratchDir });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // The importer's op is erased to Op<unknown, unknown> — pin the shape.
    const value = result.value as RenderedAnalysisPaths;
    const fp = reportFingerprint(fixtureReport());
    expect(value).toEqual({
      markdownPath: join(scratchDir, markdownFileName(fp)),
      sidecarPath: join(scratchDir, sidecarFileName(fp)),
      reportFingerprint: fp,
    });
    const sidecarText = await readFile(value.sidecarPath, 'utf8');
    expect(sidecarText).toBe(serializeAnalysisSidecar(parseAnalysisSidecar(sidecarText)));
    const markdown = await readFile(value.markdownPath, 'utf8');
    expect(markdown).toContain('# Analysis report');
    // Exactly the two files landed — no temp litter, no extra tree.
    expect((await stat(scratchDir)).isDirectory()).toBe(true);
    await expect(stat(join(scratchDir, 'analysis-00000000.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('a missing dir fails through the registry-bound path store too', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'analyze-render-'));
    const entry = registry.find((candidate) => candidate.name === 'analyze.renderAnalysisReport');
    if (!entry) throw new Error('analyze.renderAnalysisReport missing from the registry');
    const op = await entry.importer();
    const result = await op({ report: fixtureReport(), dir: join(scratchDir, 'missing') });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not exist');
    }
  });

  test('the real store refuses to read a target that escapes the root (containment at the seam)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'analyze-render-'));
    // An EXISTING file outside the root: the escape must be caught by the
    // strict-descendant check (not merely by the missing-file ENOENT).
    const outside = join(scratchDir, '..', 'analyze-render-outside.ts');
    await writeFile(outside, 'secrets\n', 'utf8');
    const store = pathAnalysisFileStore(scratchDir);
    await expect(store.readBytes('../analyze-render-outside.ts')).rejects.toThrow(
      /strict descendant/,
    );
    await rm(outside, { force: true });
  });
});
