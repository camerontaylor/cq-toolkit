/**
 * Differential test for the initial result/progress selection
 * (src/queue-runner/repairProgressSelection.ts) against Python's
 * `crq_repair.process`, whose first lines it ports.
 *
 * Offline and read-only by construction. The oracle runs the REAL `process`
 * over a throwaway tree, with a line tracer that stops it at the first
 * statement after the selection (`if result.get('dispatch_pending') ...`) and
 * snapshots `result` and `resume_progress` there, so worktree selection, the
 * `job.json` write, the rung loop, the judge and every save are never reached.
 * `datetime.now` and `utc()` are pinned to one instant. Nothing leaves the
 * fixture root and no provider, queue host or live state is read.
 *
 * Both sides read the same files, and both record which probes they made, in
 * order, so the lazy ordering (a preserved result never asks about progress)
 * is pinned as well as the outcome. Each scenario also names its expected
 * outcome, so a drift of both implementations together still fails.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  JsonNumber,
  parseJsonValue,
  pythonNonFinite,
  toPlainJsonRetainingNumbers,
} from '../../src/policy/crq/jsonValue.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import {
  type RepairProgressSelection,
  type RepairProgressSelectionReads,
  type RepairResultSource,
  selectRepairProgress,
} from '../../src/queue-runner/repairProgressSelection.js';

const PYTHON_DIR = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const JOB = 'crq-R-F1';
const ITEM = 'pr1-merged';
const WORKTREE = '/wt/crq-repair-pr1-merged-crq-R-F1';
const NOW_STAMP = '2026-11-23T12:00:00Z';
const NOW_MICROS = BigInt(Date.UTC(2026, 10, 23, 12, 0, 0)) * 1000n;
/** A whole-second instant with nanoseconds to spare either side. */
const BASE_NS = 1_700_000_000_123_456_789n;
const SECOND_NS = 1_000_000_000n;

/** A fixture file: JSON for a value, exact text, a directory, a symlink or bad UTF-8. */
type FileSpec =
  | { readonly json: unknown }
  | { readonly raw: string }
  | { readonly dir: true }
  | { readonly link: string }
  | { readonly badUtf8: true };
const json = (value: unknown): FileSpec => ({ json: value });
const raw = (text: string): FileSpec => ({ raw: text });
const DIR: FileSpec = { dir: true };
const BAD_UTF8: FileSpec = { badUtf8: true };
const link = (target: string): FileSpec => ({ link: target });

const REPAIR = { roles: { fixer: { driver: 'cq' } } };
const CONFIG = { repair: REPAIR };
const FALLBACKS = { repair: { ...REPAIR, fallback_models: ['a/b'] } };
const JOB_DICT = {
  job: JOB,
  item: ITEM,
  repair_base: 'base0',
  source_sha: 'src0',
  finding_sha256: 'fnd0',
};
const FRESH = {
  job: JOB,
  item: ITEM,
  repair_base: 'base0',
  source_sha: 'src0',
  finding_sha256: 'fnd0',
  origin_job: null,
  verdict: 'FAILED',
  reason: '',
  commits: [],
  attempts: [],
  judge: null,
  worktree: WORKTREE,
  started_at: NOW_STAMP,
};

type Want =
  | { readonly kind: 'preserved'; readonly result: FileSpec }
  | { readonly kind: 'selected'; readonly source: RepairResultSource; readonly result: FileSpec }
  | { readonly error: string; readonly message?: string };

interface Scenario {
  readonly name: string;
  readonly want: Want;
  /** Probes made, in order (`exists|stat|read <file>`), relative to the job directory. */
  readonly reads: readonly string[];
  readonly config?: unknown;
  readonly job?: unknown;
  readonly result?: FileSpec;
  readonly progress?: FileSpec;
  /** Exact modification times, set on both fixtures before either side reads. */
  readonly mtimes?: { readonly result?: bigint; readonly progress?: bigint };
  /** Scripted answers to `result_path.exists()` by call ordinal (E1, E2, then the post-progress probe). */
  readonly resultExists?: readonly boolean[];
  /** Scripted bodies of successive `result_path.read_text()` calls (a file changing between reads). */
  readonly resultBodies?: readonly FileSpec[];
}

const R = 'exists result.json';
const RR = 'read result.json';
const P = 'exists progress.json';
const RP = 'read progress.json';
const SP = 'stat progress.json';
const SR = 'stat result.json';
const FIRST_PASS = [R, R, P] as const;

const past = (extra: Record<string, unknown> = {}): FileSpec =>
  json({ job: JOB, verdict: 'FAILED', retry_after: '2000-01-01T00:00:00Z', ...extra });
const without = (extra: Record<string, unknown> = {}): FileSpec =>
  json({ job: JOB, verdict: 'FAILED', ...extra });
const deferred = (stamp: unknown): FileSpec =>
  json({ job: JOB, verdict: 'FAILED', retry_after: stamp });
const preserved = (result: FileSpec): Want => ({ kind: 'preserved', result });
const selected = (source: RepairResultSource, result: FileSpec): Want => ({
  kind: 'selected',
  source,
  result,
});
const error = (kind: string, message?: string): Want => ({
  error: kind,
  ...(message === undefined ? {} : { message }),
});
/** A result deferred until `stamp` against the pinned `now`, expected to be re-run or kept. */
function stampScenario(name: string, stamp: string, keeps: boolean): Scenario {
  const result = deferred(stamp);
  return keeps
    ? { name, want: preserved(result), reads: [R, RR], result }
    : {
        name,
        want: selected('result', without()),
        reads: [R, RR, R, RR, P],
        result,
      };
}

