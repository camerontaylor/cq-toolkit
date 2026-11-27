/**
 * Differential test for the recover input preflight
 * (src/queue-runner/repairRecoverInput.ts) against Python's
 * `crq_repair.recovery.recover`, whose first lines it ports: job and result
 * identity, the `progress.json` fallback for an interrupted dispatch, and the
 * terminal-FAILED / no-`retry_after` gate.
 *
 * Offline and read-only by construction. The oracle runs the REAL
 * `recovery.recover` over a throwaway tree with `recovery.source_path` replaced
 * by a sentinel that captures the caller's `job` and `result` and stops, so Git,
 * the clone, the worktree, retained archives, scans, the judge and every
 * `recovery.json` write are never reached. Nothing leaves the fixture root; no
 * provider, queue host, forge or live state is read. All data is synthetic.
 *
 * Both sides read the same files and both record which reads they made, so the
 * lazy order (a refusal never asks a later question) is pinned as well as the
 * verdict, and a passing scenario must hand back the very same job and result.
 * Each scenario also names its expected outcome, so a drift of both
 * implementations together still fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type JsonNumber,
  parseJsonValue,
  pythonNonFinite,
  toPlainJsonRetainingNumbers,
} from '../../src/policy/crq/jsonValue.js';
import { PyError, type PyErrorKind } from '../../src/queue-runner/pyErrors.js';
import {
  decideRecoverInput,
  INTERRUPTED_REASON,
  type RecoverInputReads,
  type RecoverInputRefusal,
} from '../../src/queue-runner/repairRecoverInput.js';

const PYTHON_DIR = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const JOB = 'crq-R-F1';
const ITEM = 'pr1-merged';

/** The `ValueError` texts `recover` raises here, written out independently of the module. */
const REASON: Readonly<Record<RecoverInputRefusal, string>> = {
  'job-identity-mismatch': 'job identity mismatch',
  'no-interrupted-dispatch': 'no interrupted dispatch or terminal result',
  'result-identity-mismatch': 'result identity mismatch',
  'not-terminal-failed': 'only terminal failed jobs can be recovered',
};
const REFUSAL_OF = new Map(
  (Object.entries(REASON) as Array<[RecoverInputRefusal, string]>).map(([slug, text]) => [
    text,
    slug,
  ]),
);
const GRAMMAR = 'expected one exact CRQ job id';

type Expect =
  | 'ok'
  | 'ok-interrupted'
  | RecoverInputRefusal
  | { readonly error: PyErrorKind; readonly message?: string };

/** A file's content: JSON for a value, or the exact text for `{ raw }`. */
type FileBody = unknown;
const raw = (text: string): { raw: string } => ({ raw: text });
/** Invalid UTF-8 on disk. */
const BAD_BYTES = raw('\u0000');
/** `result.json` as a directory: `exists()` is true and `read_text` fails. */
const DIRECTORY = { directory: true } as const;

interface Scenario {
  readonly name: string;
  readonly expect: Expect;
  /** Reads made, in order, relative to the fixture root. */
  readonly reads: readonly string[];
  /** The job id handed to `recover`; the files are always laid under `JOB`. */
  readonly jobId?: string;
  /** The job file (`raw(text)` for exact bytes); `undefined` keeps the default job. */
  readonly job?: FileBody;
  /** `result.json`; absent when `undefined`. */
  readonly result?: FileBody | typeof DIRECTORY;
  /** `progress.json`; absent when `undefined`. */
  readonly progress?: FileBody;
  /** Omit the job file altogether. */
  readonly noJob?: true;
}

const inbox = `state/repair/inbox/${JOB}.json`;
const resultRel = `state/repair/${JOB}/result.json`;
const progressRel = `state/repair/${JOB}/progress.json`;
const R_JOB = [inbox] as const;
const R_EXISTS = [inbox, `exists:${resultRel}`] as const;
const R_RESULT = [...R_EXISTS, resultRel] as const;
const R_PROGRESS = [...R_EXISTS, progressRel] as const;

const jobWith = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  job: JOB,
  item: ITEM,
  finding: {},
  ...over,
});
const failed = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  job: JOB,
  item: ITEM,
  verdict: 'FAILED',
  worktree: '/tmp/synthetic/crq-repair-pr1-merged-crq-R-F1',
  ...over,
});
const pending = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  job: JOB,
  item: ITEM,
  dispatch_pending: true,
  ...over,
});

