// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus renderAnalysisReport.helpers.ts (shared fixtures, no tests).
import { describe, expect, test } from 'vitest';
import type { AnalyzeFileStore } from '../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../src/ops/analyze/analysisStore.js';
import {
  reportFingerprint,
  sidecarFileName,
} from '../../../src/ops/analyze/renderAnalysisReport.js';
import {
  fileContents,
  fixtureReport,
  makeOp,
  memoryStore,
  opInput,
} from './renderAnalysisReport.helpers.js';

describe('makeRenderAnalysisReport (op over an injected store)', () => {
  test('a markdown write fault after the sidecar landed names the already-written path (R2-4)', async () => {
    const store = memoryStore('/ws', { ...fileContents });
    const flaky: AnalyzeFileStore & { written: Map<string, Uint8Array> } = {
      get written() {
        return store.written;
      },
      readBytes: (path) => store.readBytes(path),
      readText: (path) => store.readText(path),
      writeBytes: async (path, bytes) => {
        if (path.startsWith('analysis-') && path.endsWith('.md')) {
          throw new AnalysisStoreError('analysis store: disk full on the markdown write');
        }
        return store.writeBytes(path, bytes);
      },
      isDirectory: (path) => store.isDirectory(path),
    };
    const result = await makeOp(flaky)(opInput('/ws'));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('could not write the report pair');
      expect(result.error).toContain('already written:');
      expect(result.error).toContain(sidecarFileName(reportFingerprint(fixtureReport())));
    }
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
