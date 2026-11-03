// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus renderAnalysisReport.helpers.ts (shared fixtures, no tests).
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { clusterErrors } from '../../../src/ops/analyze/clusterErrors.js';
import {
  parseAnalysisSidecar,
  sidecarFileName,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import { failureOf, makeOp, memoryStore } from './renderAnalysisReport.helpers.js';

describe('FNV id collisions: evidence is keyed by the (id, signature) PAIR (F2)', () => {
  // The G1-pinned collision pair: two DISTINCT signatures, one 32-bit id.
  const collidingReport = clusterErrors({
    tool: 'eslint',
    exitCode: 1,
    failures: [
      failureOf({ file: 'src/a.ts', ruleId: 'r', message: 'tjivlzyj' }),
      failureOf({ file: 'src/b.ts', ruleId: 'r', message: 'qcmqx' }),
    ],
  });

  test('the two clusters genuinely share one id but carry distinct signatures', () => {
    const [first, second] = collidingReport.clusters;
    expect(first?.id).toBe(second?.id);
    expect(first?.signature).not.toBe(second?.signature);
  });

  test('the render op publishes both clusters evidence and the sidecar parses with full pair coverage (F2)', async () => {
    const files = { 'src/a.ts': 'tjivlzyj;\n', 'src/b.ts': 'qcmqx;\n' };
    const store = memoryStore('/ws', files);
    const op = makeOp(store);
    const result = await op({ report: collidingReport, dir: '/ws' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const parsed = parseAnalysisSidecar(
      Buffer.from(
        store.written.get(
          resolve('/ws', sidecarFileName(result.value.reportFingerprint)),
        ) as Uint8Array,
      ).toString('utf8'),
    );
    // Pre-F2 a by-id evidence map collapsed these to one entry (last wins)
    // and coverage failed or silently under-covered one cluster.
    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.evidence[0]?.clusterId).toBe(parsed.evidence[1]?.clusterId);
    expect(parsed.evidence[0]?.signature).not.toBe(parsed.evidence[1]?.signature);
    // Evidence order follows the report (clusters sort by the signature
    // tiebreak: qcmqx before tjivlzyj).
    const targetSets = parsed.evidence.map((entry) => entry.targets.map((t) => t.file));
    expect(targetSets).toEqual([['src/b.ts'], ['src/a.ts']]);
  });
});