const SCENARIOS: readonly Scenario[] = [
  // ---- a fresh job ---------------------------------------------------------
  {
    name: 'no files: the default FAILED result, with two result probes and one progress probe',
    want: selected('fresh', json(FRESH)),
    reads: [...FIRST_PASS],
  },
  {
    name: 'the default result records origin_job when the job has one',
    want: selected('fresh', json({ ...FRESH, origin_job: 'crq-R-F0' })),
    reads: [...FIRST_PASS],
    job: { ...JOB_DICT, origin_job: 'crq-R-F0' },
  },
  {
    name: 'a job without repair_base is a KeyError after the first result probe',
    want: error('KeyError', "'repair_base'"),
    reads: [R],
    job: { job: JOB, item: ITEM, source_sha: 's', finding_sha256: 'f' },
  },
  {
    name: 'a job without item is a KeyError, ahead of the later keys',
    want: error('KeyError', "'item'"),
    reads: [R],
    job: { job: JOB },
  },
  {
    name: 'a job without finding_sha256 is a KeyError',
    want: error('KeyError', "'finding_sha256'"),
    reads: [R],
    job: { job: JOB, item: ITEM, repair_base: 'b', source_sha: 's' },
  },
  {
    name: 'a job without a job key fails before any probe',
    want: error('KeyError', "'job'"),
    reads: [],
    job: { item: ITEM },
  },
  {
    name: 'a config without repair fails before any probe',
    want: error('KeyError', "'repair'"),
    reads: [],
    config: {},
  },
  {
    name: 'a repair block without roles is a KeyError once a fresh start is needed',
    want: error('KeyError', "'roles'"),
    reads: [R],
    config: { repair: {} },
  },
  {
    name: 'a repair block without roles is never asked when a terminal result is preserved',
    want: preserved(without()),
    reads: [R, RR],
    config: { repair: {} },
    result: without(),
  },
  {
    name: 'a list repair block is a TypeError at roles',
    want: error('TypeError', 'list indices must be integers or slices, not str'),
    reads: [R],
    config: { repair: [] },
  },
  {
    name: 'a string repair block is a TypeError at roles',
    want: error('TypeError', "string indices must be integers, not 'str'"),
    reads: [R],
    config: { repair: 'x' },
  },
  {
    name: 'a null repair block is a TypeError at roles',
    want: error('TypeError', "'NoneType' object is not subscriptable"),
    reads: [R],
    config: { repair: null },
  },
  {
    name: 'a list repair block is an AttributeError at fallback_models once a deferral is read',
    want: error('AttributeError', "'list' object has no attribute 'get'"),
    reads: [R, RR],
    config: { repair: [] },
    result: past(),
  },
  {
    name: 'a list repair block is never asked for a terminal result',
    want: preserved(without()),
    reads: [R, RR],
    config: { repair: [] },
    result: without(),
  },

  // ---- early preserve: a result without a deferral -------------------------
  {
    name: 'a terminal result is returned as is',
    want: preserved(without({ commits: ['abc'] })),
    reads: [R, RR],
    result: without({ commits: ['abc'] }),
  },
  {
    name: 'a null retry_after is falsy, so the result is returned',
    want: preserved(deferred(null)),
    reads: [R, RR],
    result: deferred(null),
  },
  {
    name: 'an empty-string retry_after is falsy, so the result is returned',
    want: preserved(deferred('')),
    reads: [R, RR],
    result: deferred(''),
  },
  {
    name: 'a zero retry_after is falsy, so the result is returned',
    want: preserved(deferred(0)),
    reads: [R, RR],
    result: deferred(0),
  },
  {
    name: 'a 0.0 retry_after is falsy, so the result is returned',
    want: preserved(raw('{"retry_after":0.0,"v":1.0}')),
    reads: [R, RR],
    result: raw('{"retry_after":0.0,"v":1.0}'),
  },
  {
    name: 'an empty-list retry_after is falsy, so the result is returned',
    want: preserved(deferred([])),
    reads: [R, RR],
    result: deferred([]),
  },
  {
    name: 'a terminal result wins over a newer progress file, which is never probed',
    want: preserved(without()),
    reads: [R, RR],
    result: without(),
    progress: json({ job: JOB, attempts: [] }),
    mtimes: { result: BASE_NS, progress: BASE_NS + SECOND_NS },
  },

  // ---- retry_after against the pinned clock --------------------------------
  stampScenario('a deferral in the far future is preserved', '9999-12-31T23:59:59Z', true),
  stampScenario(
    'a deferral in the past is re-run, without retry_after',
    '2000-01-01T00:00:00Z',
    false,
  ),
  stampScenario(
    'a deferral at exactly now is re-run (strictly greater is required)',
    NOW_STAMP,
    false,
  ),
  stampScenario(
    'a deferral one microsecond ahead is preserved',
    '2026-11-23T12:00:00.000001Z',
    true,
  ),
  stampScenario(
    'a deferral one microsecond behind is re-run',
    '2026-11-23T11:59:59.999999Z',
    false,
  ),
  stampScenario('an aware offset stamp equal to now is re-run', '2026-11-23T20:00:00+08:00', false),
  stampScenario(
    'an aware offset stamp one second ahead is preserved',
    '2026-11-23T20:00:01+08:00',
    true,
  ),
  stampScenario(
    'an aware offset stamp one second behind is re-run',
    '2026-11-23T19:59:59+08:00',
    false,
  ),
  {
    name: 'a lowercase z is not an offset: a ValueError',
    want: error('ValueError'),
    reads: [R, RR],
    result: deferred('2099-01-01T00:00:00z'),
  },
  {
    name: 'a naive stamp is a TypeError, never read as UTC',
    want: error('TypeError', "can't compare offset-naive and offset-aware datetimes"),
    reads: [R, RR],
    result: deferred('2026-11-23T12:00:00'),
  },
  {
    name: 'a naive far-future stamp is still a TypeError',
    want: error('TypeError', "can't compare offset-naive and offset-aware datetimes"),
    reads: [R, RR],
    result: deferred('9999-12-31T23:59:59'),
  },
  {
    name: 'a date-only stamp is naive, so a TypeError',
    want: error('TypeError', "can't compare offset-naive and offset-aware datetimes"),
    reads: [R, RR],
    result: deferred('2099-01-01'),
  },
  {
    name: 'a malformed stamp is a ValueError naming the replaced text',
    want: error('ValueError', "Invalid isoformat string: 'not-a-date'"),
    reads: [R, RR],
    result: deferred('not-a-date'),
  },
  {
    name: 'a Z inside a malformed stamp is rewritten in the message',
    want: error('ValueError', "Invalid isoformat string: 'xZy'".replace('Z', '+00:00')),
    reads: [R, RR],
    result: deferred('xZy'),
  },
  {
    name: 'a stamp with a quote is repr-quoted in the message',
    want: error('ValueError', `Invalid isoformat string: "it's"`),
    reads: [R, RR],
    result: deferred("it's"),
  },
  {
    name: 'a month out of range is a ValueError',
    want: error('ValueError'),
    reads: [R, RR],
    result: deferred('2026-13-01T00:00:00Z'),
  },
  {
    name: 'a 24:00 rollover past 9999-12-31 is a ValueError naming year 10000',
    want: error('ValueError', 'year must be in 1..9999, not 10000'),
    reads: [R, RR],
    result: deferred('9999-12-31T24:00:00+00:00'),
  },
  {
    name: 'a mixed-separator offset is a malformed-stamp ValueError (colon then compact)',
    want: error('ValueError', "Invalid isoformat string: '2099-01-01T00:00:00+01:0203'"),
    reads: [R, RR],
    result: deferred('2099-01-01T00:00:00+01:0203'),
  },
  {
    name: 'a mixed-separator offset is a malformed-stamp ValueError (compact then colon)',
    want: error('ValueError', "Invalid isoformat string: '2099-01-01T00:00:00+0102:03'"),
    reads: [R, RR],
    result: deferred('2099-01-01T00:00:00+0102:03'),
  },
  {
    name: 'a malformed stamp is inert once fallback_models is configured',
    want: selected('result', without()),
    reads: [R, RR, R, RR, P],
    config: FALLBACKS,
    result: deferred('not-a-date'),
  },
  {
    name: 'a far-future stamp is re-run when fallback_models is configured',
    want: selected('result', without()),
    reads: [R, RR, R, RR, P],
    config: FALLBACKS,
    result: deferred('9999-12-31T23:59:59Z'),
  },
  {
    name: 'an empty fallback_models list does not count as configured',
    want: preserved(deferred('9999-12-31T23:59:59Z')),
    reads: [R, RR],
    config: { repair: { ...REPAIR, fallback_models: [] } },
    result: deferred('9999-12-31T23:59:59Z'),
  },
  {
    name: 'a non-string truthy retry_after is an AttributeError at replace (int)',
    want: error('AttributeError', "'int' object has no attribute 'replace'"),
    reads: [R, RR],
    result: deferred(5),
  },
  {
    name: 'a non-string truthy retry_after is an AttributeError at replace (float)',
    want: error('AttributeError', "'float' object has no attribute 'replace'"),
    reads: [R, RR],
    result: raw('{"retry_after":1.0}'),
  },
  {
    name: 'a NaN retry_after is truthy, so an AttributeError at replace',
    want: error('AttributeError', "'float' object has no attribute 'replace'"),
    reads: [R, RR],
    result: raw('{"retry_after":NaN}'),
  },
  {
    name: 'a true retry_after is an AttributeError at replace',
    want: error('AttributeError', "'bool' object has no attribute 'replace'"),
    reads: [R, RR],
    result: deferred(true),
  },
  {
    name: 'a list retry_after is an AttributeError at replace',
    want: error('AttributeError', "'list' object has no attribute 'replace'"),
    reads: [R, RR],
    result: deferred(['2099-01-01T00:00:00Z']),
  },
  {
    name: 'a dict retry_after is an AttributeError at replace',
    want: error('AttributeError', "'dict' object has no attribute 'replace'"),
    reads: [R, RR],
    result: deferred({ a: 1 }),
  },
  {
    name: 'a non-string retry_after is inert once fallback_models is configured',
    want: selected('result', without()),
    reads: [R, RR, R, RR, P],
    config: FALLBACKS,
    result: deferred({ a: 1 }),
  },
  {
    name: 'retry_after is dropped from the re-run result, keeping the other keys in order',
    want: selected(
      'result',
      raw(
        '{"z":1,"job":"crq-R-F1","a":1.0,"attempts":[{"rung":"A0","b":1,"a":2}],"verdict":"FAILED"}',
      ),
    ),
    reads: [R, RR, R, RR, P],
    result: raw(
      '{"z":1,"job":"crq-R-F1","retry_after":"2000-01-01T00:00:00Z","a":1.0,"attempts":[{"rung":"A0","b":1,"a":2}],"verdict":"FAILED"}',
    ),
  },
  {
    name: 'a progress file keeps its own key order, nested keys included',
    want: selected(
      'progress',
      raw(
        '{"verdict":"FAILED","job":"crq-R-F1","attempts":[{"rung":"A0","z":1,"a":2}],"commits":[]}',
      ),
    ),
    reads: [R, R, P, R, RP],
    progress: raw(
      '{"verdict":"FAILED","job":"crq-R-F1","attempts":[{"rung":"A0","z":1,"a":2}],"commits":[]}',
    ),
  },

  // ---- malformed or unreadable result.json ---------------------------------
  {
    name: 'a prior result that is a list is an AttributeError',
    want: error('AttributeError', "'list' object has no attribute 'get'"),
    reads: [R, RR],
    result: json([]),
  },
  {
    name: 'a prior result that is a string is an AttributeError',
    want: error('AttributeError', "'str' object has no attribute 'get'"),
    reads: [R, RR],
    result: json('x'),
  },
  {
    name: 'a prior result that is null is an AttributeError',
    want: error('AttributeError', "'NoneType' object has no attribute 'get'"),
    reads: [R, RR],
    result: raw('null'),
  },
  {
    name: 'a prior result that is an int is an AttributeError',
    want: error('AttributeError', "'int' object has no attribute 'get'"),
    reads: [R, RR],
    result: json(3),
  },
  {
    name: 'a prior result that is a float is an AttributeError',
    want: error('AttributeError', "'float' object has no attribute 'get'"),
    reads: [R, RR],
    result: raw('1.0'),
  },
  {
    name: 'a prior result that is true is an AttributeError',
    want: error('AttributeError', "'bool' object has no attribute 'get'"),
    reads: [R, RR],
    result: json(true),
  },
  {
    name: 'truncated JSON in result.json is a ValueError',
    want: error('ValueError'),
    reads: [R, RR],
    result: raw('{"retry_after":'),
  },
  {
    name: 'an empty result.json is a ValueError',
    want: error('ValueError'),
    reads: [R, RR],
    result: raw(''),
  },
  {
    name: 'a byte-order mark before the JSON is a ValueError',
    want: error('ValueError'),
    reads: [R, RR],
    result: raw('﻿{"job":"x"}'),
  },
  {
    name: 'invalid UTF-8 in result.json is a ValueError',
    want: error('ValueError'),
    reads: [R, RR],
    result: BAD_UTF8,
  },
  {
    name: 'a result.json that is a directory exists but cannot be read: OSError',
    want: error('OSError'),
    reads: [R, RR],
    result: DIR,
  },
  {
    name: 'a dangling result.json symlink does not exist, so the job starts fresh',
    want: selected('fresh', json(FRESH)),
    reads: [...FIRST_PASS],
    result: link('missing-target.json'),
  },
  {
    name: 'a self-referencing result.json symlink (ELOOP) does not exist either',
    want: selected('fresh', json(FRESH)),
    reads: [...FIRST_PASS],
    result: link('result.json'),
  },

  // ---- progress selection --------------------------------------------------
  {
    name: 'progress alone (no result) is selected',
    want: selected('progress', json({ job: JOB, attempts: [{ rung: 'A0' }] })),
    reads: [R, R, P, R, RP],
    progress: json({ job: JOB, attempts: [{ rung: 'A0' }] }),
  },
  {
    name: 'a result and a progress file one second newer: progress wins',
    want: selected('progress', json({ job: JOB, from: 'progress' })),
    reads: [R, RR, R, RR, P, R, SP, SR, RP],
    result: past({ from: 'result' }),
    progress: json({ job: JOB, from: 'progress' }),
    mtimes: { result: BASE_NS, progress: BASE_NS + SECOND_NS },
  },
  {
    name: 'a result and a progress file one second older: the result stands, progress is never read',
    want: selected('result', without({ from: 'result' })),
    reads: [R, RR, R, RR, P, R, SP, SR],
    result: past({ from: 'result' }),
    progress: raw('{ not json'),
    mtimes: { result: BASE_NS + SECOND_NS, progress: BASE_NS },
  },
  {
    name: 'equal modification times keep the result (strictly newer is required)',
    want: selected('result', without({ from: 'result' })),
    reads: [R, RR, R, RR, P, R, SP, SR],
    result: past({ from: 'result' }),
    progress: json({ job: JOB, from: 'progress' }),
    mtimes: { result: BASE_NS, progress: BASE_NS },
  },
  {
    name: 'a progress file newer by exactly one nanosecond wins',
    want: selected('progress', json({ job: JOB, from: 'progress' })),
    reads: [R, RR, R, RR, P, R, SP, SR, RP],
    result: past({ from: 'result' }),
    progress: json({ job: JOB, from: 'progress' }),
    mtimes: { result: BASE_NS, progress: BASE_NS + 1n },
  },
  {
    name: 'a progress file older by exactly one nanosecond loses',
    want: selected('result', without({ from: 'result' })),
    reads: [R, RR, R, RR, P, R, SP, SR],
    result: past({ from: 'result' }),
    progress: json({ job: JOB, from: 'progress' }),
    mtimes: { result: BASE_NS + 1n, progress: BASE_NS },
  },
  {
    name: 'a re-run deferral with fallbacks competes with progress on its own mtime',
    want: selected('progress', json({ job: JOB, from: 'progress' })),
    reads: [R, RR, R, RR, P, R, SP, SR, RP],
    config: FALLBACKS,
    result: deferred('9999-12-31T23:59:59Z'),
    progress: json({ job: JOB, from: 'progress' }),
    mtimes: { result: BASE_NS, progress: BASE_NS + 1n },
  },
  {
    name: 'a result without a deferral only exists to be preserved: older progress is irrelevant',
    want: preserved(without()),
    reads: [R, RR],
    result: without(),
    progress: json({ job: JOB }),
    mtimes: { result: BASE_NS + SECOND_NS, progress: BASE_NS },
  },
  {
    name: 'a winning progress file that is malformed is a ValueError',
    want: error('ValueError'),
    reads: [R, R, P, R, RP],
    progress: raw('{"attempts":'),
  },
  {
    name: 'a winning progress file with invalid UTF-8 is a ValueError',
    want: error('ValueError'),
    reads: [R, R, P, R, RP],
    progress: BAD_UTF8,
  },
  {
    name: 'a winning progress file that is a directory is an OSError',
    want: error('OSError'),
    reads: [R, R, P, R, RP],
    progress: DIR,
  },
  {
    name: 'a progress file that is a list is selected as is (the next step raises, not this one)',
    want: selected('progress', json([1, 2])),
    reads: [R, R, P, R, RP],
    progress: json([1, 2]),
  },
  {
    name: 'a null progress file is selected as is',
    want: selected('progress', raw('null')),
    reads: [R, R, P, R, RP],
    progress: raw('null'),
  },
  {
    name: 'progress keeps int and float kinds and a decoded NaN',
    want: selected('progress', raw('{"a":1,"b":1.0,"c":NaN,"big":123456789012345678901234567890}')),
    reads: [R, R, P, R, RP],
    progress: raw('{"a":1,"b":1.0,"c":NaN,"big":123456789012345678901234567890}'),
  },
  {
    name: 'a dangling progress symlink does not exist, so a result alone stands',
    want: selected('result', without({ from: 'result' })),
    reads: [R, RR, R, RR, P],
    result: past({ from: 'result' }),
    progress: link('missing-target.json'),
  },
  {
    name: 'a self-referencing progress symlink (ELOOP) does not exist either',
    want: selected('fresh', json(FRESH)),
    reads: [...FIRST_PASS],
    progress: link('progress.json'),
  },

  // ---- result.json changing between probes (Python reads it twice) ---------
  {
    name: 'a result that vanishes after the first read starts fresh',
    want: selected('fresh', json(FRESH)),
    reads: [R, RR, R, P],
    result: past(),
    resultExists: [true, false],
  },
  {
    name: 'a result that vanishes before the mtime comparison lets progress win unconditionally',
    want: selected('progress', json({ job: JOB, from: 'progress' })),
    reads: [R, RR, R, P, R, RP],
    result: past(),
    resultExists: [true, false, false],
    progress: json({ job: JOB, from: 'progress' }),
    mtimes: { result: BASE_NS + SECOND_NS, progress: BASE_NS },
  },
  {
    name: 'a second read that returns a list is a TypeError at pop',
    want: error('TypeError', 'pop expected at most 1 argument, got 2'),
    reads: [R, RR, R, RR],
    result: past(),
    resultBodies: [past(), json([])],
  },
  {
    name: 'a second read that returns a string is an AttributeError at pop',
    want: error('AttributeError', "'str' object has no attribute 'pop'"),
    reads: [R, RR, R, RR],
    result: past(),
    resultBodies: [past(), json('x')],
  },
  {
    name: 'a second read that returns null is an AttributeError at pop',
    want: error('AttributeError', "'NoneType' object has no attribute 'pop'"),
    reads: [R, RR, R, RR],
    result: past(),
    resultBodies: [past(), raw('null')],
  },
  {
    name: 'a second read that returns a number is an AttributeError at pop',
    want: error('AttributeError', "'int' object has no attribute 'pop'"),
    reads: [R, RR, R, RR],
    result: past(),
    resultBodies: [past(), json(7)],
  },
  {
    name: 'a second read that is malformed is a ValueError',
    want: error('ValueError'),
    reads: [R, RR, R, RR],
    result: past(),
    resultBodies: [past(), raw('{')],
  },
  {
    name: 'a second read without a deferral is honoured as the selected result',
    want: selected('result', without({ from: 'second' })),
    reads: [R, RR, R, RR, P],
    result: past(),
    resultBodies: [past(), without({ from: 'second' })],
  },
  {
    name: 'a second read that regains a future deferral drops it without re-comparing',
    want: selected('result', without({ from: 'second' })),
    reads: [R, RR, R, RR, P],
    result: past(),
    resultBodies: [
      past(),
      json({ job: JOB, verdict: 'FAILED', retry_after: '9999-12-31T23:59:59Z', from: 'second' }),
    ],
  },
];

