/**
 * Differential test of `prepare` and `refresh` in `receiptPrepare.ts` against the live
 * Python oracle `crq_review_receipt` (via `oracle/receipt_prepare_oracle.py`): the run
 * artifacts are real temp files on the Python side and an in-memory map on the TS side;
 * `gh` is scripted identically. Value, exception class and message, and every argv must
 * match. Skipped where python3 is absent.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
} from '../../../src/policy/crq/jsonValue.js';
import type { GhPort } from '../../../src/policy/crq/prReviewFindings.js';
import { ThreadsNotVisible } from '../../../src/policy/crq/receiptEvidence.js';
import { pathParent, prepare, refresh } from '../../../src/policy/crq/receiptPrepare.js';

const ORACLE = fileURLToPath(new URL('./oracle/receipt_prepare_oracle.py', import.meta.url));
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;

interface Answer {
  stdout?: string;
  returncode?: number;
  stderr?: string;
}
type Files = Record<string, string | { bytes: number[] }>;
interface Scenario {
  name: string;
  fn: 'prepare' | 'refresh';
  args: Record<string, unknown>;
  files?: Files;
  gh: Answer[];
}
interface Outcome {
  ok?: unknown;
  err?: string;
  msg?: string;
  calls: string[][];
}

const json = (v: unknown): string => JSON.stringify(v);
const obj = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const LOGIN = 'me';
const META = { run_id: 'r1', base: B, head: H };
const state = (over: Record<string, unknown> = {}): Answer => ({
  stdout: json({ state: 'open', merged: false, base: 'c'.repeat(40), head: H, ...over }),
});
const mergeBase = (sha = B): Answer => ({ stdout: `${sha}\n` });
const page = (...rows: unknown[]): Answer => ({ stdout: json([rows]) });
const graph = (nodes: unknown[] = []): Answer => ({
  stdout: json({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
        },
      },
    },
  }),
});
const bound = `<!-- crq-review-output ${json({ base: B, head: H, pr: 7, run_id: 'r1' })} -->\n<!-- crq-review-inline-major ${json({ findings: [], head: H, run_id: 'r1' })} -->`;
const verdictLine = (v: string, head = H): string =>
  `**Independent review (CodeRabbit CLI via crq): ${v} for \`${head}\`**`;
const row = (id: number, body: string, at: string | null, user = LOGIN) => ({
  id,
  body,
  user: { login: user },
  html_url: `https://x/${id}`,
  submitted_at: at,
});
const ITERATE_BODY = `${bound}\n<!-- crq-review-scan run=r1 whole-pr-success -->\n${verdictLine('ITERATE')}`;
const CREATED: Answer = { stdout: json({ id: 99, html_url: 'https://x/99' }) };

const COMPLETE = json({ type: 'complete', status: 'review_completed' });
const DONE = `${COMPLETE}\n`;
const good = (extra: Files = {}): Files => ({
  'meta.json': json({ run_id: 'r1', base: B, head: H, range_policy: 'full-range-once-v1' }),
  'exit.json': json({ exit: 0 }),
  'review.ndjson': DONE,
  ...extra,
});
const P = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repo: 'o/r',
  pr: 7,
  meta: META,
  findings: [],
  login: LOGIN,
  ...over,
});
const R = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repo: 'o/r',
  pr: 7,
  meta: META,
  login: LOGIN,
  ...over,
});
const tail = (...extra: Answer[]): Answer[] => [state(), mergeBase(), page(), graph(), ...extra];

const SCENARIOS: Scenario[] = [
  { name: 'prepare: PASS', fn: 'prepare', args: P(), files: good(), gh: tail() },
  {
    name: 'prepare: ITERATE on a blocking finding',
    fn: 'prepare',
    args: P({ findings: [{ severity: 'Major' }] }),
    files: good(),
    gh: tail(),
  },
  {
    name: 'prepare: minor finding still PASS',
    fn: 'prepare',
    args: P({ findings: [{ severity: 'minor' }] }),
    files: good(),
    gh: tail(),
  },
  {
    name: 'prepare: finding without severity',
    fn: 'prepare',
    args: P({ findings: [{}] }),
    files: good(),
    gh: tail(),
  },
  {
    name: 'prepare: non-string severity',
    fn: 'prepare',
    args: P({ findings: [{ severity: 3 }] }),
    files: good(),
    gh: tail(),
  },
  {
    name: 'prepare: not full-range policy',
    fn: 'prepare',
    args: P(),
    files: good({ 'meta.json': json({ run_id: 'r1', base: B, head: H }) }),
    gh: tail(),
  },
  {
    name: 'prepare: merge base differs',
    fn: 'prepare',
    args: P(),
    files: good(),
    gh: [state(), mergeBase('e'.repeat(40)), page(), graph()],
  },
  {
    name: 'prepare: PR head moved',
    fn: 'prepare',
    args: P(),
    files: good(),
    gh: [state({ head: 'f'.repeat(40) })],
  },
  {
    name: 'prepare: body major at head',
    fn: 'prepare',
    args: P(),
    files: good(),
    gh: [
      state(),
      mergeBase(),
      page(
        row(
          1,
          `${bound}\n<!-- crq-review-output ${json({ base: B, head: H, pr: 7, run_id: 'r1' })} body-major=1 -->`,
          '2026-01-01T00:00:00Z',
        ),
      ),
      graph(),
    ],
  },
  { name: 'prepare: missing meta.json', fn: 'prepare', args: P(), files: {}, gh: [] },
  {
    name: 'prepare: missing exit.json',
    fn: 'prepare',
    args: P(),
    files: { 'meta.json': good()['meta.json'] as string },
    gh: [],
  },
  {
    name: 'prepare: missing ndjson classifies as not counted',
    fn: 'prepare',
    args: P(),
    files: { 'meta.json': good()['meta.json'] as string, 'exit.json': json({ exit: 0 }) },
    gh: [],
  },
  {
    name: 'prepare: meta not an object',
    fn: 'prepare',
    args: P(),
    files: good({ 'meta.json': '[]' }),
    gh: [],
  },
  {
    name: 'prepare: changed run id',
    fn: 'prepare',
    args: P(),
    files: good({ 'meta.json': json({ run_id: 'other', base: B, head: H }) }),
    gh: [],
  },
  {
    name: 'prepare: changed repo (case-insensitive match passes)',
    fn: 'prepare',
    args: P(),
    files: good({
      'meta.json': json({
        run_id: 'r1',
        base: B,
        head: H,
        repo: 'O/R',
        pr: 7,
        range_policy: 'full-range-once-v1',
      }),
    }),
    gh: tail(),
  },
  {
    name: 'prepare: changed repo rejected',
    fn: 'prepare',
    args: P(),
    files: good({ 'meta.json': json({ run_id: 'r1', base: B, head: H, repo: 'x/y' }) }),
    gh: [],
  },
  {
    name: 'prepare: changed pr rejected',
    fn: 'prepare',
    args: P(),
    files: good({ 'meta.json': json({ run_id: 'r1', base: B, head: H, pr: 8 }) }),
    gh: [],
  },
  {
    name: 'prepare: non-string saved repo',
    fn: 'prepare',
    args: P(),
    files: good({ 'meta.json': json({ run_id: 'r1', base: B, head: H, repo: 5 }) }),
    gh: [],
  },
  {
    name: 'prepare: exit not an object',
    fn: 'prepare',
    args: P(),
    files: good({ 'exit.json': '3' }),
    gh: [],
  },
  {
    name: 'prepare: nonzero exit is not completed',
    fn: 'prepare',
    args: P(),
    files: good({ 'exit.json': json({ exit: 1 }) }),
    gh: [],
  },
  {
    name: 'prepare: bool exit is not an int',
    fn: 'prepare',
    args: P(),
    files: good({ 'exit.json': json({ exit: true }) }),
    gh: [],
  },
  {
    name: 'prepare: partial event',
    fn: 'prepare',
    args: P(),
    files: good({
      'review.ndjson': `${json({ type: 'finding', severity: 'minor', partial: true })}\n${DONE}`,
    }),
    gh: [],
  },
  {
    name: 'prepare: truncated event',
    fn: 'prepare',
    args: P(),
    files: good({
      'review.ndjson': `${DONE}${json({ type: 'finding', severity: 'minor', truncated: true })}\n`,
    }),
    gh: [],
  },
  {
    name: 'prepare: blank and CRLF lines',
    fn: 'prepare',
    args: P(),
    files: good({ 'review.ndjson': `\n  \r\n${COMPLETE}\r\n` }),
    gh: tail(),
  },
  {
    name: 'prepare: unicode line separator splits events',
    fn: 'prepare',
    args: P(),
    files: good({
      'review.ndjson': `${COMPLETE} ${COMPLETE}\n`,
    }),
    gh: tail(),
  },
  {
    name: 'prepare: invalid json meta',
    fn: 'prepare',
    args: P(),
    files: good({ 'meta.json': '{' }),
    gh: [],
  },
  {
    name: 'prepare: gh failure',
    fn: 'prepare',
    args: P(),
    files: good(),
    gh: [{ returncode: 1, stderr: 'boom' }],
  },
  { name: 'refresh: head moved', fn: 'refresh', args: R(), gh: [state({ head: 'f'.repeat(40) })] },
  { name: 'refresh: closed', fn: 'refresh', args: R(), gh: [state({ state: 'closed' })] },
  { name: 'refresh: merged', fn: 'refresh', args: R(), gh: [state({ merged: true })] },
  {
    name: 'refresh: range moved',
    fn: 'refresh',
    args: R(),
    gh: [state(), mergeBase('e'.repeat(40))],
  },
  {
    name: 'refresh: no receipt',
    fn: 'refresh',
    args: R(),
    gh: [state(), mergeBase(), page(row(1, 'plain', '2026-01-01T00:00:00Z'))],
  },
  {
    name: 'refresh: verdict text mid-line is not a receipt',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, `${bound}\nnote ${verdictLine('PASS')} trailing`, '2026-01-01T00:00:00Z')),
    ],
  },
  {
    name: 'refresh: existing PASS',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, `${bound}\n${verdictLine('PASS')}`, '2026-01-01T00:00:00Z')),
    ],
  },
  {
    name: 'refresh: existing PASS by app, other head ignored',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(
        row(1, `${bound}\n${verdictLine('PASS', 'f'.repeat(40))}`, '2026-01-01T00:00:00Z'),
        row(2, `${bound}\n${verdictLine('PASS')}`, '2026-01-02T00:00:00+00:00', 'cq-review[bot]'),
      ),
    ],
  },
  {
    name: 'refresh: foreign author ignored',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, `${bound}\n${verdictLine('PASS')}`, '2026-01-01T00:00:00Z', 'someone')),
    ],
  },
  {
    name: 'refresh: created',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z')),
      graph(),
      CREATED,
    ],
  },
  {
    name: 'refresh: created with unattested note and url supersede',
    fn: 'refresh',
    args: R({ meta: { ...META, unattested: true, identity_reason: 'why' } }),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z')),
      graph(),
      CREATED,
    ],
  },
  {
    name: 'refresh: created by app identity',
    fn: 'refresh',
    args: R({ login: 'cq-review[bot]' }),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z', 'cq-review[bot]')),
      graph(),
      CREATED,
    ],
  },
  {
    name: 'refresh: prior refresh marker already exists',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(
        row(1, ITERATE_BODY, '2026-01-01T00:00:00Z'),
        row(
          2,
          `<!-- crq-verdict-refresh head=${H} scan-run=r1 -->\n${verdictLine('ITERATE')}`,
          '2026-01-02T00:00:00Z',
        ),
      ),
      graph(),
    ],
  },
  {
    name: 'refresh: body major in latest',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, `${ITERATE_BODY}\n<!-- x body-major=1 -->`, '2026-01-01T00:00:00Z')),
    ],
  },
  {
    name: 'refresh: no whole-pr proof',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, `${bound}\n${verdictLine('ITERATE')}`, '2026-01-01T00:00:00Z')),
    ],
  },
  {
    name: 'refresh: pending threads',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z')),
      graph([
        {
          id: 't',
          isResolved: false,
          comments: {
            nodes: [
              {
                body: `**crq finding F1 [major]**\n<!-- crq-review-thread run=r1 head=${H} finding=${'c'.repeat(64)} -->`,
                author: { login: LOGIN, __typename: 'User' },
                pullRequestReview: null,
              },
            ],
          },
        },
      ]),
    ],
  },
  {
    name: 'refresh: ambiguous chronology',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(
        row(1, ITERATE_BODY, '2026-01-01T00:00:00Z'),
        row(2, `${bound}\n${verdictLine('PASS')}`, '2026-01-01T00:00:00+00:00'),
      ),
    ],
  },
  {
    name: 'refresh: equal times same verdict is not ambiguous',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(
        row(1, `${bound}\n${verdictLine('PASS')}`, '2026-01-01T00:00:00Z'),
        row(2, `${bound}\n${verdictLine('PASS')}`, '2026-01-01T00:00:00Z'),
      ),
    ],
  },
  {
    name: 'refresh: offset timestamps order the latest',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(
        row(1, `${bound}\n${verdictLine('PASS')}`, '2026-01-01T05:00:00+05:00'),
        row(2, ITERATE_BODY, '2026-01-01T00:30:00+00:00'),
      ),
      graph(),
      CREATED,
    ],
  },
  {
    name: 'refresh: fractional seconds order',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(
        row(1, ITERATE_BODY, '2026-01-01T00:00:00.500000Z'),
        row(2, `${bound}\n${verdictLine('PASS')}`, '2026-01-01T00:00:00.250Z'),
      ),
      graph(),
      CREATED,
    ],
  },
  {
    name: 'refresh: missing chronology',
    fn: 'refresh',
    args: R(),
    gh: [state(), mergeBase(), page(row(1, `${bound}\n${verdictLine('PASS')}`, null))],
  },
  {
    name: 'refresh: naive timestamp',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, `${bound}\n${verdictLine('PASS')}`, '2026-01-01T00:00:00')),
    ],
  },
  {
    name: 'refresh: garbage timestamp',
    fn: 'refresh',
    args: R(),
    gh: [state(), mergeBase(), page(row(1, `${bound}\n${verdictLine('PASS')}`, 'yesterday'))],
  },
  {
    name: 'refresh: POST returns no id',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z')),
      graph(),
      { stdout: '{}' },
    ],
  },
  {
    name: 'refresh: POST returns bool id',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z')),
      graph(),
      { stdout: json({ id: true }) },
    ],
  },
  {
    name: 'refresh: POST returns non-object',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z')),
      graph(),
      { stdout: '[]' },
    ],
  },
  {
    name: 'refresh: POST returns empty body',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z')),
      graph(),
      { stdout: '' },
    ],
  },
  {
    name: 'refresh: POST fails',
    fn: 'refresh',
    args: R(),
    gh: [
      state(),
      mergeBase(),
      page(row(1, ITERATE_BODY, '2026-01-01T00:00:00Z')),
      graph(),
      { returncode: 1, stderr: 'denied' },
    ],
  },
];

const DIR = '<D>';
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
  const files = {
    readBytes: (path: string): Uint8Array | null => {
      const name = path.slice(DIR.length + 1);
      const text = sc.files?.[name];
      if (text === undefined) return null;
      return typeof text === 'string'
        ? new TextEncoder().encode(text)
        : Uint8Array.from(text.bytes);
    },
  };
  const a = sc.args;
  try {
    const out: JsonObject | null =
      sc.fn === 'prepare'
        ? prepare(
            gh,
            files,
            a.repo as string,
            a.pr as number,
            obj(a.meta),
            `${DIR}/review.ndjson`,
            (a.findings as unknown[]).map(obj),
            a.login as string,
          )
        : refresh(gh, a.repo as string, a.pr as number, obj(a.meta), a.login as string);
    return { ok: out === null ? null : toPlainJson(out), calls };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const e = error as Error & { pythonError?: string };
    return {
      err: error instanceof ThreadsNotVisible ? 'ThreadsNotVisible' : (e.pythonError ?? e.name),
      msg: error.message,
      calls,
    };
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

// The only intended differences: Python's JSON error position text, and the host's Python
// minor (3.15 prefixes unhashable set-membership errors that 3.14 does not).
const normalise = (o: Outcome): Outcome =>
  o.msg === undefined
    ? o
    : {
        ...o,
        msg:
          o.err === 'JSONDecodeError'
            ? 'JSON'
            : o.msg.replace(/^cannot use '[^']*' as a set element \((.*)\)$/, '$1'),
      };

describe.skipIf(!HAVE_PYTHON)(
  'receipt prepare/refresh differential against crq_review_receipt',
  () => {
    const expected = HAVE_PYTHON ? oracle() : [];
    test.each(SCENARIOS.map((sc, i) => [sc.name, sc, i] as const))('%s', (_name, sc, i) => {
      expect(normalise(runTs(sc))).toEqual(normalise(expected[i] as Outcome));
    });

    test('the oracle exercised verdicts, skips, creation and errors', () => {
      const ok = expected.flatMap((o) =>
        o.ok === undefined ? [] : [o.ok as Record<string, unknown> | null],
      );
      expect(ok.some((o) => o?.receipt_verdict === 'PASS')).toBe(true);
      expect(ok.some((o) => o?.receipt_verdict === 'ITERATE')).toBe(true);
      expect(ok.some((o) => o === null)).toBe(true);
      expect(ok.some((o) => o?.state === 'created')).toBe(true);
      expect(ok.some((o) => o?.state === 'existing')).toBe(true);
      expect(expected.some((o) => o.err === 'RuntimeError')).toBe(true);
      expect(expected.some((o) => o.err === 'FileNotFoundError')).toBe(true);
    });
  },
);

describe('pathParent', () => {
  test.each([
    ['/a/b/review.ndjson', '/a/b'],
    ['review.ndjson', '.'],
    ['/review.ndjson', '/'],
    ['a//b/./c', 'a/b'],
  ])('%s', (input, want) => {
    expect(pathParent(input)).toBe(want);
  });
});
