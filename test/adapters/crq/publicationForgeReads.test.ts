// Differential run: scripted `gh` transcripts through Python's real `crq.pr_info`,
// `crq.gh_json` and `repair_tick.recover_publication` (the oracle is
// test/helpers/publicationForgeReadsOracle.py, `subprocess.run` replaced by the
// fake transport) and through the TS forge reads driving the real
// `recoverPublication`. Argv, working directory, timeout, outcome class and the
// consumer-visible events must be equal. No forge, network or process is
// touched by any case: every `gh` is a scripted function; two cases spawn a
// throwaway shell stub through the real runner to pin its exit-code contract.
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  forgePublicationReads,
  type GhRequest,
  type PublicationForgeReads,
} from '../../../src/adapters/crq/publicationForgeReads.js';
import { makeGhRunner, type GhFn } from '../../../src/adapters/forge-github/gh.js';
import { ForgeBudget, RefreshExhausted } from '../../../src/policy/crq/forgeBudget.js';
import { JsonNumber } from '../../../src/policy/crq/jsonValue.js';
import { isPyError, PyError } from '../../../src/queue-runner/pyErrors.js';
import {
  recoverPublication,
  type PublicationRecoveryEffects,
} from '../../../src/queue-runner/publicationRecovery.js';
import type { PublicationFinalizeEffects } from '../../../src/queue-runner/publicationFinalize.js';
import type { PublicationPublishEffects } from '../../../src/queue-runner/publicationPublish.js';

const ORACLE = fileURLToPath(
  new URL('../../helpers/publicationForgeReadsOracle.py', import.meta.url),
);
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));
const CLONE = '/placeholder/clone';
const REPO = 'camerontaylor/example';

// The structural subset every publication orchestration declares.
type Pinned = Pick<PublicationPublishEffects, keyof PublicationForgeReads> &
  Pick<PublicationRecoveryEffects, keyof PublicationForgeReads> &
  Pick<PublicationFinalizeEffects, 'listBranchPrs'>;
const pinned = (reads: PublicationForgeReads): Pinned => reads;

type Step =
  | { exit: number; stdout?: string; stderr?: string }
  | { timeout: true }
  | { missing: true };

const out = (stdout: string): Step => ({ exit: 0, stdout });
const fail = (exit: number, stderr: string): Step => ({ exit, stderr });
const TIMEOUT: Step = { timeout: true };
const MISSING: Step = { missing: true };

interface Call {
  argv: string[];
  cwd: string | null;
  timeoutMs: number;
}

/** The scripted `GhFn` factory: the TS twin of the oracle's fake `subprocess.run`. */
function scripted(script: readonly Step[], calls: Call[]): (request: GhRequest) => GhFn {
  const queue = [...script];
  return (request) => async (args) => {
    calls.push({ argv: ['gh', ...args], cwd: request.cwd, timeoutMs: request.timeoutMs });
    const step = queue.shift();
    if (step === undefined) throw new Error('transport script exhausted');
    if ('timeout' in step)
      return {
        code: 124,
        stdout: '',
        stderr: `\ngh timed out after ${String(request.timeoutMs)}ms`,
      };
    if ('missing' in step) return { code: 127, stdout: '', stderr: 'executable not found: gh' };
    return { code: step.exit, stdout: step.stdout ?? '', stderr: step.stderr ?? '' };
  };
}

interface Budget {
  requests: number;
  seconds: number;
}

interface OracleCase {
  name: string;
  op: 'pr_info' | 'branch_prs' | 'recover';
  script: Step[];
  budget?: Budget;
  pr?: unknown;
  branch?: string;
  item?: Record<string, unknown>;
  publication?: Record<string, unknown>;
  record?: Record<string, unknown>;
  ls_remote?: string;
  ancestors?: Record<string, boolean>;
}

interface OraclePayload {
  ok?: unknown;
  error?: string;
  message?: string;
  calls: { argv: string[]; cwd: string | null; timeout: number | null }[];
}

interface Outcome {
  ok?: unknown;
  error?: string;
  message?: string;
  calls: Call[];
}

const budgetOf = (budget: Budget | undefined): ForgeBudget | undefined =>
  budget === undefined
    ? undefined
    : new ForgeBudget({ requests: budget.requests, seconds: budget.seconds, clock: () => 100 });