interface Laid {
  readonly scenario: Scenario;
  readonly root: string;
  readonly dir: string;
}

const fileText = (spec: FileSpec): string => {
  if ('json' in spec) return JSON.stringify(spec.json);
  if ('raw' in spec) return spec.raw;
  throw new Error('not a text fixture');
};

function writeSpec(dir: string, name: string, spec: FileSpec): void {
  const path = join(dir, name);
  if ('dir' in spec) mkdirSync(path);
  else if ('link' in spec) symlinkSync(spec.link, path);
  else if ('badUtf8' in spec) writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
  else writeFileSync(path, fileText(spec));
}

function lay(scenario: Scenario): Laid {
  const root = mkdtempSync(join(tmpdir(), 'repair-progress-'));
  dirs.push(root);
  const dir = join(root, 'state', 'repair', JOB);
  mkdirSync(dir, { recursive: true });
  if (scenario.result !== undefined) writeSpec(dir, 'result.json', scenario.result);
  if (scenario.progress !== undefined) writeSpec(dir, 'progress.json', scenario.progress);
  return { scenario, root, dir };
}

/** `json.loads(text)` as the port's readers see it: numbers keep their int/float kind. */
function parseFixtureText(text: string): unknown {
  try {
    return toPlainJsonRetainingNumbers(parseJsonValue(text, { parseConstant: pythonNonFinite }));
  } catch (e) {
    throw new PyError('ValueError', e instanceof Error ? e.message : String(e));
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `json.loads(path.read_text())`: OSError when the read fails, ValueError when decoding or parsing does. */
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

/** `Path.exists()` on CPython 3.14: a successful `stat`, and false for every stat error. */
function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Set every pinned modification time in one Python call, and read each back. */
function applyMtimes(laid: readonly Laid[]): void {
  const jobs = laid.flatMap(({ scenario, dir }) =>
    (['result', 'progress'] as const).flatMap((name) => {
      const ns = scenario.mtimes?.[name];
      return ns === undefined ? [] : [{ path: join(dir, `${name}.json`), ns: ns.toString() }];
    }),
  );
  if (jobs.length === 0) return;
  execFileSync(
    'python3',
    [
      '-I',
      '-B',
      '-c',
      `
import json, os, sys
for job in json.loads(sys.argv[1]):
    ns = int(job['ns'])
    os.utime(job['path'], ns=(ns, ns))
    got = os.stat(job['path']).st_mtime_ns
    if got != ns:
        raise SystemExit('filesystem kept %d, wanted %d: ' % (got, ns) + job['path'])
`,
      JSON.stringify(jobs),
    ],
    { encoding: 'utf8' },
  );
}

const PY = String.raw`
import datetime as _dt, importlib.util, json, pathlib, sys, types
from unittest import mock
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location('repair_progress_oracle', pathlib.Path(sys.argv[1]) / 'crq_repair.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

NOW = _dt.datetime(2026, 11, 23, 12, 0, 0, tzinfo=_dt.timezone.utc)
class PinnedDatetime(_dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW if tz is None else NOW.astimezone(tz)
pinned = types.SimpleNamespace(**{k: getattr(_dt, k) for k in dir(_dt) if not k.startswith('_')})
pinned.datetime = PinnedDatetime
service.dt = pinned
service.utc = lambda: sys.argv[3]

# The first statement after the selection: where the worktree selection starts.
lines = pathlib.Path(service.__file__).read_text().splitlines()
STOP = [i + 1 for i, l in enumerate(lines) if l.startswith("    if result.get('dispatch_pending') or result.get('pending_judge')")]
assert len(STOP) == 1, STOP
STOP = STOP[0]
PROCESS = service.process.__code__

class Stop(Exception):
    pass

captured = {}
def tracer(frame, event, arg):
    if frame.f_code is not PROCESS:
        return None
    def local(frame, event, arg):
        if event == 'line' and frame.f_lineno == STOP:
            captured['result'] = json.dumps(frame.f_locals['result'])
            captured['resume'] = frame.f_locals['resume_progress']
            raise Stop
        return local
    return local

out = []
for s in json.loads(sys.argv[2]):
    root = pathlib.Path(s['root'])
    service.ROOT = root
    jobdir = root / 'state' / 'repair' / s['job_id']
    reads = []
    counters = {'exists': 0, 'read': 0}
    def name(path, jobdir=jobdir):
        try:
            return str(path.relative_to(jobdir))
        except ValueError:
            return None
    orig_exists, orig_stat, orig_read = pathlib.Path.exists, pathlib.Path.stat, pathlib.Path.read_text
    def exists(self, *a, reads=reads, counters=counters, s=s, orig=orig_exists, **k):
        n = name(self)
        if n is None:
            return orig(self, *a, **k)
        reads.append('exists ' + n)
        if n == 'result.json':
            i = counters['exists']
            counters['exists'] += 1
            if s['result_exists'] is not None and i < len(s['result_exists']):
                return s['result_exists'][i]
        return orig(self, *a, **k)
    def stat(self, *a, reads=reads, orig=orig_stat, **k):
        n = name(self)
        if n is not None:
            reads.append('stat ' + n)
        return orig(self, *a, **k)
    def read_text(self, *a, reads=reads, counters=counters, s=s, orig=orig_read, **k):
        n = name(self)
        if n is None:
            return orig(self, *a, **k)
        reads.append('read ' + n)
        if n == 'result.json':
            i = counters['read']
            counters['read'] += 1
            if s['result_bodies'] is not None and i < len(s['result_bodies']):
                return s['result_bodies'][i]
        return orig(self, *a, **k)
    entry = {}
    captured.clear()
    with mock.patch.object(pathlib.Path, 'exists', exists), \
         mock.patch.object(pathlib.Path, 'stat', stat), \
         mock.patch.object(pathlib.Path, 'read_text', read_text):
        sys.settrace(tracer)
        try:
            value = service.process(json.loads(s['config']), json.loads(s['job']), s['worktree'])
            entry['kind'] = 'preserved'
            entry['result'] = json.dumps(value)
        except Stop:
            entry['kind'] = 'selected'
            entry['result'] = captured['result']
            entry['resume'] = captured['resume']
        except Exception as e:
            entry['error'] = 'OSError' if isinstance(e, OSError) else (
                'ValueError' if isinstance(e, ValueError) else type(e).__name__)
            entry['message'] = str(e)
        finally:
            sys.settrace(None)
    entry['reads'] = reads
    out.append(entry)
print(json.dumps(out))
`;

interface Outcome {
  readonly kind?: 'preserved' | 'selected';
  readonly resumed?: boolean;
  readonly result?: unknown;
  /** Dict key order of `result`, recursively: `toEqual` ignores it, so it is asserted separately. */
  readonly order?: unknown;
  readonly error?: string;
  readonly message?: string;
  readonly reads: readonly string[];
}

/** The messages worth comparing: those Python builds from the value, never a path or a JSON offset. */
const MESSAGE_KINDS = new Set(['AttributeError', 'TypeError', 'KeyError']);

/**
 * Insertion order of every dict key in `value`, recursively. Plain JS objects order
 * integer-like keys ascending ahead of the rest, so a key such as `"2"` cannot keep
 * Python's position: see the documented-limitation test below. The names the repair
 * result and progress files use (`job`, `attempts`, `rung`, ...) are all non-integer.
 */
function orderOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderOf);
  if (typeof value === 'object' && value !== null && !(value instanceof JsonNumber)) {
    return Object.entries(value).map(([key, inner]) => [key, orderOf(inner)]);
  }
  return null;
}

