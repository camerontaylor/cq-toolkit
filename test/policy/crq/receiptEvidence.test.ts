/**
 * Differential test of the PR-evidence readers in `receiptEvidence.ts` against the live
 * Python oracle `crq_review_receipt` (via `oracle/receipt_evidence_oracle.py`): the same
 * scripted `gh` answers feed both sides; value, exception class and message, and the
 * full argv sequence must match. Skipped where python3 is absent.
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
import type { GhPort } from '../../../src/policy/crq/prReviewFindings.js';
import {
  ThreadsNotVisible,
  binding,
  bindingMarker,
  bodyMajorAtHead,
  currentMergeBase,
  expectedInlineMajor,
  openMajor,
  ownedReceipt,
  priorReceipt,
  reviews,
} from '../../../src/policy/crq/receiptEvidence.js';

const ORACLE = fileURLToPath(new URL('./oracle/receipt_evidence_oracle.py', import.meta.url));
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;

interface Answer {
  stdout?: string;
  returncode?: number;
  stderr?: string;
}
interface Scenario {
  name: string;
  fn: 'reviews' | 'prior' | 'open_major' | 'expected' | 'body_major' | 'owned' | 'merge_base';
  args: Record<string, unknown>;
  gh: Answer[];
}
interface Outcome {
  ok?: unknown;
  err?: string;
  msg?: string;
  calls: string[][];
}

const json = (v: unknown): string => JSON.stringify(v);
const doc = (v: unknown): JsonValue => parseJsonValue(JSON.stringify(v));
const obj = (v: unknown): JsonObject => doc(v) as JsonObject;
const rows = (v: unknown[]): unknown[] => v;

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const F1 = 'c'.repeat(64);
const F2 = 'd'.repeat(64);
const LOGIN = 'me';
const bound = (run = 'r1', head = H): string =>
  `<!-- crq-review-output ${json({ base: B, head, pr: 7, run_id: run })} -->`;
const proof = (run = 'r1', head = H, findings = [F1]): string =>
  `<!-- crq-review-inline-major ${json({ findings, head, run_id: run })} -->`;
const review = (id: number, body: string, user = LOGIN, extra: Record<string, unknown> = {}) => ({
  id,
  body,
  user: { login: user },
  html_url: `https://x/${id}`,
  ...extra,
});
const page = (...pages: unknown[][]): Answer => ({ stdout: json(pages) });
const META = { run_id: 'r1', base: B, head: H };
const thread = (body: string, extra: Record<string, unknown> = {}, resolved = false) => ({
  id: 't',
  isResolved: resolved,
  comments: {
    nodes: [{ body, author: { login: LOGIN, __typename: 'User' }, pullRequestReview: null }],
  },
  ...extra,
});
const graph = (nodes: unknown[], next: string | null = null): Answer => ({
  stdout: json({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes },
        },
      },
    },
  }),
});
const THREAD = (run = 'r1', head = H, f = F1): string =>
  `x\n<!-- crq-review-thread run=${run} head=${head} finding=${f} -->`;

const receipt = `${bound()}\n${proof()}`;
const SCENARIOS: Scenario[] = [
  {
    name: 'reviews: paginated rows coerce body/user',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [page([{ id: 1, body: null, user: null }], [review(2, 'x')])],
  },
  {
    name: 'reviews: non-list page',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [{ stdout: json([{}]) }],
  },
  {
    name: 'reviews: non-list slurp',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [{ stdout: '{}' }],
  },
  {
    name: 'reviews: bool id',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [page([{ id: true, body: '', user: {} }])],
  },
  {
    name: 'reviews: str id',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [page([{ id: '1' }])],
  },
  { name: 'reviews: row not a dict', fn: 'reviews', args: { repo: 'o/r', pr: 7 }, gh: [page([5])] },
  {
    name: 'reviews: body not str',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [page([{ id: 1, body: 5 }])],
  },
  {
    name: 'reviews: user not dict',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [page([{ id: 1, user: 'x' }])],
  },
  {
    name: 'reviews: gh exit',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [{ returncode: 1, stderr: 'boom' }],
  },
  {
    name: 'reviews: unparsable',
    fn: 'reviews',
    args: { repo: 'o/r', pr: 7 },
    gh: [{ stdout: '{' }],
  },
  {
    name: 'prior: none',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [page([review(1, 'hi')])],
  },
  {
    name: 'prior: bound receipt',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [
      page([
        review(1, `<!-- crq-review run=r1 -->\n${bindingMarker(binding(obj(META), 7))}\nrest`),
      ]),
    ],
  },
  {
    name: 'prior: bot author',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [
      page([
        review(
          1,
          `<!-- crq-review run=r1 -->\n${bindingMarker(binding(obj(META), 7))}`,
          'cq-review[bot]',
        ),
      ]),
    ],
  },
  {
    name: 'prior: foreign author',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [
      page([
        review(1, `<!-- crq-review run=r1 -->\n${bindingMarker(binding(obj(META), 7))}`, 'other'),
      ]),
    ],
  },
  {
    name: 'prior: legacy',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [page([review(1, `<!-- crq-review run=r1 -->\nrange ${B}..${H}`)])],
  },
  {
    name: 'prior: legacy changed',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [page([review(1, '<!-- crq-review run=r1 -->\nrange')])],
  },
  {
    name: 'prior: other run skipped',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [page([review(1, bound('r2'))])],
  },
  {
    name: 'prior: changed binding',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [
      page([
        review(
          1,
          `<!-- crq-review run=r1 -->\n<!-- crq-review-output ${json({ base: B, head: 'f'.repeat(40), pr: 7, run_id: 'r1' })} -->`,
        ),
      ]),
    ],
  },
  {
    name: 'prior: misplaced',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [
      page([review(1, `<!-- crq-review run=r1 -->\nx\n${bindingMarker(binding(obj(META), 7))}`)]),
    ],
  },
  {
    name: 'prior: malformed binding',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [page([review(1, '<!-- crq-review-output nope -->')])],
  },
  {
    name: 'prior: binding list',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [page([review(1, '<!-- crq-review-output [] -->')])],
  },
  {
    name: 'prior: no run_id in binding',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: META, login: LOGIN },
    gh: [page([review(1, `<!-- crq-review-output ${json({ pr: 7 })} -->`)])],
  },
  {
    name: 'prior: meta missing key',
    fn: 'prior',
    args: { repo: 'o/r', pr: 7, meta: { run_id: 'r1' }, login: LOGIN },
    gh: [],
  },
  {
    name: 'expected: proof pairs',
    fn: 'expected',
    args: {
      rows: rows([review(1, `${bound()}\n${proof('r1', H, [F1, F2])}`), review(2, 'x')]),
      pr: 7,
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'expected: other pr ignored',
    fn: 'expected',
    args: {
      rows: rows([
        review(1, `<!-- crq-review-output ${json({ head: H, pr: 8, run_id: 'r1' })} -->`),
      ]),
      pr: 7,
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'expected: missing proof',
    fn: 'expected',
    args: { rows: rows([review(1, bound())]), pr: 7, login: LOGIN },
    gh: [],
  },
  {
    name: 'expected: bad head',
    fn: 'expected',
    args: {
      rows: rows([
        review(1, `<!-- crq-review-output ${json({ head: 'zz', pr: 7, run_id: 'r1' })} -->`),
      ]),
      pr: 7,
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'expected: proof run mismatch',
    fn: 'expected',
    args: { rows: rows([review(1, `${bound()}\n${proof('r2')}`)]), pr: 7, login: LOGIN },
    gh: [],
  },
  {
    name: 'expected: bad finding key',
    fn: 'expected',
    args: {
      rows: rows([review(1, `${bound()}\n${proof('r1', H, ['short'])}`)]),
      pr: 7,
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'expected: malformed json',
    fn: 'expected',
    args: { rows: rows([review(1, '<!-- crq-review-output {x -->')]), pr: 7, login: LOGIN },
    gh: [],
  },
  {
    name: 'expected: bound list',
    fn: 'expected',
    args: { rows: rows([review(1, '<!-- crq-review-output [] -->')]), pr: 7, login: LOGIN },
    gh: [],
  },
  {
    name: 'expected: unowned skipped',
    fn: 'expected',
    args: { rows: rows([review(1, receipt, 'someone')]), pr: 7, login: LOGIN },
    gh: [],
  },
  {
    name: 'expected: bot owned',
    fn: 'expected',
    args: { rows: rows([review(1, receipt, 'cq-review[bot]')]), pr: 7, login: LOGIN },
    gh: [],
  },
  {
    name: 'body_major: true',
    fn: 'body_major',
    args: {
      rows: rows([
        review(1, `${bound()}\n<!-- crq-review-scan run=r1 whole-pr-success body-major=1 -->`),
      ]),
      pr: 7,
      head: H,
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'body_major: narrow',
    fn: 'body_major',
    args: {
      rows: rows([
        review(1, `${bound()}\n<!-- crq-review-scan run=r1 narrow-success body-major=1 -->`),
      ]),
      pr: 7,
      head: H,
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'body_major: other head',
    fn: 'body_major',
    args: {
      rows: rows([
        review(
          1,
          `${bound('r1', B)}\n<!-- crq-review-scan run=r1 whole-pr-success body-major=1 -->`,
        ),
      ]),
      pr: 7,
      head: H,
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'body_major: malformed',
    fn: 'body_major',
    args: { rows: rows([review(1, '<!-- crq-review-output x -->')]), pr: 7, head: H, login: LOGIN },
    gh: [],
  },
  {
    name: 'body_major: none',
    fn: 'body_major',
    args: { rows: rows([review(1, bound())]), pr: 7, head: H, login: LOGIN },
    gh: [],
  },
  { name: 'owned: login', fn: 'owned', args: { row: review(1, 'x'), login: LOGIN }, gh: [] },
  {
    name: 'owned: unattested collaborator',
    fn: 'owned',
    args: {
      row: review(
        1,
        'Unattested: App identity unavailable; posted with the host account.',
        'human',
        { author_association: 'MEMBER' },
      ),
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'owned: unattested bot',
    fn: 'owned',
    args: {
      row: review(
        1,
        'Unattested: App identity unavailable; posted with the host account.',
        'x[bot]',
        { author_association: 'MEMBER' },
      ),
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'owned: unattested none',
    fn: 'owned',
    args: {
      row: review(
        1,
        'Unattested: App identity unavailable; posted with the host account.',
        'human',
        { author_association: 'NONE' },
      ),
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'owned: unhashable association',
    fn: 'owned',
    args: {
      row: review(
        1,
        'Unattested: App identity unavailable; posted with the host account.',
        'human',
        { author_association: ['x'] },
      ),
      login: LOGIN,
    },
    gh: [],
  },
  {
    name: 'owned: empty author',
    fn: 'owned',
    args: { row: { id: 1, body: 'x', user: {} }, login: LOGIN },
    gh: [],
  },
  {
    name: 'owned: user list',
    fn: 'owned',
    args: { row: { id: 1, body: 'x', user: [1] }, login: LOGIN },
    gh: [],
  },
  {
    name: 'open_major: none open',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [graph([thread('hello')])],
  },
  {
    name: 'open_major: open finding',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [graph([thread(`**crq finding F1 [major]**\n${THREAD()}`)])],
  },
  {
    name: 'open_major: resolved finding',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [graph([thread(`**crq finding F1 [major]**\n${THREAD()}`, {}, true)])],
  },
  {
    name: 'open_major: paginates',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [
      graph([thread('a')], 'cur1'),
      graph([thread(`**crq finding F9 [critical]**\n${THREAD()}`)]),
    ],
  },
  {
    name: 'open_major: repeated cursor',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [graph([], 'c'), graph([], 'c')],
  },
  {
    name: 'open_major: errors field',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [{ stdout: json({ errors: [1], data: {} }) }],
  },
  {
    name: 'open_major: bad shape',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [{ stdout: '{}' }],
  },
  {
    name: 'open_major: null body',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [{ stdout: 'null' }],
  },
  {
    name: 'open_major: no comment nodes',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [graph([{ id: 't', isResolved: false, comments: { nodes: [] } }])],
  },
  {
    name: 'open_major: non-bool resolved',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [graph([thread('x', { isResolved: 1 })])],
  },
  {
    name: 'open_major: bot app thread',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [
      graph([
        {
          id: 't',
          isResolved: false,
          comments: {
            nodes: [
              {
                body: `**crq finding F1 [fatal]**\n${THREAD()}`,
                author: { login: 'cq-review', __typename: 'Bot' },
                pullRequestReview: null,
              },
            ],
          },
        },
      ]),
    ],
  },
  {
    name: 'open_major: legacy findings',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [
      graph([
        {
          id: 't',
          isResolved: false,
          comments: {
            nodes: [
              {
                body: '**crq finding F1 [blocker]** x',
                author: { login: LOGIN },
                pullRequestReview: {
                  body: '<!-- crq-findings run=r1 -->\n### crq findings (CodeRabbit CLI, local run x',
                  author: { login: LOGIN },
                },
              },
            ],
          },
        },
      ]),
    ],
  },
  {
    name: 'open_major: unattested fallback',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [
      graph([
        {
          id: 't',
          isResolved: false,
          comments: {
            nodes: [
              {
                body: `**crq finding F1 [major]**\n${THREAD()}`,
                author: { login: 'human' },
                pullRequestReview: {
                  body: 'Unattested: App identity unavailable; posted with the host account.',
                  authorAssociation: 'OWNER',
                  author: { login: 'human' },
                },
              },
            ],
          },
        },
      ]),
    ],
  },
  {
    name: 'open_major: expected visible',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN, rows: rows([review(1, receipt)]) },
    gh: [graph([thread(THREAD())])],
  },
  {
    name: 'open_major: expected hold open',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN, rows: rows([review(1, receipt)]) },
    gh: [graph([thread(THREAD())])],
  },
  {
    name: 'open_major: expected missing',
    fn: 'open_major',
    args: {
      repo: 'o/r',
      pr: 7,
      login: LOGIN,
      rows: rows([review(1, `${bound()}\n${proof('r1', H, [F2, F1])}`)]),
    },
    gh: [graph([thread(THREAD())])],
  },
  {
    name: 'open_major: expected incomplete inventory',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN, rows: rows([review(1, receipt)]) },
    gh: [{ stdout: '{}' }],
  },
  {
    name: 'open_major: expected cursor wait',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN, rows: rows([review(1, receipt)]) },
    gh: [graph([], 'c1'), { stdout: '{}' }],
  },
  {
    name: 'open_major: gh failure',
    fn: 'open_major',
    args: { repo: 'o/r', pr: 7, login: LOGIN },
    gh: [{ returncode: 1, stderr: 'no' }],
  },
  {
    name: 'merge_base: ok',
    fn: 'merge_base',
    args: { repo: 'o/r', base: B, head: H },
    gh: [{ stdout: `${B}\n` }],
  },
  {
    name: 'merge_base: invalid',
    fn: 'merge_base',
    args: { repo: 'o/r', base: B, head: H },
    gh: [{ stdout: 'nope' }],
  },
  {
    name: 'merge_base: empty',
    fn: 'merge_base',
    args: { repo: 'o/r', base: B, head: H },
    gh: [{ stdout: '' }],
  },
];

function runTs(sc: Scenario): Outcome {
  const calls: string[][] = [];
  const answers = [...sc.gh];
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
  const login = a.login as string;
  const asRows = (): JsonObject[] => ((a.rows as unknown[] | undefined) ?? []).map(obj);
  try {
    let out: unknown;
    switch (sc.fn) {
      case 'reviews':
        out = reviews(gh, a.repo as string, a.pr as number).map((row) => toPlainJson(row));
        break;
      case 'prior': {
        const found = priorReceipt(gh, a.repo as string, a.pr as number, obj(a.meta), login);
        out = found === null ? null : toPlainJson(found);
        break;
      }
      case 'open_major': {
        const expected = a.rows ? expectedInlineMajor(asRows(), a.pr as number, login) : undefined;
        out = openMajor(gh, a.repo as string, a.pr as number, login, expected);
        break;
      }
      case 'expected': {
        const e = expectedInlineMajor(asRows(), a.pr as number, login);
        out = [...e.values()]
          .map(({ key, sources }) => [
            [...key],
            sources.map((s) =>
              toPlainJson(
                new JsonObject([
                  ['review_id', s.review_id],
                  ['url', s.url],
                ]),
              ),
            ),
          ])
          .sort((x, y) => JSON.stringify(x[0]).localeCompare(JSON.stringify(y[0])));
        break;
      }
      case 'body_major':
        out = bodyMajorAtHead(asRows(), a.pr as number, a.head as string, login);
        break;
      case 'owned':
        out = ownedReceipt(obj(a.row), login);
        break;
      case 'merge_base':
        out = currentMergeBase(gh, a.repo as string, a.base as string, a.head as string);
        break;
    }
    return { ok: out, calls };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const e = error as Error & { pythonError?: string };
    const name =
      error instanceof ThreadsNotVisible ? 'ThreadsNotVisible' : (e.pythonError ?? e.name);
    return { err: name, msg: error.message, calls };
  }
}

const oracle = (): Outcome[] => {
  const result = spawnSync('python3', ['-I', ORACLE], {
    input: JSON.stringify(SCENARIOS),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`oracle failed: ${result.stderr}`);
  // Python 3.15 prefixes unhashable set-membership errors; the production minor (3.14) does not.
  return (JSON.parse(result.stdout) as Outcome[]).map((o) =>
    o.msg === undefined
      ? o
      : { ...o, msg: o.msg.replace(/^cannot use '[^']*' as a set element \((.*)\)$/, '$1') },
  );
};

describe.skipIf(!HAVE_PYTHON)('receipt evidence differential against crq_review_receipt', () => {
  const expected = HAVE_PYTHON ? oracle() : [];
  test.each(SCENARIOS.map((sc, i) => [sc.name, sc, i] as const))('%s', (_name, sc, i) => {
    const want = expected[i] as Outcome;
    const got = runTs(sc);
    // The oracle's expected-map keys are tuples; compare through the same JSON shape.
    expect(got).toEqual(want);
  });

  test('the oracle itself exercised both ok and error paths', () => {
    expect(expected.some((o) => o.err === 'ThreadsNotVisible')).toBe(true);
    expect(expected.some((o) => o.ok === true)).toBe(true);
    expect(expected.some((o) => o.err === 'KeyError')).toBe(true);
  });
});