/** Non-finite floats in the oracle's strict-JSON spelling. */
function clean(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value))
    return { $float: Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf' };
  if (Array.isArray(value)) return value.map(clean);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)]));
  return value;
}

function runOracle(cases: OracleCase[], python = 'python3'): OraclePayload[] {
  const stdout = execFileSync(python, ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', LC_ALL: 'C.UTF-8' },
  });
  return (JSON.parse(stdout) as { results: OraclePayload[] }).results;
}

function errorClass(error: unknown): string {
  if (error instanceof PyError) return error.kind;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

async function runTs(item: OracleCase): Promise<Outcome> {
  const calls: Call[] = [];
  const reads = forgePublicationReads({
    repo: REPO,
    clone: CLONE,
    ...(item.budget === undefined ? {} : { budget: budgetOf(item.budget) as ForgeBudget }),
    ghFor: scripted(item.script, calls),
  });
  try {
    if (item.op === 'pr_info') return { ok: clean(await reads.prInfo(item.pr)), calls };
    if (item.op === 'branch_prs')
      return { ok: clean(await reads.listBranchPrs(item.branch as string)), calls };
    const events: unknown[][] = [];
    const record = { ...item.record };
    const ancestors = item.ancestors ?? {};
    const effects: PublicationRecoveryEffects = {
      lsRemoteHeads: (branch) => {
        events.push(['ls-remote', `refs/heads/${branch}`]);
        return Promise.resolve(item.ls_remote ?? '');
      },
      prInfo: (pr) => reads.prInfo(pr),
      listBranchPrs: (branch) => reads.listBranchPrs(branch),
      isAncestor: (older, newer) => {
        events.push(['is_ancestor', older, newer]);
        return Promise.resolve(ancestors[`${older}>${newer}`] === true);
      },
      push: (branch, expected, sha) => {
        events.push([
          'git',
          'push',
          'origin',
          `--force-with-lease=refs/heads/${branch}:${expected}`,
          `${sha}:refs/heads/${branch}`,
        ]);
        return Promise.resolve();
      },
      finalize: () => {
        events.push(['finalize']);
        return Promise.resolve();
      },
    };
    await recoverPublication(effects, item.item ?? {}, record, item.publication ?? {});
    return { ok: { events, record }, calls };
  } catch (error) {
    return {
      error: errorClass(error),
      message: error instanceof Error ? error.message : String(error),
      calls,
    };
  }
}

// What each Python exception class is on the TS side. `TimeoutExpired` and
// `FileNotFoundError` are `OSError`s in Python and `PyError('OSError')` here;
// `JSONDecodeError` is a `ValueError` whose text is the parser's, not CPython's.
const CLASS: Record<string, string> = {
  TimeoutExpired: 'OSError',
  FileNotFoundError: 'OSError',
  JSONDecodeError: 'ValueError',
};
const TEXT_DIFFERS = new Set(['JSONDecodeError']);

const PR_VIEW = [
  'gh',
  'pr',
  'view',
  '5',
  '--repo',
  REPO,
  '--json',
  'number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt',
];

const FULL_INFO =
  '{"number":5,"state":"OPEN","isDraft":false,"headRefName":"fix/b","headRefOid":"abc","baseRefName":"main","updatedAt":"2026-11-20T00:00:00Z","mergeCommit":null,"mergedAt":null}';
const LONG_ASTRAL = '😀'.repeat(500);

const pub = { head: 'h', branch: 'b', open_pr: true, target: 't' };
const noPr = { ...pub, open_pr: false };
const openCase = (name: string, script: Step[], extra: Partial<OracleCase> = {}): OracleCase => ({
  name,
  op: 'recover',
  item: { pr: 5 },
  publication: pub,
  script,
  ...extra,
});
const branchCase = (name: string, script: Step[], extra: Partial<OracleCase> = {}): OracleCase => ({
  name,
  op: 'recover',
  item: { pr: 5 },
  publication: noPr,
  script,
  ...extra,
});
const info = (fields: string): Step => out(`{${fields}}`);

const CASES: OracleCase[] = [
  // --- pr_info: the transport, the failure classes and the printed value
  { name: 'every field of an open PR', op: 'pr_info', pr: 5, script: [out(FULL_INFO)] },
  {
    name: 'only the keys gh printed come back',
    op: 'pr_info',
    pr: 5,
    script: [info('"state":"OPEN"')],
  },
  { name: 'the PR argument as a string', op: 'pr_info', pr: '5', script: [out(FULL_INFO)] },
  { name: 'an empty object', op: 'pr_info', pr: 5, script: [out('{}')] },
  {
    name: 'duplicate keys keep the last value',
    op: 'pr_info',
    pr: 5,
    script: [info('"state":"CLOSED","state":"OPEN"')],
  },
  {
    name: 'NaN and Infinity parse as json.loads does',
    op: 'pr_info',
    pr: 5,
    script: [info('"updatedAt":NaN,"n":-Infinity,"m":Infinity')],
  },
  {
    name: 'surrounding whitespace and an escaped astral character',
    op: 'pr_info',
    pr: 5,
    script: [out(' \n{"state":"OPEN","t":"\\ud83d\\ude00"}\n')],
  },
  {
    name: 'a non-zero exit is a RuntimeError with the stripped, universal-newline stderr',
    op: 'pr_info',
    pr: 5,
    script: [fail(1, '\r\n  HTTP 404: not found\r\nline two  \r\r\n')],
  },
  { name: 'a non-zero exit with no stderr', op: 'pr_info', pr: 5, script: [fail(2, '')] },
  {
    name: 'stderr past 400 code points is cut by code point',
    op: 'pr_info',
    pr: 5,
    script: [fail(1, LONG_ASTRAL)],
  },
  {
    name: 'stderr strips Unicode whitespace and keeps the inside',
    op: 'pr_info',
    pr: 5,
    script: [fail(1, '   gh: x y 　\n')],
  },
  {
    name: 'gh exiting 124 itself, without the runner marker, is an exit failure',
    op: 'pr_info',
    pr: 5,
    script: [fail(124, 'gh: its own 124')],
  },
  { name: 'the time bound is TimeoutExpired, an OSError', op: 'pr_info', pr: 5, script: [TIMEOUT] },
  {
    name: 'a missing gh is FileNotFoundError, an OSError',
    op: 'pr_info',
    pr: 5,
    script: [MISSING],
  },
  { name: 'empty output is not JSON', op: 'pr_info', pr: 5, script: [out('')] },
  { name: 'prose output is not JSON', op: 'pr_info', pr: 5, script: [out('not json')] },
  { name: 'truncated output is not JSON', op: 'pr_info', pr: 5, script: [out('{"state"')] },
  {
    name: 'trailing data after the value is not JSON',
    op: 'pr_info',
    pr: 5,
    script: [out('{} {}')],
  },
  { name: 'a byte-order mark is not JSON', op: 'pr_info', pr: 5, script: [out('﻿{}')] },
  // --- the forge window: one request each, the clamp, and exhaustion
  {
    name: 'a window clamps the request to 10 seconds',
    op: 'pr_info',
    pr: 5,
    script: [out(FULL_INFO)],
    budget: { requests: 1, seconds: 30 },
  },
  {
    name: 'a window shorter than 10 seconds bounds the request',
    op: 'pr_info',
    pr: 5,
    script: [out(FULL_INFO)],
    budget: { requests: 1, seconds: 4.5 },
  },
  {
    name: 'a nearly spent window still yields the 1 ms floor',
    op: 'pr_info',
    pr: 5,
    script: [out(FULL_INFO)],
    budget: { requests: 1, seconds: 0.0004 },
  },
  {
    name: 'a timeout under a window reports its float seconds',
    op: 'pr_info',
    pr: 5,
    script: [TIMEOUT],
    budget: { requests: 1, seconds: 4.5 },
  },
  {
    name: 'a timeout under the clamp reports 10 seconds',
    op: 'pr_info',
    pr: 5,
    script: [TIMEOUT],
    budget: { requests: 1, seconds: 30 },
  },
  {
    name: 'an exhausted window refuses before any request',
    op: 'pr_info',
    pr: 5,
    script: [],
    budget: { requests: 0, seconds: 30 },
  },
  {
    name: 'a window with no seconds refuses before any request',
    op: 'pr_info',
    pr: 5,
    script: [],
    budget: { requests: 3, seconds: 0 },
  },
  // --- branch_prs: argv, rows and failures
  {
    name: 'one row',
    op: 'branch_prs',
    branch: 'fix/crq-1',
    script: [out('[{"number":7,"url":"https://x/7","state":"OPEN","headRefOid":"h"}]')],
  },
  { name: 'no rows', op: 'branch_prs', branch: 'fix/crq-1', script: [out('[]')] },
  {
    name: 'several rows with an unprinted key',
    op: 'branch_prs',
    branch: 'unicode/ünï',
    script: [out('[{"number":1,"headRefOid":"a"},{"number":2},{"number":3,"headRefOid":"c"}]')],
  },
  {
    name: 'list failure is a RuntimeError with the list argv',
    op: 'branch_prs',
    branch: 'b',
    script: [fail(1, 'gh: rate limited\n')],
  },
  { name: 'list timeout', op: 'branch_prs', branch: 'b', script: [TIMEOUT] },
  { name: 'list output that is not JSON', op: 'branch_prs', branch: 'b', script: [out('[')] },
  {
    name: 'list under an exhausted window',
    op: 'branch_prs',
    branch: 'b',
    script: [],
    budget: { requests: 0, seconds: 30 },
  },
  // --- recover_publication over an open PR (open_pr true): the info consumer
  openCase('open PR at the prepared head finalizes', [
    info('"state":"OPEN","headRefName":"b","headRefOid":"h"'),
  ]),
  openCase(
    'open PR whose head descends from the prepared head finalizes',
    [info('"state":"OPEN","headRefName":"b","headRefOid":"p"')],
    { ancestors: { 'h>p': true } },
  ),
  openCase('a CLOSED PR is stale and its other keys are never read', [info('"state":"CLOSED"')]),
  openCase('a MERGED PR is stale', [info('"state":"MERGED","headRefName":"b","headRefOid":"h"')]),
  openCase('an open PR on another branch is stale and headRefOid is never read', [
    info('"state":"OPEN","headRefName":"other"'),
  ]),
  openCase('open PR without headRefName is a KeyError', [info('"state":"OPEN"')]),
  openCase('open PR on the branch without headRefOid is a KeyError', [
    info('"state":"OPEN","headRefName":"b"'),
  ]),
  openCase('info without state is a KeyError', [info('"headRefName":"b"')]),
  openCase('an empty object is a KeyError on state', [out('{}')]),
  openCase('a PR head that moved is stale', [
    info('"state":"OPEN","headRefName":"b","headRefOid":"x"'),
  ]),
  openCase(
    'a PR still at the journaled target while the remote read says published refuses',
    [info('"state":"OPEN","headRefName":"b","headRefOid":"t"')],
    { ls_remote: 'h\trefs/heads/b' },
  ),
  openCase(
    'a PR at the journaled target pushes under a lease on the target, then finalizes',
    [info('"state":"OPEN","headRefName":"b","headRefOid":"t"')],
    { ancestors: { 't>h': true } },
  ),
  openCase(
    'a push that would not fast-forward refuses',
    [info('"state":"OPEN","headRefName":"b","headRefOid":"t"')],
    { ancestors: {} },
  ),
  openCase('info that is a list is a TypeError', [out('[]')]),
  openCase('info that is a non-empty list is a TypeError', [out('[{"state":"OPEN"}]')]),
  openCase('info that is null is a TypeError', [out('null')]),
  openCase('info that is a string is a TypeError', [out('"OPEN"')]),
  openCase('info that is an empty string is a TypeError', [out('""')]),
  openCase('info that is an int is a TypeError', [out('5')]),
  openCase('info that is zero is a TypeError', [out('0')]),
  openCase('info that is a float is a TypeError', [out('1.5')]),
  openCase('info that is true is a TypeError', [out('true')]),
  openCase('info that is false is a TypeError', [out('false')]),
  openCase('view exit failure propagates as a RuntimeError', [
    fail(1, 'GraphQL: Could not resolve\n'),
  ]),
  openCase('view timeout propagates as an OSError', [TIMEOUT]),
  openCase('a missing gh propagates as an OSError', [MISSING]),
  openCase('view output that is not JSON propagates as a ValueError', [out('<html>')]),
  openCase('an exhausted window propagates RefreshExhausted', [], {
    budget: { requests: 0, seconds: 30 },
  }),
  // --- recover_publication without an open PR (open_pr false): the list consumer
  branchCase('no PR and no branch pushes with an empty lease, then finalizes', [out('[]')]),
  branchCase('no PR and a branch at the prepared head finalizes', [out('[]')], {
    ls_remote: 'h\trefs/heads/b',
  }),
  branchCase('no PR and a branch that fast-forwards pushes under a lease on it', [out('[]')], {
    ls_remote: 'old\trefs/heads/b',
    ancestors: { 'old>h': true },
  }),
  branchCase('no PR and a diverged branch refuses', [out('[]')], {
    ls_remote: 'old\trefs/heads/b',
    ancestors: {},
  }),
  branchCase('one PR at the prepared head finalizes', [out('[{"headRefOid":"h"}]')]),
  branchCase('one PR at another head refuses on identity', [out('[{"headRefOid":"x"}]')]),
  branchCase('one PR with a numeric head refuses on identity', [out('[{"headRefOid":5}]')]),
  branchCase('two PRs refuse without reading their keys', [out('[{},{}]')]),
  branchCase('two PRs at the prepared head refuse', [
    out('[{"headRefOid":"h"},{"headRefOid":"h"}]'),
  ]),
  branchCase('one PR without headRefOid is a KeyError', [out('[{"number":7}]')]),
  branchCase('one PR that is null is a TypeError', [out('[null]')]),
  branchCase('one PR that is a string is a TypeError', [out('["x"]')]),
  branchCase('one PR that is an int is a TypeError', [out('[5]')]),
  branchCase('one PR that is a list is a TypeError', [out('[[]]')]),
  branchCase('one PR that is a float is a TypeError', [out('[1.5]')]),
  branchCase('one PR that is a bool is a TypeError', [out('[true]')]),
  branchCase('list exit failure propagates', [fail(1, 'gh: boom\n')]),
  branchCase('list timeout propagates', [TIMEOUT]),
  branchCase('list output that is not JSON propagates', [out('nope')]),
  branchCase('an exhausted window propagates RefreshExhausted', [], {
    budget: { requests: 0, seconds: 30 },
  }),
];

describe('publication forge reads: Python differential', () => {
  it('agrees with Python on argv, directory, timeout, value or class and consumer events', async () => {
    const oracle = runOracle(CASES);
    expect(oracle).toHaveLength(CASES.length);
    for (const [index, item] of CASES.entries()) {
      const label = item.name;
      const ts = await runTs(item);
      const py = oracle[index]!;
      // The request itself: argv, directory and (rounded up to ms) time bound.
      expect({ label, calls: ts.calls }).toEqual({
        label,
        calls: py.calls.map((call) => ({
          argv: call.argv,
          cwd: call.cwd,
          timeoutMs: Math.max(1, Math.ceil((call.timeout as number) * 1000)),
        })),
      });
      const pyClass = py.error === undefined ? undefined : (CLASS[py.error] ?? py.error);
      expect({ label, error: ts.error }).toEqual({ label, error: pyClass });
      if (py.error === undefined) {
        expect({ label, ok: ts.ok }).toEqual({ label, ok: py.ok });
      } else if (!TEXT_DIFFERS.has(py.error)) {
        expect({ label, message: ts.message }).toEqual({ label, message: py.message });
      }
    }
  });

  it('drives every recover case to one distinct consumer outcome class', async () => {
    // Guards the table itself: a case that quietly stops reaching its branch
    // would still agree with Python, so count what each family produced.
    const oracle = runOracle(CASES);
    const kinds = new Set<string>();
    for (const [index, item] of CASES.entries()) {
      if (item.op !== 'recover') continue;
      const py = oracle[index]!;
      const ok = py.ok as { events: unknown[][]; record: Record<string, unknown> } | undefined;
      kinds.add(
        py.error !== undefined
          ? `${py.error}:${String(py.message)}`
          : ok!.record.state === 'stale'
            ? `stale:${String(ok!.record.error)}`
            : ok!.events.map((event) => String(event[0])).join('>'),
      );
    }
    for (const expected of [
      "KeyError:'state'",
      "KeyError:'headRefName'",
      "KeyError:'headRefOid'",
      'TypeError:list indices must be integers or slices, no',
      "TypeError:'NoneType' object is not subscriptable",
      'stale:PR no longer publishable',
      'stale:head moved after prepared publication; needs new',
      'ValueError:fix PR identity or prepared head mismatch',
      'ValueError:remote branch read is stale against the o',
      'ValueError:publication would not fast-forward the ch',
      'RuntimeError:gh pr view 5 --repo camerontaylor/examp',
      "TimeoutExpired:Command '['gh', 'pr', 'view'",
      'FileNotFoundError:[Errno 2] No such file or director',
      'RefreshExhausted:aggregate forge budget exhausted; d',
      'ls-remote>finalize',
      'ls-remote>is_ancestor>finalize',
      'ls-remote>git>finalize',
      'ls-remote>is_ancestor>is_ancestor>git>finalize',
    ])
      expect(
        [...kinds].some((kind) => kind.startsWith(expected)),
        expected,
      ).toBe(true);
  });
});

describe('publication forge reads: TS narrowings and seams', () => {
  const reads = (
    script: Step[],
    calls: Call[] = [],
    extra: { budget?: ForgeBudget } = {},
  ): PublicationForgeReads =>
    forgePublicationReads({ repo: REPO, clone: CLONE, ghFor: scripted(script, calls), ...extra });

  it('satisfies the structural subset of every publication orchestration', () => {
    expect(() => pinned(reads([]))).not.toThrow();
  });

  it.each([-5, 1.5, Number.NaN, '', '5 ', '5; rm', '-1', '0x10', null, undefined, {}, [], 2 ** 60])(
    'refuses PR argument %j before any request',
    async (pr) => {
      const calls: Call[] = [];
      const error = await reads([out('{}')], calls)
        .prInfo(pr)
        .catch((e: unknown) => e);
      expect(isPyError(error, 'ValueError')).toBe(true);
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ['a number', 5, '5'],
    ['zero', 0, '0'],
    ['digits', '12', '12'],
    ['a bigint past 2^53', 9007199254740993n, '9007199254740993'],
    ['a retained int', JsonNumber.int('123456789012345678901'), '123456789012345678901'],
  ] as const)('passes the integer PR given as %s to gh', async (_name, pr, text) => {
    const calls: Call[] = [];
    await reads([out('{}')], calls).prInfo(pr);
    expect(calls[0]!.argv[3]).toBe(text);
    expect(calls[0]!.argv.slice(0, 3)).toEqual(['gh', 'pr', 'view']);
  });

  it.each(['', '/lead', 'trail/', 'a b', 'a\nb', '..', 'a/../b', '@', 'x.lock', 'a~b', 'end.'])(
    'refuses branch %j before any request',
    async (branch) => {
      const calls: Call[] = [];
      const error = await reads([out('[]')], calls)
        .listBranchPrs(branch)
        .catch((e: unknown) => e);
      expect(isPyError(error, 'ValueError')).toBe(true);
      expect(calls).toEqual([]);
    },
  );

  it.each(['', 'a', 'a/b/c', 'a/b ', 'x/..', 'x/.', '../y', 'x y/z', 'ünï/x'])(
    'refuses repository %j',
    (repo) => {
      expect(() => forgePublicationReads({ repo, clone: CLONE })).toThrow(
        'invalid forge repository',
      );
    },
  );

  it.each([
    ['null', 'null'],
    ['an empty object', '{}'],
    ['a non-empty object', '{"a":1}'],
    ['zero', '0'],
    ['an empty string', '""'],
    ['a string', '"x"'],
    ['true', 'true'],
  ])('refuses a branch listing that is %s rather than reading it as no PR', async (_name, text) => {
    const error = await reads([out(text)])
      .listBranchPrs('b')
      .catch((e: unknown) => e);
    expect(isPyError(error, 'TypeError')).toBe(true);
  });

  it.each(['null', '0', '""', 'false'])(
    'refuses a falsy pr view answer %s at once',
    async (text) => {
      const error = await reads([out(text)])
        .prInfo(5)
        .catch((e: unknown) => e);
      expect(isPyError(error, 'TypeError')).toBe(true);
    },
  );

  it('keeps integers past 2^53 exact as bigint', async () => {
    const value = await reads([out('{"number":12345678901234567890,"state":"OPEN"}')]).prInfo(5);
    expect(value.number).toBe(12345678901234567890n);
  });

  it('raises the missing keys at the read, and never serializes them', async () => {
    const value = await reads([out('{"number":7}')]).prInfo(5);
    expect(JSON.stringify(value)).toBe('{"number":7}');
    expect(Object.keys(value)).toEqual(['number']);
    for (const key of ['state', 'headRefName', 'headRefOid'])
      expect(() => value[key]).toThrow(`'${key}'`);
  });

  it('a __proto__ key is data, not a prototype', async () => {
    const value = await reads([out('{"__proto__":{"state":"OPEN"},"state":"CLOSED"}')]).prInfo(5);
    expect(value.state).toBe('CLOSED');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('spends one request of the window per call', async () => {
    const budget = new ForgeBudget({ requests: 2, seconds: 30, clock: () => 100 });
    const calls: Call[] = [];
    const bound = reads([out('{}'), out('[]'), out('[]')], calls, { budget });
    await bound.prInfo(5);
    await bound.listBranchPrs('b');
    await expect(bound.listBranchPrs('b')).rejects.toBeInstanceOf(RefreshExhausted);
    expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 10_000]);
  });

  it('gives each request 120 seconds outside a window', async () => {
    const calls: Call[] = [];
    await reads([out('{}')], calls).prInfo(5);
    expect(calls[0]).toMatchObject({ cwd: CLONE, timeoutMs: 120_000 });
  });

  it('is read-only: no request is a view or a list', async () => {
    const calls: Call[] = [];
    const bound = reads([out('{}'), out('[]')], calls);
    await bound.prInfo(5);
    await bound.listBranchPrs('b');
    expect(calls.map((call) => call.argv.slice(1, 3))).toEqual([
      ['pr', 'view'],
      ['pr', 'list'],
    ]);
  });
});

describe('publication forge reads: the real runner', () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function stub(body: string): Promise<{ bin: string; log: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'crq-forge-reads-'));
    roots.push(dir);
    const bin = join(dir, 'gh-stub');
    const log = join(dir, 'log');
    await writeFile(bin, `#!/bin/sh\n${body.replaceAll('$LOG', log)}\n`);
    await chmod(bin, 0o755);
    return { bin, log, dir };
  }
  const withBin =
    (bin: string) =>
    (request: GhRequest): GhFn =>
      makeGhRunner({ ...request, bin });

  it('runs gh in the clone with the exact argv and parses its output', async () => {
    const { bin, log, dir } = await stub(
      'pwd > "$LOG"; printf "%s\\n" "$@" >> "$LOG"; echo \'{"state":"OPEN"}\'',
    );
    const value = await forgePublicationReads({
      repo: REPO,
      clone: dir,
      ghFor: withBin(bin),
    }).prInfo(5);
    expect(value.state).toBe('OPEN');
    const lines = (await readFile(log, 'utf8')).trimEnd().split('\n');
    expect(lines.slice(1)).toEqual(PR_VIEW.slice(1));
    expect(lines[0]).toBe(await realpath(dir));
  });

  it('reports a gh that outlives its bound as an OSError, not a miss', async () => {
    const { bin, dir } = await stub('exec sleep 5');
    const budget = new ForgeBudget({
      requests: 1,
      seconds: 0.1,
      clock: () => performance.now() / 1000,
    });
    const started = Date.now();
    const error = await forgePublicationReads({
      repo: REPO,
      clone: dir,
      budget,
      ghFor: withBin(bin),
    })
      .listBranchPrs('b')
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(isPyError(error, 'OSError')).toBe(true);
    expect((error as Error).message).toMatch(
      /^Command '\['gh', 'pr', 'list', .*\]' timed out after 0\.\d+ seconds$/,
    );
  });

  it('reports an absent gh binary as an OSError', async () => {
    const error = await forgePublicationReads({
      repo: REPO,
      clone: tmpdir(),
      ghFor: withBin(join(tmpdir(), 'crq-no-such-gh-binary')),
    })
      .prInfo(5)
      .catch((e: unknown) => e);
    expect(isPyError(error, 'OSError')).toBe(true);
    expect((error as Error).message).toBe("[Errno 2] No such file or directory: 'gh'");
  });

  it('reports a gh that fails as a RuntimeError with its stderr', async () => {
    const { bin, dir } = await stub('echo "HTTP 404" >&2; exit 1');
    const error = await forgePublicationReads({ repo: REPO, clone: dir, ghFor: withBin(bin) })
      .prInfo(5)
      .catch((e: unknown) => e);
    expect(isPyError(error, 'RuntimeError')).toBe(true);
    expect((error as Error).message).toBe(`gh pr view 5 --repo ${REPO} … exit 1: HTTP 404`);
  });
});