/** A scenario whose job file is `jobBody` and whose `result.json` is `resultBody`. */
function withResult(
  name: string,
  expected: Expect,
  resultBody: FileBody | typeof DIRECTORY,
  extra: Partial<Scenario> = {},
): Scenario {
  return { name, expect: expected, reads: R_RESULT, result: resultBody, ...extra };
}

/** A scenario with no `result.json`, so `progress.json` decides. */
function withProgress(
  name: string,
  expected: Expect,
  progressBody: FileBody,
  extra: Partial<Scenario> = {},
): Scenario {
  return { name, expect: expected, reads: R_PROGRESS, progress: progressBody, ...extra };
}

const RETRY_AFTER_TRUTHY: ReadonlyArray<readonly [string, string]> = [
  ['a string', '"2026-12-01T00:00:00Z"'],
  ['a non-zero int', '1'],
  ['a non-zero float', '0.5'],
  ['true', 'true'],
  ['a non-empty list', '[0]'],
  ['a non-empty dict', '{"a":0}'],
  ['NaN (truthy)', 'NaN'],
];
const RETRY_AFTER_FALSY: ReadonlyArray<readonly [string, string]> = [
  ['null', 'null'],
  ['zero', '0'],
  ['0.0', '0.0'],
  ['-0.0', '-0.0'],
  ['false', 'false'],
  ['an empty string', '""'],
  ['an empty list', '[]'],
  ['an empty dict', '{}'],
];
const PENDING_TRUTHY: ReadonlyArray<readonly [string, string]> = [
  ['true', 'true'],
  ['a non-zero int', '2'],
  ['a non-zero float', '0.25'],
  ['a non-empty string', '"yes"'],
  ['a non-empty list', '[false]'],
  ['a non-empty dict', '{"k":null}'],
];
const PENDING_FALSY: ReadonlyArray<readonly [string, string]> = [
  ['false', 'false'],
  ['null', 'null'],
  ['zero', '0'],
  ['0.0', '0.0'],
  ['an empty string', '""'],
  ['an empty list', '[]'],
  ['an empty dict', '{}'],
];

const text = (extra: string): ReturnType<typeof raw> =>
  raw(`{"job":"${JOB}","item":"${ITEM}","verdict":"FAILED",${extra}}`);
const pendingText = (extra: string): ReturnType<typeof raw> =>
  raw(`{"job":"${JOB}","item":"${ITEM}",${extra}}`);

