/**
 * Differential test of the receipt modes in `prReviewFindings.ts` (`buildReview` with a
 * receipt binding, `addedRanges`, `loadFindings` highest-severity, `diffHunks`
 * changed-only) against the live Python `pr_review_findings` via
 * `oracle/receipt_build_oracle.py`. Values, exception class and message, and every gh argv
 * must match. Skipped where python3 is absent.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  addedRanges,
  buildReview,
  diffHunks,
  loadFindings,
  type Finding,
  type GhPort,
  type HunkMap,
} from '../../../src/policy/crq/prReviewFindings.js';

const ORACLE = fileURLToPath(new URL('./oracle/receipt_build_oracle.py', import.meta.url));
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;

interface Answer {
  stdout?: string;
  returncode?: number;
  stderr?: string;
}
interface Scenario {
  name: string;
  fn: 'build' | 'added' | 'load' | 'diff';
  args: Record<string, unknown>;
  gh?: Answer[];
}
interface Outcome {
  ok?: unknown;
  err?: string;
  msg?: string;
  calls: string[][];
}

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const json = (v: unknown): string => JSON.stringify(v);
const F = (
  severity: string,
  path: string | null,
  start: number | null,
  end: number | null,
  title = 'Title',
  text = 'Body text.',
): Record<string, unknown> => ({ severity, path, start, end, title, text });
const META = { run_id: 'r1', base: B, head: H, item_id: 'q1' };
const RECEIPT = {
  ...META,
  crq_receipt: true,
  receipt_binding: '<!-- crq-review-output {"base":"x"} -->',
  receipt_header: '**Independent review: PASS**',
  whole_pr_scan: true,
};
const HUNKS = {
  'src/a.ts': [[10, 14]],
  'src/b.ts': [
    [3, 3],
    [20, 25],
  ],
};
const B_ = (meta: unknown, findings: unknown[], hunks: unknown): Scenario['args'] => ({
  meta,
  findings,
  hunks,
});

const many = Array.from({ length: 60 }, (_, i) => F('minor', 'src/a.ts', 10, 11, `T${i}`));

const PATCH = '@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n@@ -40,2 +41,6 @@\n x\n+y\n-z\n+w\n';
const ev = (o: Record<string, unknown>): string => json({ type: 'finding', ...o });
const files = (rows: unknown[]): Answer => ({ stdout: json(rows) });

const SCENARIOS: Scenario[] = [
  {
    name: 'build: receipt anchored major',
    fn: 'build',
    args: B_(RECEIPT, [F('major', 'src/a.ts', 11, 12)], HUNKS),
  },
  {
    name: 'build: receipt fallback anchor for an unplaceable finding',
    fn: 'build',
    args: B_(RECEIPT, [F('major', 'src/zzz.ts', 5, 6), F('minor', 'src/a.ts', 99, 99)], HUNKS),
  },
  {
    name: 'build: receipt fallback with a null path',
    fn: 'build',
    args: B_(RECEIPT, [F('critical', null, null, null)], HUNKS),
  },
  { name: 'build: receipt with no findings', fn: 'build', args: B_(RECEIPT, [], HUNKS) },
  {
    name: 'build: receipt unattested and narrow',
    fn: 'build',
    args: B_(
      { ...RECEIPT, unattested: true, whole_pr_scan: false },
      [F('minor', 'src/a.ts', 10, 10)],
      HUNKS,
    ),
  },
  {
    name: 'build: receipt with empty hunks keeps body-major',
    fn: 'build',
    args: B_(RECEIPT, [F('BLOCKER', 'src/a.ts', 10, 10), F('minor', null, null, null)], {}),
  },
  {
    name: 'build: receipt with hunks null is body-only',
    fn: 'build',
    args: B_(RECEIPT, [F('fatal', 'src/a.ts', 10, 10)], null),
  },
  {
    name: 'build: receipt is not capped at 50 inline threads',
    fn: 'build',
    args: B_(RECEIPT, many, HUNKS),
  },
  {
    name: 'build: non-receipt is still capped',
    fn: 'build',
    args: B_(META, many, HUNKS),
  },
  {
    name: 'build: receipt digest over non-ASCII text',
    fn: 'build',
    args: B_(RECEIPT, [F('major', 'src/a.ts', 10, 10, 'É title', 'naïve ☃ 😀 text')], HUNKS),
  },
  {
    name: 'build: receipt flag without binding adds no markers',
    fn: 'build',
    args: B_({ ...META, crq_receipt: true }, [F('major', 'src/zzz.ts', 5, 6)], HUNKS),
  },
  {
    name: 'build: binding without a header is a KeyError',
    fn: 'build',
    args: B_({ ...RECEIPT, receipt_header: undefined }, [], HUNKS),
  },
  {
    name: 'build: first populated path wins the fallback',
    fn: 'build',
    args: B_(RECEIPT, [F('major', 'nope', 1, 1)], {
      empty: [],
      'src/b.ts': [[7, 9]],
      'src/a.ts': [[1, 2]],
    }),
  },
  { name: 'added: mixed patch', fn: 'added', args: { patch: PATCH } },
  { name: 'added: empty', fn: 'added', args: { patch: '' } },
  { name: 'added: no header', fn: 'added', args: { patch: '+x\n y\n' } },
  {
    name: 'added: crlf and no-newline marker',
    fn: 'added',
    args: { patch: '@@ -1 +1,2 @@\r\n x\r\n+y\r\n\\ No newline at end of file\r\n' },
  },
  {
    name: 'added: header without counts',
    fn: 'added',
    args: { patch: '@@ -3 +7 @@ ctx\n+a\n+b\n' },
  },
  {
    name: 'added: plus-plus-plus rows count',
    fn: 'added',
    args: { patch: '@@ -1,2 +1,2 @@\n+++ b\n--- a\n+c\n' },
  },
  {
    name: 'added: unicode line separators split rows',
    fn: 'added',
    args: { patch: '@@ -1 +1 @@ +a +b\x85 c\x0c+d' },
  },
  { name: 'added: arabic-indic digits', fn: 'added', args: { patch: '@@ -1 +٣,٢ @@\n+a\n' } },
  {
    name: 'added: indented header is context-less',
    fn: 'added',
    args: { patch: ' @@ -1 +1 @@\n+a\n' },
  },
  { name: 'added: non-string patch', fn: 'added', args: { patch: 5 } },
  {
    name: 'load: highest severity wins on a duplicate',
    fn: 'load',
    args: {
      highest: true,
      text: `${ev({ severity: 'minor', fileName: 'a', startLine: 1, title: 't', comment: 'c' })}\n${ev({ severity: 'Fatal', fileName: 'a', startLine: 1, title: 't', comment: 'c' })}\n${ev({ severity: 'major', fileName: 'a', startLine: 1, title: 't', comment: 'c' })}\n`,
    },
  },
  {
    name: 'load: first severity wins without the flag',
    fn: 'load',
    args: {
      highest: false,
      text: `${ev({ severity: 'minor', fileName: 'a', startLine: 1, title: 't', comment: 'c' })}\n${ev({ severity: 'fatal', fileName: 'a', startLine: 1, title: 't', comment: 'c' })}\n`,
    },
  },
  {
    name: 'load: unknown and equal ranks keep the first',
    fn: 'load',
    args: {
      highest: true,
      text: `${ev({ severity: 'weird', title: 't' })}\n${ev({ severity: 'none', title: 't' })}\n${ev({ severity: 'MINOR', title: 'u' })}\n${ev({ severity: 'minor', title: 'u' })}\n`,
    },
  },
  {
    name: 'load: unknown severity upgraded by a known one',
    fn: 'load',
    args: {
      highest: true,
      text: `${ev({ severity: 'weird', title: 't' })}\n${ev({ severity: 'info', title: 't' })}\n`,
    },
  },
  {
    name: 'diff: changed-only uses added lines',
    fn: 'diff',
    args: { base: B, head: H, changed: true },
    gh: [
      files([
        { filename: 'a.ts', status: 'modified', patch: PATCH },
        { filename: 'gone.ts', status: 'removed', patch: PATCH },
      ]),
    ],
  },
  {
    name: 'diff: default keeps right-side hunks',
    fn: 'diff',
    args: { base: B, head: H, changed: false },
    gh: [files([{ filename: 'a.ts', status: 'modified', patch: PATCH }])],
  },
  {
    name: 'diff: falsy patches are empty',
    fn: 'diff',
    args: { base: B, head: H, changed: true },
    gh: [
      files([
        { filename: 'a', status: 'added', patch: null },
        { filename: 'b', status: 'added', patch: '' },
        { filename: 'c', status: 'added' },
        { filename: 'd', status: 'added', patch: 0 },
        { filename: 'e', status: 'added', patch: false },
      ]),
    ],
  },
  {
    name: 'diff: a truthy non-string patch fails',
    fn: 'diff',
    args: { base: B, head: H, changed: true },
    gh: [files([{ filename: 'a', status: 'added', patch: 5 }])],
  },
  {
    name: 'diff: gh failure',
    fn: 'diff',
    args: { base: B, head: H, changed: true },
    gh: [{ returncode: 1, stderr: 'boom' }],
  },
];

const asFinding = (v: unknown): Finding =>
  Object.fromEntries((parseJsonValue(json(v)) as JsonObject).entries) as unknown as Finding;

function runTs(sc: Scenario): Outcome {
  const calls: string[][] = [];
  const answers = [...(sc.gh ?? [])];
  const gh: GhPort = (argv) => {
    calls.push([...argv]);
    const a = answers.shift() ?? {};
    return {
      returncode: JsonNumber.int(BigInt(a.returncode ?? 0)),
      stdout: a.stdout ?? '',
      stderr: a.stderr ?? '',
    };
  };
  const a = sc.args;
  try {
    let ok: unknown;
    if (sc.fn === 'build') {
      const hunks = a.hunks as Record<string, number[][]> | null;
      const map: HunkMap | null =
        hunks === null
          ? null
          : Object.fromEntries(
              Object.entries(hunks).map(([k, v]) => [
                k,
                v.map(([lo, hi]) => ({ lo: lo as number, hi: hi as number })),
              ]),
            );
      ok = toPlainJson(
        buildReview(
          parseJsonValue(json(a.meta)) as JsonObject,
          (a.findings as unknown[]).map(asFinding),
          map,
        ),
      );
    } else if (sc.fn === 'added') {
      ok = addedRanges(parseJsonValue(json(a.patch))).map((r) => [r.lo, r.hi]);
    } else if (sc.fn === 'load') {
      ok = loadFindings(a.text as string, a.highest as boolean).map((f) =>
        toPlainJson(new JsonObject(Object.entries(f) as Array<[string, JsonValue]>)),
      );
    } else {
      ok = Object.fromEntries(
        Object.entries(
          diffHunks(gh, 'o/r', a.base as string, a.head as string, a.changed as boolean),
        ).map(([k, v]) => [k, v.map((r) => [r.lo, r.hi])]),
      );
    }
    return { ok, calls };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const e = error as Error & { pythonError?: string };
    return { err: e.pythonError ?? e.name, msg: error.message, calls };
  }
}

const oracle = (): Outcome[] => {
  const result = spawnSync('python3', ['-I', ORACLE], {
    input: JSON.stringify(SCENARIOS),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`oracle failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Outcome[];
};

describe.skipIf(!HAVE_PYTHON)('receipt build modes differential against pr_review_findings', () => {
  const expected = HAVE_PYTHON ? oracle() : [];
  test.each(SCENARIOS.map((sc, i) => [sc.name, sc, i] as const))('%s', (_name, sc, i) => {
    expect(runTs(sc)).toEqual(expected[i] as Outcome);
  });

  test('the oracle exercised markers, fallbacks, errors and both range modes', () => {
    const bodies = expected.flatMap((o) => {
      const ok = o.ok as { body?: string; comments?: Array<{ body?: string }> } | undefined;
      return ok?.body === undefined
        ? []
        : [ok.body, ...(ok.comments ?? []).map((c) => c.body ?? '')];
    });
    expect(bodies.some((b) => b.includes('crq-review-thread'))).toBe(true);
    expect(bodies.some((b) => b.includes('body-major=1'))).toBe(true);
    expect(bodies.some((b) => b.includes('Thread anchor is a PR changed line'))).toBe(true);
    expect(bodies.some((b) => b.includes('0 findings'))).toBe(true);
    expect(bodies.some((b) => b.includes('narrow-success'))).toBe(true);
    expect(expected.some((o) => o.err === 'KeyError')).toBe(true);
    expect(expected.some((o) => o.err === 'AttributeError')).toBe(true);
    expect(expected.some((o) => o.err === 'RuntimeError')).toBe(true);
  });
});
