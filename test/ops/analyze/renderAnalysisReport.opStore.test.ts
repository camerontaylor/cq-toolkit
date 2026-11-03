// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus renderAnalysisReport.helpers.ts (shared fixtures, no tests).
import { resolve, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  contentDigest,
  parseAnalysisSidecar,
  renderAnalysisReport,
  reportFingerprint,
  serializeAnalysisSidecar,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import {
  fileContents,
  fixtureReport,
  makeOp,
  memoryStore,
  opInput,
} from './renderAnalysisReport.helpers.js';

describe('makeRenderAnalysisReport (op over an injected store)', () => {
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
          signature: fixtureReport().clusters[0]?.signature ?? '',
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
        signature: parsed.report.clusters[0]?.signature,
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
});
