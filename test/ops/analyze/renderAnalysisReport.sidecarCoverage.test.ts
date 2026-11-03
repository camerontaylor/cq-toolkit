// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus renderAnalysisReport.helpers.ts (shared fixtures, no tests).
import { describe, expect, test } from 'vitest';
import {
  ANALYSIS_SIDECAR_SCHEMA_VERSION,
  contentDigest,
  parseAnalysisSidecar,
  renderAnalysisReport,
  serializeAnalysisSidecar,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { ClusterErrorsReport } from '../../../src/ops/analyze/clusterErrors.js';
import { failureOf, fixtureReport } from './renderAnalysisReport.helpers.js';

describe('the sidecar format: strict parse, re-derived fingerprint, coverage contract', () => {
  test('serialize ∘ parse is the identity (full coverage)', () => {
    const report = fixtureReport();
    const { sidecar } = renderAnalysisReport(report, {
      evidence: [
        {
          clusterId: report.clusters[0]?.id ?? '',
          signature: report.clusters[0]?.signature ?? '',
          targets: [
            { file: 'src/a.ts', digest: contentDigest('const x = 1;\n') },
            { file: 'src/b.ts', digest: contentDigest('export const y = 2;\n') },
          ],
        },
      ],
    });
    const parsed = parseAnalysisSidecar(serializeAnalysisSidecar(sidecar));
    expect(parsed).toEqual(sidecar);
    expect(parsed.schemaVersion).toBe(ANALYSIS_SIDECAR_SCHEMA_VERSION);
    // A cluster whose members all lack files is legitimately covered by an
    // EMPTY evidence entry.
    const nullFileReport: ClusterErrorsReport = {
      clusters: [
        {
          id: '0deadbe0',
          signature: '["t","r","m"]',
          tool: 't',
          ruleId: 'r',
          confidence: 'low',
          failures: [failureOf({ file: null })],
          size: 1,
        },
      ],
      noise: [],
    };
    const nullFileSidecar = renderAnalysisReport(nullFileReport, {
      evidence: [{ clusterId: '0deadbe0', signature: '["t","r","m"]', targets: [] }],
    }).sidecar;
    expect(parseAnalysisSidecar(serializeAnalysisSidecar(nullFileSidecar))).toEqual(
      nullFileSidecar,
    );
  });

  test('an EVIDENCE-FREE (or partial) sidecar is a format fault naming the uncovered cluster — absence never silently disables staleness', () => {
    const report = fixtureReport();
    // The PURE CORE's meta-less output: evidence [] — not appliable as-is
    // (the deliberate consequence documented in the module header).
    const bare = serializeAnalysisSidecar(renderAnalysisReport(report).sidecar);
    expect(() => parseAnalysisSidecar(bare)).toThrow(/evidence does not cover cluster /);
    expect(() => parseAnalysisSidecar(bare)).toThrow(new RegExp(report.clusters[0]?.id ?? ''));
    // A PARTIAL sidecar (evidence for a different cluster) faults the same way.
    const other = report.clusters[0]?.id ?? '';
    const partial = serializeAnalysisSidecar(
      renderAnalysisReport(report, {
        evidence: [{ clusterId: '0deadbe0', signature: 'no-match', targets: [] }],
      }).sidecar,
    );
    if (other === '0deadbe0') return; // fixture-dependent guard
    expect(() => parseAnalysisSidecar(partial)).toThrow(/does not cover cluster/);
  });

  test('evidence with a WRONG target set for a cluster is a format fault', () => {
    const report = fixtureReport();
    const sidecar = renderAnalysisReport(report, {
      evidence: [
        {
          clusterId: report.clusters[0]?.id ?? '',
          signature: report.clusters[0]?.signature ?? '',
          targets: [{ file: 'src/a.ts', digest: '0deadbe0' }],
        },
      ],
    }).sidecar;
    expect(() => parseAnalysisSidecar(serializeAnalysisSidecar(sidecar))).toThrow(
      /evidence targets for cluster .* do not equal its member files/,
    );
  });
});
