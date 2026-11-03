// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus renderAnalysisReport.helpers.ts (shared fixtures, no tests).
import { describe, expect, test } from 'vitest';
import {
  SidecarFormatError,
  parseAnalysisSidecar,
  renderAnalysisReport,
  serializeAnalysisSidecar,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import { failureOf, fixtureReport } from './renderAnalysisReport.helpers.js';

describe('the sidecar format: strict parse, re-derived fingerprint, coverage contract', () => {
  test('an 8-hex reportFingerprint (the old handle) FAILS the sidecar schema (r1 review — Hex16 negative branch)', () => {
    const report = fixtureReport();
    const { sidecar } = renderAnalysisReport(report);
    const truncated = JSON.parse(serializeAnalysisSidecar(sidecar)) as {
      reportFingerprint: string;
    };
    truncated.reportFingerprint = truncated.reportFingerprint.slice(0, 8);
    expect(() => parseAnalysisSidecar(JSON.stringify(truncated))).toThrow(
      /expected 16 lowercase hex digits/,
    );
  });

  test('missing/garbage/wrong-version sidecars fail with clear errors', () => {
    expect(() => parseAnalysisSidecar('not json {')).toThrow(SidecarFormatError);
    expect(() => parseAnalysisSidecar('{}')).toThrow(/schemaVersion/);
    const report = fixtureReport();
    const { sidecar } = renderAnalysisReport(report);
    // Mutate the version to a GENUINELY wrong value (the sidecar serializes
    // schemaVersion 2, so replacing 2 with 1 really changes it — a replace
    // that matches nothing would fail the coverage check instead and pass
    // for the wrong reason).
    const wrongVersion = serializeAnalysisSidecar(sidecar).replace(
      '"schemaVersion": 2',
      '"schemaVersion": 1',
    );
    expect(() => parseAnalysisSidecar(wrongVersion)).toThrow(
      /schema violation \(expected schemaVersion 2\)/,
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
      evidence: [{ clusterId: '00000000', signature: 'no-match', targets: [] }],
    };
    expect(() => parseAnalysisSidecar(JSON.stringify(badEvidence))).toThrow(
      /pair absent from the report/,
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