/** An outcome with the key order of its result made comparable. */
function ordered(outcome: Outcome): Outcome {
  return 'result' in outcome ? { ...outcome, order: orderOf(outcome.result) } : outcome;
}

function view(outcome: Outcome, want: Want): Outcome {
  if (outcome.error === undefined) return outcome;
  const keep =
    MESSAGE_KINDS.has(outcome.error) || ('message' in want && want.message !== undefined);
  const { message: _drop, ...rest } = outcome;
  return keep && outcome.message !== undefined ? outcome : rest;
}

function runPython(laid: readonly Laid[]): Outcome[] {
  const specs = laid.map(({ scenario, root }) => ({
    root,
    job_id: JOB,
    config: JSON.stringify(scenario.config ?? CONFIG),
    job: JSON.stringify(scenario.job ?? JOB_DICT),
    worktree: WORKTREE,
    result_exists: scenario.resultExists ?? null,
    result_bodies: scenario.resultBodies?.map(fileText) ?? null,
  }));
  const stdout = execFileSync(
    'python3',
    ['-I', '-B', '-c', PY, PYTHON_DIR, JSON.stringify(specs), NOW_STAMP],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return (JSON.parse(stdout) as Array<Record<string, unknown>>).map((entry): Outcome => {
    const reads = entry.reads as readonly string[];
    if (typeof entry.error === 'string') {
      return { error: entry.error, message: entry.message as string, reads };
    }
    const result = parseFixtureText(entry.result as string);
    if (entry.kind === 'preserved') return { kind: 'preserved', result, reads };
    return {
      kind: 'selected',
      resumed: entry.resume === true,
      result,
      reads,
    };
  });
}

function tsReads(
  { scenario, dir }: Laid,
  log: string[],
  clock: { now: () => bigint; utc: () => string } = {
    now: () => NOW_MICROS,
    utc: () => NOW_STAMP,
  },
): RepairProgressSelectionReads {
  const resultPath = join(dir, 'result.json');
  const progressPath = join(dir, 'progress.json');
  let existsCalls = 0;
  let readCalls = 0;
  const mtimeNs = (path: string): Promise<bigint> => {
    try {
      return Promise.resolve(statSync(path, { bigint: true }).mtimeNs);
    } catch (e) {
      return Promise.reject(new PyError('OSError', e instanceof Error ? e.message : String(e)));
    }
  };
  return {
    resultExists: () => {
      log.push(R);
      const scripted = scenario.resultExists?.[existsCalls];
      existsCalls += 1;
      return Promise.resolve(scripted ?? pathExists(resultPath));
    },
    readResult: () => {
      log.push(RR);
      const body = scenario.resultBodies?.[readCalls];
      readCalls += 1;
      return Promise.resolve().then(() =>
        body === undefined ? readJsonFile(resultPath) : parseFixtureText(fileText(body)),
      );
    },
    progressExists: () => {
      log.push(P);
      return Promise.resolve(pathExists(progressPath));
    },
    resultMtimeNs: () => {
      log.push(SR);
      return mtimeNs(resultPath);
    },
    progressMtimeNs: () => {
      log.push(SP);
      return mtimeNs(progressPath);
    },
    readProgress: () => {
      log.push(RP);
      return Promise.resolve().then(() => readJsonFile(progressPath));
    },
    nowMicros: clock.now,
    utc: clock.utc,
  };
}

const configOf = (scenario: Scenario): unknown =>
  parseFixtureText(JSON.stringify(scenario.config ?? CONFIG));
const jobOf = (scenario: Scenario): unknown =>
  parseFixtureText(JSON.stringify(scenario.job ?? JOB_DICT));

async function runTs(laid: Laid): Promise<Outcome> {
  const reads: string[] = [];
  const { scenario } = laid;
  try {
    const decision = await selectRepairProgress(
      { config: configOf(scenario), job: jobOf(scenario), worktree: WORKTREE },
      tsReads(laid, reads),
    );
    if (decision.kind === 'preserved') return { kind: 'preserved', result: decision.result, reads };
    return {
      kind: 'selected',
      resumed: decision.source === 'progress',
      result: decision.result,
      reads,
    };
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    return { error: e.kind, message: e.message, reads };
  }
}

/** What a scenario's `want` normalises to (the `source` Python cannot see is only `progress` or not). */
function expected(scenario: Scenario): Outcome {
  const { want, reads } = scenario;
  if ('error' in want) {
    return {
      error: want.error,
      ...(want.message === undefined ? {} : { message: want.message }),
      reads,
    };
  }
  const result = parseFixtureText(fileText(want.result));
  if (want.kind === 'preserved') return { kind: 'preserved', result, reads };
  return {
    kind: 'selected',
    resumed: want.source === 'progress',
    result,
    reads,
  };
}

describe('result/progress selection (process) against Python crq_repair.process', () => {
  const laid = SCENARIOS.map(lay);
  applyMtimes(laid);
  const python = runPython(laid);

  it('has uniquely named scenarios', () => {
    const names = SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('pins a modification time whenever both files are real files', () => {
    for (const scenario of SCENARIOS) {
      const real = (spec: FileSpec | undefined): boolean => spec !== undefined && !('link' in spec);
      if (real(scenario.result) && real(scenario.progress)) {
        expect(scenario.mtimes, scenario.name).toBeDefined();
      }
    }
  });

  it.each(SCENARIOS.map((scenario, index) => [scenario.name, index] as const))(
    '%s',
    async (_name, index) => {
      const item = laid[index];
      const oracle = python[index];
      if (item === undefined || oracle === undefined) throw new Error('missing scenario');
      const want = expected(item.scenario);
      expect(ordered(view(oracle, item.scenario.want))).toEqual(ordered(want));
      expect(ordered(view(await runTs(item), item.scenario.want))).toEqual(ordered(want));
    },
  );

  it('selects each of the three sources and both preserve and every error class', () => {
    const sources = new Set<string>();
    const kinds = new Set<string>();
    const errors = new Set<string>();
    for (const { want } of SCENARIOS) {
      if ('error' in want) errors.add(want.error);
      else {
        kinds.add(want.kind);
        if (want.kind === 'selected') sources.add(want.source);
      }
    }
    expect([...sources].sort()).toEqual(['fresh', 'progress', 'result']);
    expect([...kinds].sort()).toEqual(['preserved', 'selected']);
    expect([...errors].sort()).toEqual([
      'AttributeError',
      'KeyError',
      'OSError',
      'TypeError',
      'ValueError',
    ]);
  });

  it('reports the exact source the oracle cannot see (result vs fresh vs progress)', async () => {
    for (const [index, scenario] of SCENARIOS.entries()) {
      if (!('kind' in scenario.want) || scenario.want.kind !== 'selected') continue;
      const item = laid[index];
      if (item === undefined) throw new Error('missing scenario');
      const decision: RepairProgressSelection = await selectRepairProgress(
        { config: configOf(scenario), job: jobOf(scenario), worktree: WORKTREE },
        tsReads(item, []),
      );
      expect(decision.kind, scenario.name).toBe('selected');
      if (decision.kind === 'selected')
        expect(decision.source, scenario.name).toBe(scenario.want.source);
    }
  });
});

describe('selection reads: laziness, purity and failure transparency (TS side)', () => {
  const fresh = (scenario: Partial<Scenario> = {}): Laid =>
    lay({ name: 'x', want: error('X'), reads: [], ...scenario });
  const ask = (laid: Laid, log: string[], clock?: { now: () => bigint; utc: () => string }) =>
    selectRepairProgress(
      { config: configOf(laid.scenario), job: jobOf(laid.scenario), worktree: WORKTREE },
      tsReads(laid, log, clock),
    );

  it('reads the clock only when a deferral without fallbacks is compared', async () => {
    const calls: string[] = [];
    const clock = {
      now: () => {
        calls.push('now');
        return NOW_MICROS;
      },
      utc: () => {
        calls.push('utc');
        return NOW_STAMP;
      },
    };
    await ask(fresh({ result: without() }), [], clock);
    expect(calls).toEqual([]);
    await ask(fresh({ result: past(), config: FALLBACKS }), [], clock);
    expect(calls).toEqual(['utc']);
    calls.length = 0;
    await ask(fresh({ result: past() }), [], clock);
    expect(calls).toEqual(['now', 'utc']);
  });

  it('documented limitation: integer-like keys reorder in a plain object, unlike a Python dict', async () => {
    // Python keeps `2, 1, z` after `pop('retry_after')`; a JS object lists integer-like
    // keys ascending first. The representation is deliberately unchanged, and every key
    // the repair files really use is non-integer (pinned in order by the scenarios above).
    const body = '{"2":"b","1":"a","z":"c","retry_after":"2000-01-01T00:00:00Z"}';
    const laid = fresh({ result: raw(body) });
    const decision = await ask(laid, []);
    expect(decision.kind === 'selected' && Object.keys(decision.result as object)).toEqual([
      '1',
      '2',
      'z',
    ]);
    expect(decision.kind === 'selected' && decision.result).toEqual({ 2: 'b', 1: 'a', z: 'c' });
  });

  it('does not mutate the prior result it removes retry_after from', async () => {
    const laid = fresh({ result: past({ keep: 1 }) });
    const prior = parseFixtureText(fileText(past({ keep: 1 }))) as Record<string, unknown>;
    const reads = tsReads(laid, []);
    const original = reads.readResult;
    let handed: Record<string, unknown> | undefined;
    reads.readResult = async () => {
      handed = (await original()) as Record<string, unknown>;
      return handed;
    };
    const decision = await selectRepairProgress(
      { config: configOf(laid.scenario), job: jobOf(laid.scenario), worktree: WORKTREE },
      reads,
    );
    expect(handed).toEqual(prior);
    expect(decision.kind === 'selected' && decision.result).not.toBe(handed);
    expect(handed).toHaveProperty('retry_after');
  });

  it('propagates an existence probe failure instead of reading it as absent', async () => {
    const laid = fresh();
    const log: string[] = [];
    const reads = tsReads(laid, log);
    reads.resultExists = () => {
      log.push(R);
      return Promise.reject(new PyError('OSError', 'EACCES'));
    };
    await expect(
      selectRepairProgress({ config: CONFIG, job: JOB_DICT, worktree: WORKTREE }, reads),
    ).rejects.toMatchObject({ kind: 'OSError' });
    expect(log).toEqual([R]);
  });

  it('propagates a stat failure after both probes, before progress is read', async () => {
    const laid = fresh({
      result: past(),
      progress: json({ job: JOB }),
      mtimes: { result: BASE_NS, progress: BASE_NS },
    });
    const log: string[] = [];
    const reads = tsReads(laid, log);
    reads.progressMtimeNs = () => {
      log.push(SP);
      return Promise.reject(new PyError('OSError', 'vanished'));
    };
    await expect(
      selectRepairProgress({ config: CONFIG, job: JOB_DICT, worktree: WORKTREE }, reads),
    ).rejects.toMatchObject({ kind: 'OSError' });
    expect(log).toEqual([R, RR, R, RR, P, R, SP]);
  });

  it('propagates a failing result read, and never retries it', async () => {
    const laid = fresh({ result: without() });
    const log: string[] = [];
    const reads = tsReads(laid, log);
    reads.readResult = () => {
      log.push(RR);
      return Promise.reject(new PyError('ValueError', 'bad'));
    };
    await expect(
      selectRepairProgress({ config: CONFIG, job: JOB_DICT, worktree: WORKTREE }, reads),
    ).rejects.toMatchObject({ kind: 'ValueError' });
    expect(log).toEqual([R, RR]);
  });
});

describe('malformed retry_after message parity with Python (repr of the stamp)', () => {
  /** CPython 3.14 is the production minor; the default python3 is the fallback where it is absent. */
  const python = ((): string => {
    try {
      execFileSync('python3.14', ['-I', '-B', '-c', 'pass']);
      return 'python3.14';
    } catch {
      return 'python3';
    }
  })();

  const SCRIPT = String.raw`
import datetime, json, sys, unicodedata
printable = [chr(c).isprintable() for c in range(0x110000)]
sample = set(range(0x300))
for c in range(1, 0x110000):
    if printable[c] != printable[c - 1]:
        sample.update(x for x in (c - 1, c, c + 1) if 0 <= x < 0x110000)
sample.update(range(0x1F600, 0x1F610))
out = []
for c in sorted(sample):
    stamp = 'x' + chr(c) + 'y'
    try:
        datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        message = None
    except ValueError as e:
        message = str(e)
    out.append([c, unicodedata.category(chr(c)) == 'Cn', message])
for stamp in json.loads(sys.argv[1]):
    try:
        datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        message = None
    except ValueError as e:
        message = str(e)
    out.append([stamp, False, message])
print(json.dumps(out))
`;

  const TEXTS = [
    "it's",
    'say "hi"',
    `both ' and "`,
    'back\\slash',
    'tab\there',
    'new\nline',
    'cr\rhere',
    'x\u00a0y',
    'x\u200by',
    'x\u2028y',
    'x\ufeffy',
    'x\u00ady',
    'caf\u00e9 \u65e5\u672c \u{1F600}',
    'x\u{e0001}y',
    'x\ud800y',
    'xZy',
  ];

  const askStamp = async (stamp: string): Promise<string> => {
    const reads: RepairProgressSelectionReads = {
      resultExists: () => Promise.resolve(true),
      readResult: () => Promise.resolve({ retry_after: stamp }),
      progressExists: () => Promise.resolve(false),
      resultMtimeNs: () => Promise.reject(new Error('unexpected')),
      progressMtimeNs: () => Promise.reject(new Error('unexpected')),
      readProgress: () => Promise.reject(new Error('unexpected')),
      nowMicros: () => NOW_MICROS,
      utc: () => NOW_STAMP,
    };
    try {
      await selectRepairProgress({ config: CONFIG, job: JOB_DICT, worktree: WORKTREE }, reads);
    } catch (e) {
      if (e instanceof PyError) return `${e.kind}: ${e.message}`;
      throw e;
    }
    return 'none';
  };

  it('escapes every non-printable code point and keeps printable text, like Python repr', async () => {
    const stdout = execFileSync(python, ['-I', '-B', '-c', SCRIPT, JSON.stringify(TEXTS)], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const rows = JSON.parse(stdout) as Array<[number | string, boolean, string | null]>;
    expect(rows.length).toBeGreaterThan(1000);
    let compared = 0;
    let skewed = 0;
    for (const [what, unassigned, message] of rows) {
      const stamp = typeof what === 'number' ? `x${String.fromCodePoint(what)}y` : what;
      // A code point still unassigned in this Python's tables (3.14: Unicode 16) is
      // version skew against the runtime's tables, not a repr difference.
      if (unassigned) {
        skewed += 1;
        continue;
      }
      expect(message, JSON.stringify(stamp)).not.toBeNull();
      expect(await askStamp(stamp), JSON.stringify(stamp)).toBe(`ValueError: ${message}`);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(1000);
    expect(skewed).toBeLessThan(compared);
  });
});
