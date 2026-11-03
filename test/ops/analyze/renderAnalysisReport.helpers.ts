// Split provenance: test/ops/analyze/renderAnalysisReport.test.ts was split into
// renderAnalysisReport.{determinism,sidecarCoverage,sidecarSchema,opStore,opFaults,importer,importerSymlink,fnvCollisions}.test.ts
// plus this module (shared fixtures only — no tests, no describe). The
// original header follows.
//
// Analyze lane G2 — test evidence for the report pair: pure-core
// determinism (same report+meta → byte-identical markdown and sidecar, and
// the returned paths are pure functions of content), the sidecar contract
// (fingerprint re-derived on parse, strict fail-closed format errors), the
// op's fs behavior through an INJECTED store (missing dir refused, missing
// target failed, deterministic names), and the registry importer resolving
// end-to-end over a real mkdtemp dir (the one place real fs is allowed
// here, mirroring the C4 registry-test precedent).
import { resolve, sep } from 'node:path';
import type { AnalyzeFileStore } from '../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../src/ops/analyze/analysisStore.js';
import { clusterErrors, clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import { makeRenderAnalysisReport } from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { ClusterErrorsReport } from '../../../src/ops/analyze/clusterErrors.js';
import type { CheckFailure, FailureSet } from '../../../src/ops/gates/index.js';

/** A failure with only the fields under test (the family test idiom). */
export function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
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
export function fixtureReport(): ClusterErrorsReport {
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
export function memoryStore(
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

export const fileContents: Record<string, string> = {
  'src/a.ts': 'const x = 1;\nexport { x };\n',
  'src/b.ts': 'export const y = 2;\nexport { y };\n',
  'src/c.ts': 'console.log(1);\n',
};

export function opInput(dir: string) {
  return { report: fixtureReport(), dir };
}

/** The render op over an explicit store (the injectable factory under test). */
export function makeOp(store: AnalyzeFileStore) {
  return makeRenderAnalysisReport(() => store);
}