const SCENARIOS: readonly Scenario[] = [
  // ---- the job id and the job file -----------------------------------------
  { name: 'a terminal failed result passes', expect: 'ok', reads: R_RESULT, result: failed() },
  {
    name: 'a job with a malformed finding still passes: the finding is read only after the prefix',
    expect: 'ok',
    reads: R_RESULT,
    job: jobWith({ finding: 5, repair_base: 'not a sha' }),
    result: failed(),
  },
  ...[
    ['an empty id', ''],
    ['a bare prefix', 'crq-'],
    ['a path-like id', '../crq-R-F1'],
    ['an id with a slash', 'crq-R/F1'],
    ['an id with a space', 'crq-R F1'],
    ['an id with a trailing newline', 'crq-R-F1\n'],
    ['an id without the prefix', 'R-F1'],
    ['an id with a non-ASCII letter', 'crq-R-É'],
  ].map(([label, id]): Scenario => ({
    name: `${label} is job_path's grammar ValueError before any read`,
    expect: { error: 'ValueError', message: GRAMMAR },
    reads: [],
    jobId: id as string,
    result: failed(),
  })),
  {
    name: 'a missing job file is an OSError after the read attempt',
    expect: { error: 'OSError' },
    reads: R_JOB,
    noJob: true,
  },
  {
    name: 'an unparsable job file is a ValueError',
    expect: { error: 'ValueError' },
    reads: R_JOB,
    job: raw('{not json'),
  },
  {
    name: 'an empty job file is a ValueError',
    expect: { error: 'ValueError' },
    reads: R_JOB,
    job: raw(''),
  },
  {
    name: 'a non-UTF-8 job file is a ValueError',
    expect: { error: 'ValueError' },
    reads: R_JOB,
    job: BAD_BYTES,
  },
  {
    name: 'a job naming another id is a job identity mismatch',
    expect: 'job-identity-mismatch',
    reads: R_JOB,
    job: jobWith({ job: 'crq-R-F2' }),
    result: failed(),
  },
  {
    name: 'a job without a job key is a job identity mismatch (None != id)',
    expect: 'job-identity-mismatch',
    reads: R_JOB,
    job: { item: ITEM },
  },
  {
    name: 'a job with a non-string job is a job identity mismatch',
    expect: 'job-identity-mismatch',
    reads: R_JOB,
    job: jobWith({ job: 7 }),
  },
  {
    name: 'a job whose id differs only in case mismatches',
    expect: 'job-identity-mismatch',
    reads: R_JOB,
    job: jobWith({ job: JOB.toUpperCase() }),
  },
  ...(
    [
      ['a list', '[]', 'list'],
      ['a non-empty list', '[1]', 'list'],
      ['a string', '"x"', 'str'],
      ['null', 'null', 'NoneType'],
      ['an int', '3', 'int'],
      ['a float', '1.0', 'float'],
      ['true', 'true', 'bool'],
    ] as const
  ).map(([label, body, kind]): Scenario => ({
    name: `a job that is ${label} has no .get`,
    expect: { error: 'AttributeError', message: `'${kind}' object has no attribute 'get'` },
    reads: R_JOB,
    job: raw(body),
  })),

  // ---- result.json ---------------------------------------------------------
  withResult(
    'a verdict other than FAILED is not terminal failed',
    'not-terminal-failed',
    failed({ verdict: 'PASS' }),
  ),
  withResult(
    'a lower-case failed verdict is not terminal failed',
    'not-terminal-failed',
    failed({ verdict: 'failed' }),
  ),
  withResult(
    'a missing verdict is not terminal failed',
    'not-terminal-failed',
    failed({ verdict: undefined }),
  ),
  withResult(
    'a null verdict is not terminal failed',
    'not-terminal-failed',
    failed({ verdict: null }),
  ),
  ...RETRY_AFTER_TRUTHY.map(([label, body]) =>
    withResult(
      `retry_after ${label} defers the result`,
      'not-terminal-failed',
      text(`"retry_after":${body}`),
    ),
  ),
  ...RETRY_AFTER_FALSY.map(([label, body]) =>
    withResult(`retry_after ${label} is no deferral`, 'ok', text(`"retry_after":${body}`)),
  ),
  withResult('a result without retry_after passes', 'ok', failed()),
  {
    name: 'an existing result.json ignores a pending progress record',
    expect: 'ok',
    reads: R_RESULT,
    result: failed(),
    progress: pending(),
  },
  {
    name: 'an existing non-failed result.json is not replaced by a pending progress record',
    expect: 'not-terminal-failed',
    reads: R_RESULT,
    result: failed({ verdict: 'PASS' }),
    progress: pending(),
  },
  withResult(
    'a result naming another job mismatches',
    'result-identity-mismatch',
    failed({ job: 'crq-R-F2' }),
  ),
  withResult(
    'a result without a job mismatches',
    'result-identity-mismatch',
    failed({ job: undefined }),
  ),
  withResult(
    'a result naming another item mismatches',
    'result-identity-mismatch',
    failed({ item: 'other' }),
  ),
  withResult(
    'a result without an item mismatches a job with one',
    'result-identity-mismatch',
    failed({ item: undefined }),
  ),
  {
    name: 'a result and a job that both lack an item match (None == None)',
    expect: 'ok',
    reads: R_RESULT,
    job: { job: JOB, finding: {} },
    result: failed({ item: undefined }),
  },
  {
    name: 'a null item equals a missing item',
    expect: 'ok',
    reads: R_RESULT,
    job: { job: JOB, finding: {} },
    result: failed({ item: null }),
  },
  {
    name: 'item 1 equals 1.0 (Python ==)',
    expect: 'ok',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":1,"finding":{}}`),
    result: text('"item":1.0'),
  },
  {
    name: 'item true equals 1 (bool is an int)',
    expect: 'ok',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":1,"finding":{}}`),
    result: raw(`{"job":"${JOB}","item":true,"verdict":"FAILED"}`),
  },
  {
    name: 'item "1" does not equal 1',
    expect: 'result-identity-mismatch',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":1,"finding":{}}`),
    result: raw(`{"job":"${JOB}","item":"1","verdict":"FAILED"}`),
  },
  {
    name: 'a big int item differs from its float rounding',
    expect: 'result-identity-mismatch',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":9007199254740993,"finding":{}}`),
    result: raw(`{"job":"${JOB}","item":9007199254740992.0,"verdict":"FAILED"}`),
  },
  {
    name: 'structured items compare by value, dict order aside',
    expect: 'ok',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":{"a":[1,2],"b":{"c":null}},"finding":{}}`),
    result: raw(`{"job":"${JOB}","item":{"b":{"c":null},"a":[1.0,2]},"verdict":"FAILED"}`),
  },
  {
    name: 'a list item is not a dict item',
    expect: 'result-identity-mismatch',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":[],"finding":{}}`),
    result: raw(`{"job":"${JOB}","item":{},"verdict":"FAILED"}`),
  },
  {
    name: 'a bare NaN item never equals itself',
    expect: 'result-identity-mismatch',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":NaN,"finding":{}}`),
    result: raw(`{"job":"${JOB}","item":NaN,"verdict":"FAILED"}`),
  },
  {
    name: 'a NaN inside a list item equals itself (shared decoded NaN)',
    expect: 'ok',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":[NaN],"finding":{}}`),
    result: raw(`{"job":"${JOB}","item":[NaN],"verdict":"FAILED"}`),
  },
  {
    name: 'a NaN inside a dict item equals itself (shared decoded NaN)',
    expect: 'ok',
    reads: R_RESULT,
    job: raw(`{"job":"${JOB}","item":{"k":NaN},"finding":{}}`),
    result: raw(`{"job":"${JOB}","item":{"k":NaN},"verdict":"FAILED"}`),
  },
  withResult(
    'an empty-list result is a result identity mismatch',
    'result-identity-mismatch',
    raw('[]'),
  ),
  withResult('a list result is a result identity mismatch', 'result-identity-mismatch', [failed()]),
  withResult(
    'a string result is a result identity mismatch',
    'result-identity-mismatch',
    raw('"FAILED"'),
  ),
  withResult(
    'a null result is a result identity mismatch',
    'result-identity-mismatch',
    raw('null'),
  ),
  withResult(
    'a numeric result is a result identity mismatch',
    'result-identity-mismatch',
    raw('1'),
  ),
  withResult('an unparsable result is a ValueError', { error: 'ValueError' }, raw('{"job":')),
  withResult('an empty result file is a ValueError', { error: 'ValueError' }, raw('')),
  withResult('a non-UTF-8 result is a ValueError', { error: 'ValueError' }, BAD_BYTES),
  withResult(
    'a result.json directory exists, so it is read and fails as an OSError',
    { error: 'OSError' },
    DIRECTORY,
    { progress: pending() },
  ),
  withResult(
    'a duplicate verdict key keeps the last one',
    'ok',
    raw(`{"job":"${JOB}","item":"${ITEM}","verdict":"PASS","verdict":"FAILED"}`),
  ),
  withResult(
    'a duplicate verdict key keeps the last one (to PASS)',
    'not-terminal-failed',
    raw(`{"job":"${JOB}","item":"${ITEM}","verdict":"FAILED","verdict":"PASS"}`),
  ),

  // ---- the interrupted-dispatch fallback ------------------------------------
  withProgress(
    'a pending dispatch with no result becomes a failed result',
    'ok-interrupted',
    pending(),
  ),
  withProgress(
    'an interrupted result overrides the progress verdict and reason',
    'ok-interrupted',
    pending({ verdict: 'PASS', reason: 'something else', worktree: '/tmp/synthetic/wt' }),
  ),
  ...PENDING_TRUTHY.map(([label, body]) =>
    withProgress(
      `dispatch_pending ${label} counts as pending`,
      'ok-interrupted',
      pendingText(`"dispatch_pending":${body}`),
    ),
  ),
  ...PENDING_FALSY.map(([label, body]) =>
    withProgress(
      `dispatch_pending ${label} is no interrupted dispatch`,
      'no-interrupted-dispatch',
      pendingText(`"dispatch_pending":${body}`),
    ),
  ),
  withProgress(
    'a progress record without dispatch_pending is no interrupted dispatch',
    'no-interrupted-dispatch',
    {
      job: JOB,
      item: ITEM,
    },
  ),
  withProgress(
    'a list progress record is no interrupted dispatch',
    'no-interrupted-dispatch',
    raw('[{"dispatch_pending":true}]'),
  ),
  withProgress(
    'a null progress record is no interrupted dispatch',
    'no-interrupted-dispatch',
    raw('null'),
  ),
  withProgress(
    'a string progress record is no interrupted dispatch',
    'no-interrupted-dispatch',
    raw('"dispatch_pending"'),
  ),
  withProgress(
    'a numeric progress record is no interrupted dispatch',
    'no-interrupted-dispatch',
    raw('1'),
  ),
  {
    name: 'a missing progress file (and no result) is an OSError',
    expect: { error: 'OSError' },
    reads: R_PROGRESS,
  },
  withProgress(
    'an unparsable progress file is a ValueError',
    { error: 'ValueError' },
    raw('{"dispatch_pending"'),
  ),
  withProgress('a non-UTF-8 progress file is a ValueError', { error: 'ValueError' }, BAD_BYTES),
  ...RETRY_AFTER_TRUTHY.map(([label, body]) =>
    withProgress(
      `an interrupted result keeps the progress retry_after ${label} and is refused`,
      'not-terminal-failed',
      pendingText(`"dispatch_pending":true,"retry_after":${body}`),
    ),
  ),
  ...RETRY_AFTER_FALSY.map(([label, body]) =>
    withProgress(
      `an interrupted result with retry_after ${label} passes`,
      'ok-interrupted',
      pendingText(`"dispatch_pending":true,"retry_after":${body}`),
    ),
  ),
  withProgress(
    'an interrupted result naming another job mismatches',
    'result-identity-mismatch',
    pending({ job: 'crq-R-F2' }),
  ),
  withProgress('an interrupted result without a job mismatches', 'result-identity-mismatch', {
    item: ITEM,
    dispatch_pending: true,
  }),
  withProgress(
    'an interrupted result naming another item mismatches',
    'result-identity-mismatch',
    pending({ item: 'other' }),
  ),
  {
    name: 'an interrupted result and a job that both lack an item match',
    expect: 'ok-interrupted',
    reads: R_PROGRESS,
    job: { job: JOB, finding: {} },
    progress: { job: JOB, dispatch_pending: true },
  },
  withProgress(
    'a __proto__ key in progress stays data in the synthesised result',
    'ok-interrupted',
    raw(`{"__proto__":{"polluted":true},"job":"${JOB}","item":"${ITEM}","dispatch_pending":true}`),
  ),
  withProgress(
    'a duplicate dispatch_pending key keeps the last one',
    'no-interrupted-dispatch',
    pendingText('"dispatch_pending":true,"dispatch_pending":false'),
  ),
  {
    name: 'a job identity mismatch never asks about the result',
    expect: 'job-identity-mismatch',
    reads: R_JOB,
    job: jobWith({ job: 'crq-other' }),
    progress: pending(),
  },
];

