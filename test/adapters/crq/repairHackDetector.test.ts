/**
 * Replay of the Python oracle for `crq_repair.hack_detector`.
 *
 * Each case in `crq-repair-hack-detector/cases.json` ran the production function
 * with its subprocess stubbed to a declared (exit code, stdout, stderr) triple or
 * exception. The replay feeds the same triple to `runHackDetector` and compares
 * the verdict, the exception class and the message, byte for byte.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  inProcessDetector,
  MAX_HACK_DETECTOR_DIFF_BYTES,
  runHackDetector,
  type DetectorRun,
} from '../../../src/adapters/crq/repairHackDetector.js';
import { isPyError, PyError, type PyErrorKind } from '../../../src/queue-runner/pyErrors.js';

interface Run {
  proc?: { code: number; stdout: string; stderr: string };
  raise?: { kind: string; text: string };
}
interface Case {
  name: string;
  diff: string;
  run: Run;
  expected:
    | { outcome: 'returned'; status: string }
    | { outcome: 'raised'; class: string; message?: string };
}
const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../apps/crq-python/fixtures/crq-repair-hack-detector/cases.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { limit: number; cases: Case[] };

/** Python class name -> the PyError kind the port raises for it. */
const KIND: Record<string, PyErrorKind> = {
  DetectorRejection: 'ValueError',
  DetectorUnavailable: 'DetectorUnavailable',
  UnicodeEncodeError: 'UnicodeEncodeError',
  RuntimeError: 'RuntimeError',
};

function runnerFor(spec: Run): DetectorRun {
  return async () => {
    if (spec.raise !== undefined) {
      throw new PyError(spec.raise.kind as PyErrorKind, spec.raise.text);
    }
    return spec.proc!;
  };
}

describe('runHackDetector replays crq_repair.hack_detector', () => {
  test('the size limit matches Python', () => {
    expect(MAX_HACK_DETECTOR_DIFF_BYTES).toBe(fixture.limit);
  });

  test.each(fixture.cases.map((c) => [c.name, c] as const))('%s', async (_name, spec) => {
    const outcome = await runHackDetector(spec.diff, runnerFor(spec.run)).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (spec.expected.outcome === 'returned') {
      expect('error' in outcome ? outcome.error : null).toBeNull();
      return;
    }
    expect('error' in outcome).toBe(true);
    const error = (outcome as { error: unknown }).error;
    const kind = KIND[spec.expected.class];
    expect(kind, `unmapped class ${spec.expected.class}`).toBeDefined();
    expect(error).toBeInstanceOf(PyError);
    expect((error as PyError).kind).toBe(kind);
    if (spec.expected.message !== undefined) {
      expect((error as PyError).message).toBe(spec.expected.message);
    }
  });

  test('a rejection is a ValueError and an outage is also one (Python subclassing)', async () => {
    const reject = await runHackDetector('d', async () => ({
      code: 0,
      stdout: '{"status":"failed"}',
      stderr: '',
    })).catch((e: unknown) => e);
    expect(isPyError(reject, 'ValueError')).toBe(true);
    const outage = await runHackDetector('d', async () => ({
      code: 0,
      stdout: 'x',
      stderr: '',
    })).catch((e: unknown) => e);
    expect(isPyError(outage, 'DetectorUnavailable')).toBe(true);
    expect(isPyError(outage, 'ValueError')).toBe(true);
  });
});

describe('inProcessDetector (the default runner)', () => {
  const clean =
    'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const skip =
    'diff --git a/test/a.test.ts b/test/a.test.ts\n--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1 +1 @@\n-a\n+it.skip("x", () => {});\n';

  test('passes a clean diff', async () => {
    await expect(runHackDetector(clean, inProcessDetector)).resolves.toBeDefined();
  });
  test('rejects a diff that adds a skip marker, as a ValueError rejection', async () => {
    const error = await runHackDetector(skip, inProcessDetector).catch((e: unknown) => e);
    expect(isPyError(error, 'ValueError')).toBe(true);
    expect((error as PyError).kind).toBe('ValueError');
    expect((error as PyError).message).toMatch(/^hack detector did not pass: \[\{"kind"/);
  });
  test('a diff with no structure is an outage-free indeterminate rejection, not a pass', async () => {
    const error = await runHackDetector('just some prose', inProcessDetector).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PyError);
  });
});
