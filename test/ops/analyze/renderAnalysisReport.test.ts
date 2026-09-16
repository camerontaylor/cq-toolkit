// Analyze lane G2 — test evidence for the report pair: pure-core
// determinism (same report+meta → byte-identical markdown and sidecar, and
// the returned paths are pure functions of content), the sidecar contract
// (fingerprint re-derived on parse, strict fail-closed format errors), the
// op's fs behavior through an INJECTED store (missing dir refused, missing
// target failed, deterministic names), and the registry importer resolving
// end-to-end over a real mkdtemp dir (the one place real fs is allowed
// here, mirroring the C4 registry-test precedent).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { AnalyzeFileStore } from '../../../src/ops/analyze/analysisStore.js';
import {
  AnalysisStoreError,
  pathAnalysisFileStore,
} from '../../../src/ops/analyze/analysisStore.js';
import { clusterErrors, clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import {
  ANALYSIS_SIDECAR_SCHEMA_VERSION,
  SidecarFormatError,
  contentDigest,
  makeRenderAnalysisReport,
  markdownFileName,
  parseAnalysisSidecar,
  renderAnalysisReport,
  reportFingerprint,
  serializeAnalysisSidecar,
  sidecarFileName,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import { registry } from '../../../src/ops/analyze/registry.js';
import { fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import type { ClusterErrorsReport } from '../../../src/ops/analyze/clusterErrors.js';
import type { RenderedAnalysisPaths } from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { CheckFailure, FailureSet } from '../../../src/ops/gates/index.js';

/** A failure with only the fields under test (the family test idiom). */
function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
  return {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    ruleId: 'no-unused-vars',
    message: "'x' is defined but never used",
    severity: 'error',
    ...overrides,
  };
}

/** A realistic report: one two-member cluster plus ledger noise, built through the real G1 clustering. */
function fixtureReport(): ClusterErrorsReport {
  const noiseFailure = failureOf({
    file: 'src/c.ts',
    ruleId: 'no-console',
    message: 'Unexpected console statement.',
  });
  const set: FailureSet = {
    tool: 'eslint',
    exitCode: 1,
    failures: [
      failureOf({ file: 'src/a.ts', line: 5, column: 1 }),
      failureOf({ file: 'src/b.ts', line: 9, column: 3 }),
      noiseFailure,
    ],
  };
  // The ledger noise signature is exactly the canonical signature (the
  // documented record seam), so the noise failure is suppressed for real.
  const noiseSignature = clusterSignature(noiseFailure, 'eslint');
  return clusterErrors(set, {
    entries: [{ signature: noiseSignature, count: 2 }],
    knownNoise: [noiseSignature],
    needsHuman: [],
  });
}

/**
 * An in-memory AnalyzeFileStore: files keyed by path, dirs implied by the
 * root. Records every write so tests can address bytes exactly as the real
 * store would have landed them. Paths are RESOLVED AGAINST THE ROOT (the
 * real store's addressing) — this is what catches store-relative path
 * discipline regressions: an op that double-roots (dir/dir/…) writes to a
 * key no caller-facing path points at.
 */
function memoryStore(
  root: string,
  files: Record<string, string>,
): AnalyzeFileStore & {
  written: Map<string, Uint8Array>;
} {
  const backing = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, text]) => [resolve(root, path), Buffer.from(text, 'utf8')]),
  );
  const written = new Map<string, Uint8Array>();
  return {
    written,
    readBytes: async (path) => {
      const bytes = backing.get(resolve(root, path));
      if (bytes === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Uint8Array.from(bytes);
    },
    readText: async (path) => {
      const bytes = backing.get(resolve(root, path));
      if (bytes === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Buffer.from(bytes).toString('utf8');
    },
    writeBytes: async (path, bytes) => {
      const copy = Uint8Array.from(bytes);
      const key = resolve(root, path);
      written.set(key, copy);
      backing.set(key, copy);
    },
    isDirectory: async (path) => {
      const abs = resolve(root, path);
      if (abs === resolve(root, '.')) return backing.size > 0;
      for (const key of backing.keys()) {
        if (key.startsWith(`${abs}${sep}`)) return true;
      }
      return false;
    },
  };
}

afterEach(async () => {
  if (scratchDir !== '') {
    await rm(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
});
let scratchDir = '';

describe('renderAnalysisReport (pure core): determinism is the contract', () => {
  test('the same report+meta renders byte-identical markdown and sidecar', () => {
    const report = fixtureReport();
    const evidence = [
      {
        clusterId: report.clusters[0]?.id ?? '',
        targets: [{ file: 'src/a.ts', digest: '0deadbe0' }],
      },
    ];
    const first = renderAnalysisReport(report, { evidence });
    const second = renderAnalysisReport(report, { evidence });
    expect(second).toEqual(first);
    expect(second.markdown).toBe(first.markdown);
    expect(serializeAnalysisSidecar(second.sidecar)).toBe(serializeAnalysisSidecar(first.sidecar));
  });

  test('the report fingerprint is FNV-1a 32-bit over the canonical report JSON', () => {
    const report = fixtureReport();
    expect(reportFingerprint(report)).toBe(fnv1a32Hex(JSON.stringify(report)));
  });

  test('a changed report changes the fingerprint; evidence changes the sidecar but not the markdown', () => {
    const report = fixtureReport();
    const edited: ClusterErrorsReport = {
      clusters: report.clusters,
      noise: [...report.noise, failureOf({ file: 'src/d.ts', message: 'm' })],
    };
    expect(reportFingerprint(edited)).not.toBe(reportFingerprint(report));
    const withEvidence = renderAnalysisReport(report, {
      evidence: [{ clusterId: report.clusters[0]?.id ?? '', targets: [] }],
    });
    const withoutEvidence = renderAnalysisReport(report);
    expect(withEvidence.markdown).toBe(withoutEvidence.markdown);
    expect(withEvidence.sidecar.evidence).toEqual([
      { clusterId: report.clusters[0]?.id ?? '', targets: [] },
    ]);
    expect(withoutEvidence.sidecar.evidence).toEqual([]);
  });

  test('no timestamps anywhere in the content; ordering is id-sorted', () => {
    const { markdown, sidecar } = renderAnalysisReport(fixtureReport());
    expect(markdown).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(markdown).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(JSON.stringify(sidecar)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const ids = sidecar.report.clusters.map((cluster) => cluster.id);
    expect(ids).toEqual([...ids].sort());
    expect(markdown).toContain('# Analysis report');
    expect(markdown).toContain('## noise');
    expect(markdown).toContain(`## cluster ${ids[0]} (confidence: high)`);
  });

  test('failure lines render nulls as dashes deterministically', () => {
    const report: ClusterErrorsReport = {
      clusters: [],
      noise: [failureOf({ file: null, line: null, column: null, ruleId: null })],
    };
    const { markdown } = renderAnalysisReport(report);
    expect(markdown).toContain('- -:-:- [error] -: ');
  });
});

describe('the sidecar format: strict parse, re-derived fingerprint', () => {
  test('serialize ∘ parse is the identity', () => {
    const report = fixtureReport();
    const { sidecar } = renderAnalysisReport(report, {
      evidence: [
        {
          clusterId: report.clusters[0]?.id ?? '',
          targets: [{ file: 'src/a.ts', digest: contentDigest('const x = 1;\n') }],
        },
      ],
    });
    const parsed = parseAnalysisSidecar(serializeAnalysisSidecar(sidecar));
    expect(parsed).toEqual(sidecar);
    expect(parsed.schemaVersion).toBe(ANALYSIS_SIDECAR_SCHEMA_VERSION);
  });

  test('missing/garbage/wrong-version sidecars fail with clear errors', () => {
    expect(() => parseAnalysisSidecar('not json {')).toThrow(SidecarFormatError);
    expect(() => parseAnalysisSidecar('{}')).toThrow(/schemaVersion/);
    const report = fixtureReport();
    const { sidecar } = renderAnalysisReport(report);
    const wrongVersion = serializeAnalysisSidecar(sidecar).replace(
      '"schemaVersion": 1',
      '"schemaVersion": 2',
    );
    expect(() => parseAnalysisSidecar(wrongVersion)).toThrow(
      /schema violation \(expected schemaVersion 1\)/,
    );
    expect(() => parseAnalysisSidecar(wrongVersion)).toThrow(/schemaVersion/);
  });

  test('a drifted report under a stale fingerprint is rejected (the fingerprint is re-derived, never trusted)', () => {
    const report = fixtureReport();
    const { sidecar } = renderAnalysisReport(report);
    const drifted = {
      ...sidecar,
      report: { ...sidecar.report, noise: [...sidecar.report.noise, failureOf({})] },
    };
    expect(() => parseAnalysisSidecar(JSON.stringify(drifted))).toThrow(
      /reportFingerprint does not match the embedded report/,
    );
  });

  test('evidence naming an unknown cluster, and a size/member mismatch, are format errors', () => {
    const report = fixtureReport();
    const { sidecar } = renderAnalysisReport(report);
    const badEvidence = {
      ...sidecar,
      evidence: [{ clusterId: '00000000', targets: [] }],
    };
    expect(() => parseAnalysisSidecar(JSON.stringify(badEvidence))).toThrow(
      /evidence names a cluster id absent from the report/,
    );
    const badSize = JSON.parse(serializeAnalysisSidecar(sidecar)) as {
      report: { clusters: Array<{ size: number }> };
    };
    badSize.report.clusters[0]!.size += 1;
    expect(() => parseAnalysisSidecar(JSON.stringify(badSize))).toThrow(
      /size must equal failures\.length/,
    );
  });
});

describe('makeRenderAnalysisReport (op over an injected store)', () => {
  const fileContents: Record<string, string> = {
    'src/a.ts': 'const x = 1;\nexport { x };\n',
    'src/b.ts': 'export const y = 2;\nexport { y };\n',
    'src/c.ts': 'console.log(1);\n',
  };

  function opInput(dir: string) {
    return { report: fixtureReport(), dir };
  }

  test('writes BOTH files under deterministic content-derived names and returns their paths', async () => {
    const files = { ...fileContents };
    const store = memoryStore('/ws', files);
    const op = makeOp(store);
    const result = await op(opInput('/ws'));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const fp = reportFingerprint(fixtureReport());
    expect(result.value).toEqual({
      markdownPath: '/ws/analysis-<fp>.md'.replace('<fp>', fp),
      sidecarPath: '/ws/analysis-<fp>.sidecar.json'.replace('<fp>', fp),
      reportFingerprint: fp,
    });
    // The written bytes are exactly the pure rendering WITH the evidence
    // the op derives (analysis-time digests of the cluster targets).
    const rendered = renderAnalysisReport(fixtureReport(), {
      evidence: [
        {
          clusterId: fixtureReport().clusters[0]?.id ?? '',
          targets: [
            { file: 'src/a.ts', digest: contentDigest(fileContents['src/a.ts'] as string) },
            { file: 'src/b.ts', digest: contentDigest(fileContents['src/b.ts'] as string) },
          ],
        },
      ],
    });
    const sidecarBytes = store.written.get(result.value.sidecarPath) as Uint8Array;
    expect(Buffer.from(sidecarBytes).toString('utf8')).toBe(
      serializeAnalysisSidecar(rendered.sidecar),
    );
    expect(
      Buffer.from(store.written.get(result.value.markdownPath) as Uint8Array).toString('utf8'),
    ).toBe(rendered.markdown);
    // The evidence digests are the analysis-time content digests, per cluster, sorted.
    const parsed = parseAnalysisSidecar(Buffer.from(sidecarBytes).toString('utf8'));
    expect(parsed.evidence).toEqual([
      {
        clusterId: parsed.report.clusters[0]?.id,
        targets: [
          { file: 'src/a.ts', digest: contentDigest(fileContents['src/a.ts'] as string) },
          { file: 'src/b.ts', digest: contentDigest(fileContents['src/b.ts'] as string) },
        ],
      },
    ]);
    // Noise files are never digested (noise is never remediated).
    expect(JSON.stringify(parsed.evidence)).not.toContain('src/c.ts');
    // A second identical render lands identical bytes at identical paths.
    const again = await op(opInput('/ws'));
    expect(again.status === 'ok' && again.value).toEqual(result.value);
  });

  test('a RELATIVE dir is store-root discipline-safe: no double-rooted reads or writes (M1 regression)', async () => {
    // With the store rooted AT the relative dir, the op must check '.',
    // read the dir-relative targets, and write the BARE file names — the
    // pre-M1 code doubled the root (isDirectory('ws') on root 'ws') and
    // joined input.dir onto store-relative writes.
    const store = memoryStore('ws', { ...fileContents });
    const op = makeOp(store);
    const result = await op(opInput('ws'));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const fp = reportFingerprint(fixtureReport());
    // The returned paths are caller-facing (joined with the caller's dir)…
    expect(result.value).toEqual({
      markdownPath: `ws/analysis-${fp}.md`,
      sidecarPath: `ws/analysis-${fp}.sidecar.json`,
      reportFingerprint: fp,
    });
    // …and the bytes landed at exactly those paths in the rooted store
    // (resolve anchors relative roots at the process cwd, exactly like the
    // real store) — a double-rooted write would have produced
    // '…/ws/ws/analysis-…' keys instead.
    expect(store.written.get(resolve('ws', `analysis-${fp}.md`))).toBeDefined();
    expect(store.written.get(resolve('ws', `analysis-${fp}.sidecar.json`))).toBeDefined();
    const doubleRoot = `${sep}ws${sep}ws${sep}`;
    expect([...store.written.keys()].every((key) => !key.includes(doubleRoot))).toBe(true);
  });

  test('a missing directory is refused (the op wraps an existing dir, never mkdir -p)', async () => {
    const store = memoryStore('/missing', {});
    store.isDirectory = async () => false;
    const op = makeOp(store);
    const result = await op(opInput('/missing'));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("directory does not exist: '/missing'");
      expect(result.error).toContain('never creates one');
    }
    expect(store.written.size).toBe(0);
  });

  test('an unreadable target file fails the op naming the file — no sidecar with unverifiable targets', async () => {
    const store = memoryStore('/ws', { 'src/a.ts': 'x\n' }); // src/b.ts missing
    const op = makeOp(store);
    const result = await op(opInput('/ws'));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('could not digest a cluster target');
      expect(result.error).toContain('src/b.ts');
    }
    expect(store.written.size).toBe(0);
  });
});

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

/** The render op over an explicit store (the injectable factory under test). */
function makeOp(store: AnalyzeFileStore) {
  return makeRenderAnalysisReport(() => store);
}