type Outcome =
  | { readonly ok: true; readonly interrupted: boolean; readonly reads: readonly string[] }
  | {
      readonly refusal: RecoverInputRefusal;
      readonly reason: string;
      readonly reads: readonly string[];
    }
  | { readonly error: string; readonly message?: string; readonly reads: readonly string[] };

interface Laid {
  readonly scenario: Scenario;
  readonly root: string;
}

/** The exact text a fixture holds: `raw(text)` verbatim, any other value as JSON. */
function bodyText(body: FileBody): string {
  return typeof body === 'object' && body !== null && 'raw' in body
    ? (body as { raw: string }).raw
    : JSON.stringify(body);
}

function writeFileBody(root: string, rel: string, body: FileBody): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  const content = bodyText(body);
  // `raw('\u0000')` stands for invalid UTF-8: write the byte, not the character.
  if (content === '\u0000') writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
  else writeFileSync(path, content);
}

function lay(scenario: Scenario): Laid {
  const root = mkdtempSync(join(tmpdir(), 'repair-recover-input-'));
  dirs.push(root);
  mkdirSync(join(root, 'state/repair', JOB), { recursive: true });
  mkdirSync(join(root, 'state/repair/inbox'), { recursive: true });
  if (scenario.noJob !== true) {
    writeFileBody(root, inbox, scenario.job === undefined ? jobWith() : scenario.job);
  }
  if (scenario.result === DIRECTORY) mkdirSync(join(root, resultRel), { recursive: true });
  else if (scenario.result !== undefined) writeFileBody(root, resultRel, scenario.result);
  if (scenario.progress !== undefined) writeFileBody(root, progressRel, scenario.progress);
  return { scenario, root };
}

