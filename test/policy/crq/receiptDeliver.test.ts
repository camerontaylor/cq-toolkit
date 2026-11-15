/**
 * Differential test of the receipt branch of `deliver` (`prReviewFindings.ts`) against live
 * Python `pr_review_findings.deliver` via `oracle/receipt_deliver_oracle.py`. The receipt
 * collaborators (`prior_receipt`, `prepare`) are canned identically on both sides (they have
 * their own differential tests); identity selection runs for real. Values, result key order,
 * exception class and message, every gh argv and every POST body must match. Skipped where
 * python3 is absent.
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
  deliver,
  type Finding,
  type GhPort,
  type ReceiptHooks,
} from '../../../src/policy/crq/prReviewFindings.js';
import { selectReceiptIdentity } from '../../../src/policy/crq/reviewIdentity.js';

const ORACLE = fileURLToPath(new URL('./oracle/receipt_deliver_oracle.py', import.meta.url));
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;

interface Answer {
  stdout?: string;
  returncode?: number;
  stderr?: string;
}
interface Stub {
  raise?: 'ValueError' | 'RuntimeError';
  msg?: string;
  [key: string]: unknown;
}
interface Scenario {
  name: string;
  meta: Record<string, unknown>;
  findings: Record<string, unknown>[];
  gh?: Answer[];
  login?: string | null;
  pr?: number;
  prior?: Stub | null;
  prepare?: Stub | null;
}
interface Outcome {
  ok?: unknown;
  order?: string[];
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
): Record<string, unknown> => ({ severity, path, start, end, title, text: 'Body text.' });
const META = { run_id: 'r1', base: B, head: H, item_id: 'q1' };
const RECEIPT = { ...META, crq_receipt: true };
const OPEN = { stdout: json({ state: 'open', merged: false, base: B, head: H }) };
const MOVED = { stdout: json({ state: 'open', merged: false, base: B, head: 'c'.repeat(40) }) };
const USER = { stdout: 'cq-rev\n' };
const NONE: Answer = { stdout: '' };
const FILES = {
  stdout: json([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,2 +1,3 @@\n x\n+y\n z\n' },
  ]),
};
const POSTED = { stdout: json({ id: 77, html_url: 'https://x/77' }) };
const REJECT = { returncode: 1, stderr: 'gh: HTTP 422 Unprocessable' };
const PRIOR = {
  id: 9,
  url: 'https://x/9',
  login: 'cq-review[bot]',
  body: `<!-- crq-review-scan run=r1 whole-pr-success body-major=1 -->\n**Independent review (CodeRabbit CLI via crq): ITERATE for \`${H}\`**\n`,
};
const PREPARED = {
  receipt_header: `**Independent review (CodeRabbit CLI via crq): PASS for \`${H}\``.concat('**'),
  receipt_binding: '<!-- crq-review-output {"b":1} -->',
  whole_pr_scan: true,
  receipt_verdict: 'PASS',
};
const MAJOR = [F('major', 'src/a.ts', 2, 2)];

const SCENARIOS: Scenario[] = [
  {
    name: 'created: anchored receipt review with identity extras',
    meta: RECEIPT,
    findings: MAJOR,
    gh: [USER, OPEN, NONE, FILES, POSTED],
    prepare: PREPARED,
  },
  {
    name: 'created: explicit login skips the user lookup',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, NONE, FILES, POSTED],
    prepare: PREPARED,
  },
  {
    name: 'created: receipt with no findings still posts',
    meta: RECEIPT,
    findings: [],
    gh: [USER, OPEN, NONE, FILES, POSTED],
    prepare: PREPARED,
  },
  {
    name: 'created: app login is attested and the identity reason is carried',
    meta: { ...RECEIPT, posting_identity: 'cq-review[bot]', identity_reason: 'because' },
    findings: MAJOR,
    login: 'cq-review[bot]',
    gh: [OPEN, NONE, FILES, POSTED],
    prepare: PREPARED,
  },
  {
    name: 'created: unattested host selection',
    meta: { ...RECEIPT, posting_identity: 'cq-rev', unattested: true },
    findings: MAJOR,
    gh: [USER, OPEN, NONE, FILES, POSTED],
    prepare: { ...PREPARED, whole_pr_scan: false },
  },
  {
    name: 'created: summary skips the fingerprint scan',
    meta: { ...RECEIPT, summary: 'sum' },
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, FILES, POSTED],
    prepare: PREPARED,
  },
  {
    name: 'created: a receipt ignores a fingerprint hit and the run-marker lookup',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, { stdout: json({ id: 4, url: 'u' }) }, FILES, POSTED],
    prepare: PREPARED,
  },
  {
    name: 'created: a malformed fingerprint row still raises',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, { stdout: '[1]' }],
    prepare: PREPARED,
  },
  {
    name: 'created: 422 retries body-only when the head is unchanged',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, NONE, FILES, REJECT, OPEN, POSTED],
    prepare: PREPARED,
  },
  {
    name: 'skipped-head: 422 with a moved head',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, NONE, FILES, REJECT, MOVED],
    prepare: PREPARED,
  },
  {
    name: 'created: 422 on a body-only review is not retried',
    meta: RECEIPT,
    findings: [F('minor', 'zzz', 1, 1)],
    login: 'cq-rev',
    gh: [OPEN, NONE, FILES, REJECT],
    prepare: PREPARED,
  },
  {
    name: 'error: receipt POST without an integer id',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, NONE, FILES, { stdout: json({ id: '7' }) }],
    prepare: PREPARED,
  },
  {
    name: 'error: receipt POST with a boolean id',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, NONE, FILES, { stdout: json({ id: true }) }],
    prepare: PREPARED,
  },
  {
    name: 'error: receipt POST with unparsable output',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, NONE, FILES, { stdout: 'not json' }],
    prepare: PREPARED,
  },
  {
    name: 'error: receipt POST returning a JSON list',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, NONE, FILES, { stdout: '[1]' }],
    prepare: PREPARED,
  },
  {
    name: 'existing: a prior receipt short-circuits before pr_state',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [],
    prior: PRIOR,
  },
  {
    name: 'existing: a prior legacy review reports no verdict',
    meta: RECEIPT,
    findings: [],
    login: 'cq-rev',
    gh: [],
    prior: { id: 3, url: null, login: 'cq-rev', body: 'plain' },
  },
  {
    name: 'existing: a prior receipt found after an identity lookup',
    meta: RECEIPT,
    findings: MAJOR,
    gh: [USER],
    prior: PRIOR,
  },
  {
    name: 'skipped-closed: closed PR',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [{ stdout: json({ state: 'closed', merged: false, base: B, head: H }) }],
  },
  {
    name: 'skipped-closed: merged PR',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [{ stdout: json({ state: 'open', merged: true, base: B, head: H }) }],
  },
  {
    name: 'skipped-head: local review on a moved head',
    meta: { ...RECEIPT, local_review: true },
    findings: MAJOR,
    login: 'cq-rev',
    gh: [MOVED],
  },
  {
    name: 'skipped-no-verdict: prepare declines',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN],
    prepare: null,
  },
  {
    name: 'skipped-empty: non-receipt with no findings never reaches the hooks',
    meta: META,
    findings: [],
    login: 'cq-rev',
    gh: [],
  },
  {
    name: 'created: non-receipt path is unchanged',
    meta: META,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN, NONE, NONE, FILES, POSTED],
  },
  {
    name: 'error: changed posting identity from the selection',
    meta: { ...RECEIPT, posting_identity: 'someone' },
    findings: MAJOR,
    login: 'cq-rev',
    gh: [],
  },
  {
    name: 'error: invalid login precedes the hooks',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'bad login',
    gh: [],
  },
  {
    name: 'error: prior receipt raising propagates',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [],
    prior: { raise: 'ValueError', msg: 'changed CRQ receipt binding' },
  },
  {
    name: 'error: prepare raising propagates',
    meta: RECEIPT,
    findings: MAJOR,
    login: 'cq-rev',
    gh: [OPEN],
    prepare: { raise: 'RuntimeError', msg: 'boom' },
  },
  {
    name: 'error: invalid delivery identity',
    meta: { ...RECEIPT, head: 'short' },
    findings: MAJOR,
    login: 'cq-rev',
    gh: [],
  },
];

const asFinding = (v: unknown): Finding =>
  Object.fromEntries((parseJsonValue(json(v)) as JsonObject).entries) as unknown as Finding;

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v;
const dump = (v: JsonValue): string => JSON.stringify(sortKeys(toPlainJson(v)));

function runTs(sc: Scenario): Outcome {
  const calls: string[][] = [];
  const answers = [...(sc.gh ?? [])];
  const gh: GhPort = (argv, { inputText }) => {
    calls.push([...argv, ...(inputText === null ? [] : [inputText])]);
    const a = answers.shift() ?? {};
    return {
      returncode: JsonNumber.int(BigInt(a.returncode ?? 0)),
      stdout: a.stdout ?? '',
      stderr: a.stderr ?? '',
    };
  };
  const fail = (spec: Stub): never => {
    if (spec.raise === 'ValueError') {
      const e = new Error(spec.msg) as Error & { pythonError?: string };
      e.pythonError = 'ValueError';
      throw e;
    }
    const e = new Error(spec.msg) as Error & { pythonError?: string };
    e.pythonError = 'RuntimeError';
    throw e;
  };
  const hooks: ReceiptHooks = {
    selectIdentity: (g, repo, meta, login) =>
      selectReceiptIdentity({
        repo,
        meta,
        gh: g,
        login,
        injected: true,
        authenticate: () => {
          throw new Error('unreachable: gh is injected');
        },
      }),
    priorReceipt: (_g, repo, pr, meta, login) => {
      calls.push(['prior', repo, String(pr), login, dump(meta)]);
      if (sc.prior?.raise !== undefined) return fail(sc.prior);
      return sc.prior === undefined || sc.prior === null
        ? null
        : (parseJsonValue(json(sc.prior)) as JsonObject);
    },
    prepare: (_g, repo, pr, meta, findings, login) => {
      calls.push([
        'prepare',
        repo,
        String(pr),
        login,
        dump(meta),
        JSON.stringify(
          findings.map((f) =>
            sortKeys(
              Object.fromEntries(
                Object.entries(f).map(([k, v]) => [k, toPlainJson(v as JsonValue)]),
              ),
            ),
          ),
        ),
      ]);
      if (sc.prepare === undefined || sc.prepare === null) return null;
      if (sc.prepare.raise !== undefined) return fail(sc.prepare);
      return new JsonObject([
        ...meta.entries.filter(([k]) => !(k in (sc.prepare as object))),
        ...(parseJsonValue(json(sc.prepare)) as JsonObject).entries,
      ]);
    },
  };
  try {
    const out = deliver({
      repo: 'o/r',
      pr: sc.pr ?? 5,
      meta: parseJsonValue(json(sc.meta)) as JsonObject,
      findings: sc.findings.map(asFinding),
      gh,
      login: sc.login ?? null,
      injected: true,
      receipt: hooks,
    });
    return {
      ok: toPlainJson(new JsonObject(Object.entries(out) as Array<[string, JsonValue]>)),
      order: Object.keys(out),
      calls,
    };
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

describe.skipIf(!HAVE_PYTHON)('receipt deliver differential against pr_review_findings', () => {
  const expected = HAVE_PYTHON ? oracle() : [];
  test.each(SCENARIOS.map((sc, i) => [sc.name, sc, i] as const))('%s', (_name, sc, i) => {
    expect(runTs(sc)).toEqual(expected[i] as Outcome);
  });

  test('the oracle reached every outcome of the receipt branch', () => {
    const states = new Set(expected.map((o) => (o.ok as { state?: string } | undefined)?.state));
    for (const state of [
      'created',
      'existing',
      'skipped-closed',
      'skipped-empty',
      'skipped-head',
      'skipped-no-verdict',
    ])
      expect(states.has(state)).toBe(true);
    expect(expected.filter((o) => o.err === 'ValueError').length).toBeGreaterThanOrEqual(3);
    expect(expected.some((o) => o.err === 'RuntimeError')).toBe(true);
    expect(
      expected.some(
        (o) => (o.ok as { identity?: string } | undefined)?.identity === 'cq-review[bot]',
      ),
    ).toBe(true);
  });
});
