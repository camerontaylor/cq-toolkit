// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus renderAnalysisReport.helpers.ts (shared fixtures, no tests).
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  renderAnalysisReport,
  reportFingerprint,
  serializeAnalysisSidecar,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { ClusterErrorsReport } from '../../../src/ops/analyze/clusterErrors.js';
import { failureOf, fixtureReport } from './renderAnalysisReport.helpers.js';

describe('renderAnalysisReport (pure core): determinism is the contract', () => {
  test('the same report+meta renders byte-identical markdown and sidecar', () => {
    const report = fixtureReport();
    const evidence = [
      {
        clusterId: report.clusters[0]?.id ?? '',
        signature: report.clusters[0]?.signature ?? '',
        targets: [{ file: 'src/a.ts', digest: '0deadbe0' }],
      },
    ];
    const first = renderAnalysisReport(report, { evidence });
    const second = renderAnalysisReport(report, { evidence });
    expect(second).toEqual(first);
    expect(second.markdown).toBe(first.markdown);
    expect(serializeAnalysisSidecar(second.sidecar)).toBe(serializeAnalysisSidecar(first.sidecar));
  });

  test('the report fingerprint is SHA-256 truncated to 64 bits (16 hex) over the canonical report JSON (review-debt #155)', () => {
    const report = fixtureReport();
    expect(reportFingerprint(report)).toBe(
      createHash('sha256').update(JSON.stringify(report)).digest('hex').slice(0, 16),
    );
    // The handle is 16 hex chars — it names published artifact FILES, so it
    // must be collision-resistant, not display-grade.
    expect(reportFingerprint(report)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('a changed report changes the fingerprint; evidence changes the sidecar but not the markdown', () => {
    const report = fixtureReport();
    const edited: ClusterErrorsReport = {
      clusters: report.clusters,
      noise: [...report.noise, failureOf({ file: 'src/d.ts', message: 'm' })],
    };
    expect(reportFingerprint(edited)).not.toBe(reportFingerprint(report));
    const withEvidence = renderAnalysisReport(report, {
      evidence: [
        {
          clusterId: report.clusters[0]?.id ?? '',
          signature: report.clusters[0]?.signature ?? '',
          targets: [],
        },
      ],
    });
    const withoutEvidence = renderAnalysisReport(report);
    expect(withEvidence.markdown).toBe(withoutEvidence.markdown);
    expect(withEvidence.sidecar.evidence).toEqual([
      {
        clusterId: report.clusters[0]?.id ?? '',
        signature: report.clusters[0]?.signature ?? '',
        targets: [],
      },
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