const PY = String.raw`
import json, pathlib, sys
from unittest import mock
sys.path.insert(0, sys.argv[1])
from crq_repair import recovery

class Reached(Exception):
    pass

def reach(*args, **kwargs):
    # recover()'s own frame: the prefix has produced 'job' and 'result'.
    frame = sys._getframe(1).f_locals
    raise Reached(json.dumps({'job': frame['job'], 'result': frame['result']}))

out = []
original_read = pathlib.Path.read_text
original_exists = pathlib.Path.exists
for s in json.loads(sys.argv[2]):
    root = pathlib.Path(s['root'])
    reads = []
    def read_text(self, *a, root=root, reads=reads, **k):
        try:
            reads.append(str(self.relative_to(root)))
        except ValueError:
            pass
        return original_read(self, *a, **k)
    def exists(self, *a, root=root, reads=reads, **k):
        try:
            reads.append('exists:' + str(self.relative_to(root)))
        except ValueError:
            pass
        return original_exists(self, *a, **k)
    entry = {}
    with mock.patch.object(recovery, 'source_path', reach), \
         mock.patch.object(pathlib.Path, 'read_text', read_text), \
         mock.patch.object(pathlib.Path, 'exists', exists):
        try:
            recovery.recover(root, {}, s['job_id'], None, None, None)
            raise AssertionError('recover ran past the input prefix')
        except Reached as reached:
            entry['ok'] = True
            entry['payload'] = str(reached)
        except Exception as e:
            entry['error'] = 'OSError' if isinstance(e, OSError) else (
                'ValueError' if isinstance(e, ValueError) else type(e).__name__)
            entry['message'] = str(e)
    entry['reads'] = reads
    out.append(entry)
print(json.dumps(out))
`;

interface PythonRun {
  readonly outcomes: Outcome[];
  readonly payloads: Array<unknown>;
}

function scenarioOutcome(
  scenario: Scenario,
  entry: Record<string, unknown>,
): { outcome: Outcome; payload: unknown } {
  const reads = entry.reads as readonly string[];
  if (entry.ok === true) {
    return {
      outcome: { ok: true, interrupted: reads.includes(progressRel), reads },
      payload: parseFixtureText(entry.payload as string),
    };
  }
  const message = entry.message as string;
  const refusal = entry.error === 'ValueError' ? REFUSAL_OF.get(message) : undefined;
  if (refusal !== undefined) {
    return { outcome: { refusal, reason: message, reads }, payload: undefined };
  }
  const want = scenario.expect;
  const named = typeof want === 'object' && want.message !== undefined;
  return {
    outcome: { error: entry.error as string, ...(named ? { message } : {}), reads },
    payload: undefined,
  };
}

function runPython(laid: readonly Laid[]): PythonRun {
  const specs = laid.map(({ scenario, root }) => ({ root, job_id: scenario.jobId ?? JOB }));
  const stdout = execFileSync('python3', ['-I', '-c', PY, PYTHON_DIR, JSON.stringify(specs)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const mapped = entries.map((entry, index) => {
    const item = laid[index];
    if (item === undefined) throw new Error('missing scenario');
    return scenarioOutcome(item.scenario, entry);
  });
  return { outcomes: mapped.map((m) => m.outcome), payloads: mapped.map((m) => m.payload) };
}

/** `json.loads` as the port's callers decode it: numbers retained, Python's non-finite constants. */
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function parseFixtureText(content: string): unknown {
  try {
    return toPlainJsonRetainingNumbers(parseJsonValue(content, { parseConstant: pythonNonFinite }));
  } catch (e) {
    throw new PyError('ValueError', e instanceof Error ? e.message : String(e));
  }
}

function readJsonFile(path: string): unknown {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new PyError('OSError', e instanceof Error ? e.message : String(e));
  }
  try {
    return parseFixtureText(decoder.decode(bytes));
  } catch (e) {
    if (e instanceof PyError) throw e;
    throw new PyError('ValueError', e instanceof Error ? e.message : String(e));
  }
}

async function runTs({ scenario, root }: Laid): Promise<{ outcome: Outcome; payload: unknown }> {
  const reads: string[] = [];
  const probes: RecoverInputReads = {
    readJob: (jobId) => {
      reads.push(`state/repair/inbox/${jobId}.json`);
      return Promise.resolve().then(() => readJsonFile(join(root, inbox)));
    },
    resultExists: () => {
      reads.push(`exists:${resultRel}`);
      return Promise.resolve(existsSync(join(root, resultRel)));
    },
    readResult: () => {
      reads.push(resultRel);
      return Promise.resolve().then(() => readJsonFile(join(root, resultRel)));
    },
    readProgress: () => {
      reads.push(progressRel);
      return Promise.resolve().then(() => readJsonFile(join(root, progressRel)));
    },
  };
  try {
    const decision = await decideRecoverInput({ jobId: scenario.jobId ?? JOB }, probes);
    if (decision.ok) {
      return {
        outcome: { ok: true, interrupted: decision.interrupted, reads },
        payload: { job: decision.job, result: decision.result },
      };
    }
    return {
      outcome: { refusal: decision.refusal, reason: decision.reason, reads },
      payload: undefined,
    };
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    const want = scenario.expect;
    const named = typeof want === 'object' && want.message !== undefined;
    return {
      outcome: { error: e.kind, ...(named ? { message: e.message } : {}), reads },
      payload: undefined,
    };
  }
}

/** What a scenario's `expect` normalises to, with reads attached. */
function expected(scenario: Scenario): Outcome {
  const { expect: want, reads } = scenario;
  if (want === 'ok') return { ok: true, interrupted: false, reads };
  if (want === 'ok-interrupted') return { ok: true, interrupted: true, reads };
  if (typeof want === 'string') return { refusal: want, reason: REASON[want], reads };
  return {
    error: want.error,
    ...(want.message === undefined ? {} : { message: want.message }),
    reads,
  };
}

describe('recover input preflight against Python recovery.recover', () => {
  const laid = SCENARIOS.map(lay);
  const python = runPython(laid);

  it('keeps a 1.0 fixture as a float and a 1 as an int on the port side', () => {
    const parsed = parseFixtureText('{"a":1.0,"b":1}') as Record<string, unknown>;
    expect((parsed.a as JsonNumber).kind).toBe('float');
    expect((parsed.b as JsonNumber).kind).toBe('int');
  });

  it('has uniquely named scenarios', () => {
    const names = SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(SCENARIOS.map((scenario, index) => [scenario.name, index] as const))(
    '%s',
    async (_name, index) => {
      const item = laid[index];
      const oracle = python.outcomes[index];
      if (item === undefined || oracle === undefined) throw new Error('missing scenario');
      const want = expected(item.scenario);
      expect(oracle).toEqual(want);
      const ported = await runTs(item);
      expect(ported.outcome).toEqual(want);
      // A pass hands back the very job and result Python goes on to use.
      expect(ported.payload).toEqual(python.payloads[index]);
    },
  );

  it('synthesises the interrupted result as {...progress, verdict, reason}', async () => {
    const index = SCENARIOS.findIndex((s) => s.name.startsWith('an interrupted result overrides'));
    const item = laid[index];
    if (item === undefined) throw new Error('missing scenario');
    const ported = await runTs(item);
    expect(ported.payload).toEqual({
      job: { job: JOB, item: ITEM, finding: {} },
      result: {
        job: JOB,
        item: ITEM,
        dispatch_pending: true,
        verdict: 'FAILED',
        reason: INTERRUPTED_REASON,
        worktree: '/tmp/synthetic/wt',
      },
    });
    expect(Object.keys((ported.payload as { result: object }).result)).toEqual([
      'job',
      'item',
      'dispatch_pending',
      'verdict',
      'reason',
      'worktree',
    ]);
  });

  it('keeps a __proto__ progress key as own data on the synthesised result', async () => {
    const index = SCENARIOS.findIndex((s) => s.name.startsWith('a __proto__ key in progress'));
    const item = laid[index];
    if (item === undefined) throw new Error('missing scenario');
    const { payload } = await runTs(item);
    const result = (payload as { result: object }).result;
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('covers every refusal and every error class the prefix can raise', () => {
    const refusals = new Set<string>();
    const errors = new Set<string>();
    for (const scenario of SCENARIOS) {
      const want = scenario.expect;
      if (typeof want === 'string') refusals.add(want);
      else errors.add(want.error);
    }
    refusals.delete('ok');
    refusals.delete('ok-interrupted');
    expect([...refusals].sort()).toEqual(Object.keys(REASON).sort());
    expect([...errors].sort()).toEqual(['AttributeError', 'OSError', 'ValueError']);
  });
});
