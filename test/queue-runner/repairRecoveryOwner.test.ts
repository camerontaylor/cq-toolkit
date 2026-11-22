/**
 * Differential test for the recovery ownership preflight
 * (src/queue-runner/repairRecoveryOwner.ts) against Python's
 * `crq_repair.recover_job`, whose `check_owner` closure it ports.
 *
 * Offline and read-only by construction. The oracle runs the REAL
 * `recover_job` over a throwaway tree with `crq` replaced by a fake that serves
 * the scenario's queue and runs the closure directly (no lock), `finding_inbox`
 * replaced by the scenario's retained events, and `recovery.recover` replaced by
 * a sentinel, so the judge, preparation, worktrees and ledger are never reached.
 * Nothing leaves the fixture root and no provider, queue host or live state is
 * read.
 *
 * Both sides read the same files and the same queue and events, and both record
 * which reads they made, so the lazy order (a refusal never asks a later
 * question) is pinned as well as the verdict. Each scenario also names its
 * expected outcome, so a drift of both implementations together still fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkRepairJobId } from '../../src/adapters/crq/repairPreparation.js';
import { fileRepairHarvestReads } from '../../src/adapters/crq/repairHarvestReads.js';
import {
  parseJsonValue,
  pythonNonFinite,
  toPlainJsonRetainingNumbers,
} from '../../src/policy/crq/jsonValue.js';
import { PyError, type PyErrorKind } from '../../src/queue-runner/pyErrors.js';
import {
  decideRecoveryOwner,
  type RecoveryOwnerRefusal,
  type RepairRecoveryOwnerReads,
} from '../../src/queue-runner/repairRecoveryOwner.js';

const PYTHON_DIR = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const JOB = 'crq-R-F1';
const RETRY = 'crq-R-F2';
const RUN = 'R';
const ITEM = 'pr1-merged';
const FID = 'a'.repeat(64);
const EVENT = 'evt-1';

/** The `ValueError` texts `check_owner` raises, written out independently of the module. */
const REASON: Readonly<Record<RecoveryOwnerRefusal, string>> = {
  'not-tick-owned': 'job lacks tick-owned repair record',
  'already-published': 'repair already published or superseded',
  'invalid-canonical-identity': 'invalid canonical finding identity',
  'owner-decision-required': 'finding requires an explicit owner decision',
  'canonical-finding-reassigned': 'canonical finding no longer belongs to this repair',
  'already-superseded': 'repair already superseded',
};
const REFUSAL_OF = new Map(
  (Object.entries(REASON) as Array<[RecoveryOwnerRefusal, string]>).map(([slug, text]) => [
    text,
    slug,
  ]),
);

type Expect =
  | 'ok'
  | RecoveryOwnerRefusal
  | { readonly error: PyErrorKind; readonly message?: string };

/** A file's content: JSON for a value, or the exact text for `{ raw }`. */
type FileBody = unknown;
const raw = (text: string): { raw: string } => ({ raw: text });

interface Scenario {
  readonly name: string;
  readonly expect: Expect;
  /** Reads made inside the check, in order, relative to the fixture root. */
  readonly reads: readonly string[];
  readonly queue: unknown;
  /** The job file; `undefined` keeps the default job. */
  readonly job?: unknown;
  /** Files under the fixture root (relative path -> body). */
  readonly files?: Readonly<Record<string, FileBody>>;
  /** Retained events, or a failure to raise when they are read. */
  readonly events?: readonly unknown[] | { readonly raises: 'ValueError' };
}

const queueOf = (record: unknown, extra: readonly unknown[] = [], runs?: unknown): unknown => ({
  items: [...extra, { id: ITEM, repair_runs: runs === undefined ? { [RUN]: record } : runs }],
});
const owned = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  jobs: [JOB],
  state: 'queued',
  ...over,
});
const jobWith = (over: Record<string, unknown>): Record<string, unknown> => ({
  job: JOB,
  item: ITEM,
  run: RUN,
  ...over,
});
const triage = (fid: string): string => `state/backfill/findings/triage/${fid}.json`;
const inbox = (id: string): string => `state/repair/inbox/${id}.json`;
const QUEUE_OK = queueOf(owned());
const retry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  job: RETRY,
  origin_job: JOB,
  recovery_worktree: true,
  ...over,
});
const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: EVENT,
  payload: { actor: 'crq-repair', finding_id: FID, evidence: { repair_task: JOB } },
  ...over,
});
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'delivered',
  receipt: { repair_task: JOB },
  ...over,
});

/** A canonical-finding scenario: the job names `FID`, the triage row is `rowBody`. */
function canonical(
  name: string,
  expected: Expect,
  rowBody: FileBody,
  extra: Partial<Scenario> = {},
  jobOver: Record<string, unknown> = {},
): Scenario {
  const reads = [
    'queue',
    ...(rowBody === undefined ? [triage(FID)] : [triage(FID)]),
    ...(extra.reads ?? []),
  ];
  const { reads: _ignored, ...rest } = extra;
  void _ignored;
  return {
    name,
    expect: expected,
    reads,
    queue: QUEUE_OK,
    job: jobWith({ canonical_finding_id: FID, ...jobOver }),
    files: { ...(rowBody === undefined ? {} : { [triage(FID)]: rowBody }), ...rest.files },
    ...(rest.events === undefined ? {} : { events: rest.events }),
  };
}

const NEEDS_HUMAN_ROW = row({ status: 'needs-human', previous_event_id: EVENT });

const SCENARIOS: readonly Scenario[] = [
  // ---- tick ownership ------------------------------------------------------
  {
    name: 'an owned queued job passes with no canonical identity',
    expect: 'ok',
    reads: ['queue'],
    queue: QUEUE_OK,
  },
  {
    name: 'the item is not in the queue',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: { items: [] },
  },
  { name: 'the queue has no items key', expect: 'not-tick-owned', reads: ['queue'], queue: {} },
  {
    name: 'the run is not recorded',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: queueOf(undefined, [], { other: owned() }),
  },
  {
    name: 'an empty run record is falsy',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: queueOf({}),
  },
  {
    name: 'the record lists other jobs',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: queueOf(owned({ jobs: ['crq-R-F9'] })),
  },
  {
    name: 'the record has no jobs',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: queueOf({ state: 'queued' }),
  },
  {
    name: 'the job is not in the item list but a later item matches',
    expect: 'ok',
    reads: ['queue'],
    queue: queueOf(owned(), [{ id: 'other', repair_runs: {} }]),
  },
  {
    name: 'the first item with the id wins over a later duplicate',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: {
      items: [
        { id: ITEM, repair_runs: {} },
        { id: ITEM, repair_runs: { [RUN]: owned() } },
      ],
    },
  },
  {
    name: 'an item without an id equals a job without an item (None == None)',
    expect: 'ok',
    reads: ['queue'],
    queue: { items: [{ repair_runs: { [RUN]: owned() } }] },
    job: { job: JOB, run: RUN },
  },
  {
    name: 'a malformed item after the match is never touched',
    expect: 'ok',
    reads: ['queue'],
    queue: { items: [{ id: ITEM, repair_runs: { [RUN]: owned() } }, 'junk'] },
  },
  {
    name: 'a malformed item before the match is an AttributeError',
    expect: { error: 'AttributeError', message: "'str' object has no attribute 'get'" },
    reads: ['queue'],
    queue: { items: ['junk', { id: ITEM, repair_runs: { [RUN]: owned() } }] },
  },
  {
    name: 'a job file that is not an object is an AttributeError',
    expect: { error: 'AttributeError', message: "'list' object has no attribute 'get'" },
    reads: ['queue'],
    queue: QUEUE_OK,
    job: [],
  },
  {
    name: 'a null repair_runs is an AttributeError',
    expect: { error: 'AttributeError', message: "'NoneType' object has no attribute 'get'" },
    reads: ['queue'],
    queue: queueOf(undefined, [], null),
  },
  {
    name: 'a list repair_runs is an AttributeError',
    expect: { error: 'AttributeError', message: "'list' object has no attribute 'get'" },
    reads: ['queue'],
    queue: queueOf(undefined, [], []),
  },
  {
    name: 'a string record is an AttributeError',
    expect: { error: 'AttributeError', message: "'str' object has no attribute 'get'" },
    reads: ['queue'],
    queue: queueOf('owned'),
  },
  {
    name: 'a true record is an AttributeError',
    expect: { error: 'AttributeError', message: "'bool' object has no attribute 'get'" },
    reads: ['queue'],
    queue: queueOf(true),
  },
  {
    name: 'a list run is unhashable',
    expect: { error: 'TypeError', message: "unhashable type: 'list'" },
    reads: ['queue'],
    queue: QUEUE_OK,
    job: jobWith({ run: [RUN] }),
  },
  {
    name: 'a dict run is unhashable',
    expect: { error: 'TypeError', message: "unhashable type: 'dict'" },
    reads: ['queue'],
    queue: QUEUE_OK,
    job: jobWith({ run: {} }),
  },
  {
    name: 'a numeric run is simply not recorded',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: QUEUE_OK,
    job: jobWith({ run: 1 }),
  },
  {
    name: 'a missing run is simply not recorded',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: QUEUE_OK,
    job: { job: JOB, item: ITEM },
  },
  {
    name: 'jobs as a string matches by substring',
    expect: 'ok',
    reads: ['queue'],
    queue: queueOf(owned({ jobs: `x-${JOB}-y` })),
  },
  {
    name: 'jobs as a string without the id',
    expect: 'not-tick-owned',
    reads: ['queue'],
    queue: queueOf(owned({ jobs: 'crq-R-F9' })),
  },
  {
    name: 'jobs as a dict matches by key',
    expect: 'ok',
    reads: ['queue'],
    queue: queueOf(owned({ jobs: { [JOB]: 0 } })),
  },
  {
    name: 'jobs as null is a TypeError',
    expect: { error: 'TypeError', message: "argument of type 'NoneType' is not iterable" },
    reads: ['queue'],
    queue: queueOf(owned({ jobs: null })),
  },
  {
    name: 'jobs as a number is a TypeError',
    expect: { error: 'TypeError', message: "argument of type 'int' is not iterable" },
    reads: ['queue'],
    queue: queueOf(owned({ jobs: 3 })),
  },

  // ---- published / superseded ---------------------------------------------
  {
    name: 'a fix_pr refuses',
    expect: 'already-published',
    reads: ['queue'],
    queue: queueOf(owned({ fix_pr: 'https://example.invalid/pull/1' })),
  },
  {
    name: 'a numeric fix_pr refuses',
    expect: 'already-published',
    reads: ['queue'],
    queue: queueOf(owned({ fix_pr: 7 })),
  },
  {
    name: 'a zero fix_pr is falsy',
    expect: 'ok',
    reads: ['queue'],
    queue: queueOf(owned({ fix_pr: 0 })),
  },
  {
    name: 'a null fix_pr is falsy',
    expect: 'ok',
    reads: ['queue'],
    queue: queueOf(owned({ fix_pr: null })),
  },
  {
    name: 'state published refuses',
    expect: 'already-published',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'published' })),
  },
  {
    name: 'state done refuses',
    expect: 'already-published',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'done' })),
  },
  {
    name: 'state failed passes',
    expect: 'ok',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'failed' })),
  },
  {
    name: 'a published record is refused before any canonical read',
    expect: 'already-published',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'published' })),
    job: jobWith({ canonical_finding_id: FID }),
  },

  // ---- canonical identity --------------------------------------------------
  ...[
    ['an uppercase identity', 'A'.repeat(64)],
    ['a short identity', 'a'.repeat(63)],
    ['a long identity', 'a'.repeat(65)],
    ['an identity with a trailing newline', `${'a'.repeat(64)}\n`],
    ['a numeric identity', 5],
    ['a list identity', [FID]],
    ['a dict identity', { id: FID }],
    ['a true identity', true],
  ].map(([name, value]): Scenario => ({
    name: `${String(name)} is invalid`,
    expect: 'invalid-canonical-identity',
    reads: ['queue'],
    queue: QUEUE_OK,
    job: jobWith({ canonical_finding_id: value }),
  })),
  ...[
    ['an empty identity', ''],
    ['a null identity', null],
    ['a zero identity', 0],
    ['an empty list identity', []],
  ].map(([name, value]): Scenario => ({
    name: `${String(name)} is falsy and skips the canonical check`,
    expect: 'ok',
    reads: ['queue'],
    queue: QUEUE_OK,
    job: jobWith({ canonical_finding_id: value }),
  })),
  canonical('a delivered row owned by this job passes', 'ok', row()),
  canonical('a missing triage row is an OSError', { error: 'OSError' }, undefined),
  canonical('a malformed triage row is a ValueError', { error: 'ValueError' }, raw('{"status": ')),
  canonical(
    'a triage row with a byte-order mark is a ValueError',
    { error: 'ValueError' },
    raw('﻿{"status":"delivered"}'),
  ),
  canonical(
    'a triage row with invalid UTF-8 is a ValueError',
    { error: 'ValueError' },
    raw('\u0000'),
  ),
  canonical(
    'a triage row that is not an object is an AttributeError',
    { error: 'AttributeError', message: "'list' object has no attribute 'get'" },
    [],
  ),
  canonical(
    'a null receipt is an AttributeError',
    { error: 'AttributeError', message: "'NoneType' object has no attribute 'get'" },
    row({ receipt: null }),
  ),
  canonical('a missing receipt is no task', 'canonical-finding-reassigned', {
    status: 'delivered',
  }),
  canonical(
    'a non-finite number in the row parses as json.loads does',
    'ok',
    raw('{"status":"delivered","receipt":{"repair_task":"crq-R-F1"},"score":NaN}'),
  ),
  canonical(
    'a dismissed row is reassigned',
    'canonical-finding-reassigned',
    row({ status: 'dismissed' }),
  ),
  canonical('a row without a status is reassigned', 'canonical-finding-reassigned', {
    receipt: { repair_task: JOB },
  }),
  canonical(
    'a delivered row owned by a valid prepared retry passes',
    'ok',
    row({ receipt: { repair_task: RETRY } }),
    {
      files: { [inbox(RETRY)]: retry() },
      reads: [inbox(RETRY)],
    },
  ),
  canonical(
    'a retry that is not recovery_worktree true is refused',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: RETRY } }),
    {
      files: { [inbox(RETRY)]: retry({ recovery_worktree: 1 }) },
      reads: [inbox(RETRY)],
    },
  ),
  canonical(
    'a retry whose recovery_worktree is absent is refused',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: RETRY } }),
    {
      files: { [inbox(RETRY)]: { job: RETRY, origin_job: JOB } },
      reads: [inbox(RETRY)],
    },
  ),
  canonical(
    'a retry of another origin is refused',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: RETRY } }),
    {
      files: { [inbox(RETRY)]: retry({ origin_job: 'crq-R-F9' }) },
      reads: [inbox(RETRY)],
    },
  ),
  canonical(
    'a missing retry is refused',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: RETRY } }),
    { reads: [inbox(RETRY)] },
  ),
  canonical(
    'a malformed retry is refused',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: RETRY } }),
    {
      files: { [inbox(RETRY)]: raw('not json') },
      reads: [inbox(RETRY)],
    },
  ),
  canonical(
    'an empty-list retry is falsy and refused',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: RETRY } }),
    {
      files: { [inbox(RETRY)]: [] },
      reads: [inbox(RETRY)],
    },
  ),
  canonical(
    'a non-empty-list retry is an AttributeError',
    { error: 'AttributeError', message: "'list' object has no attribute 'get'" },
    row({ receipt: { repair_task: RETRY } }),
    {
      files: { [inbox(RETRY)]: [1] },
      reads: [inbox(RETRY)],
    },
  ),
  canonical(
    'a retry id outside the job grammar is never read',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: 'bad id!' } }),
  ),
  canonical(
    'a numeric retry id is never read',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: 5 } }),
  ),
  canonical(
    'a null retry id is never read',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: null } }),
  ),
  canonical(
    'an empty retry id is falsy and never read',
    'canonical-finding-reassigned',
    row({ receipt: { repair_task: '' } }),
  ),
  canonical(
    'a foreign owner is not read when the status already refuses',
    'canonical-finding-reassigned',
    row({ status: 'dismissed', receipt: { repair_task: RETRY } }),
    {
      files: { [inbox(RETRY)]: [1] },
      reads: [inbox(RETRY)],
    },
  ),

  // ---- needs-human ownership ----------------------------------------------
  canonical('a needs-human row decided by this repair passes', 'ok', NEEDS_HUMAN_ROW, {
    events: [event()],
    reads: ['events'],
  }),
  canonical(
    'a needs-human row with a foreign actor needs the owner',
    'owner-decision-required',
    NEEDS_HUMAN_ROW,
    {
      events: [
        event({ payload: { actor: 'operator', finding_id: FID, evidence: { repair_task: JOB } } }),
      ],
      reads: ['events'],
    },
  ),
  canonical(
    'a needs-human row for another finding needs the owner',
    'owner-decision-required',
    NEEDS_HUMAN_ROW,
    {
      events: [
        event({
          payload: {
            actor: 'crq-repair',
            finding_id: 'b'.repeat(64),
            evidence: { repair_task: JOB },
          },
        }),
      ],
      reads: ['events'],
    },
  ),
  canonical(
    'a needs-human row for another task needs the owner',
    'owner-decision-required',
    NEEDS_HUMAN_ROW,
    {
      events: [
        event({
          payload: { actor: 'crq-repair', finding_id: FID, evidence: { repair_task: RETRY } },
        }),
      ],
      reads: ['events'],
    },
  ),
  canonical(
    'a needs-human row without evidence needs the owner',
    'owner-decision-required',
    NEEDS_HUMAN_ROW,
    {
      events: [event({ payload: { actor: 'crq-repair', finding_id: FID } })],
      reads: ['events'],
    },
  ),
  canonical(
    'a needs-human row with null evidence is an AttributeError',
    { error: 'AttributeError', message: "'NoneType' object has no attribute 'get'" },
    NEEDS_HUMAN_ROW,
    {
      events: [event({ payload: { actor: 'crq-repair', finding_id: FID, evidence: null } })],
      reads: ['events'],
    },
  ),
  canonical(
    'a needs-human row with no payload needs the owner',
    'owner-decision-required',
    NEEDS_HUMAN_ROW,
    {
      events: [{ id: EVENT }],
      reads: ['events'],
    },
  ),
  canonical(
    'a needs-human row with a null payload is an AttributeError',
    { error: 'AttributeError', message: "'NoneType' object has no attribute 'get'" },
    NEEDS_HUMAN_ROW,
    {
      events: [{ id: EVENT, payload: null }],
      reads: ['events'],
    },
  ),
  canonical(
    'a needs-human row whose event is not retained needs the owner',
    'owner-decision-required',
    NEEDS_HUMAN_ROW,
    {
      events: [event({ id: 'other' })],
      reads: ['events'],
    },
  ),
  canonical(
    'no retained events at all needs the owner',
    'owner-decision-required',
    NEEDS_HUMAN_ROW,
    { events: [], reads: ['events'] },
  ),
  canonical('the first event with the id decides', 'owner-decision-required', NEEDS_HUMAN_ROW, {
    events: [event({ payload: { actor: 'operator' } }), event()],
    reads: ['events'],
  }),
  canonical('a junk event after the match is never touched', 'ok', NEEDS_HUMAN_ROW, {
    events: [event(), 'junk'],
    reads: ['events'],
  }),
  canonical(
    'a junk event before the match is an AttributeError',
    { error: 'AttributeError', message: "'str' object has no attribute 'get'" },
    NEEDS_HUMAN_ROW,
    {
      events: ['junk', event()],
      reads: ['events'],
    },
  ),
  canonical(
    'an absent previous_event_id matches an event without an id (None == None)',
    'ok',
    row({ status: 'needs-human' }),
    {
      events: [
        { id: 'other' },
        { payload: { actor: 'crq-repair', finding_id: FID, evidence: { repair_task: JOB } } },
      ],
      reads: ['events'],
    },
  ),
  canonical(
    'an event id of 1 matches a previous_event_id of 1.0',
    'ok',
    row({ status: 'needs-human', previous_event_id: 1.0 }),
    {
      events: [event({ id: 1 })],
      reads: ['events'],
    },
  ),
  canonical(
    'an unavailable event ledger propagates its ValueError',
    { error: 'ValueError' },
    NEEDS_HUMAN_ROW,
    {
      events: { raises: 'ValueError' },
      reads: ['events'],
    },
  ),
  canonical('a delivered row never reads the retained events', 'ok', row(), {
    events: { raises: 'ValueError' },
  }),
  canonical(
    'a needs-human row owned by a valid retry passes',
    'ok',
    row({ status: 'needs-human', previous_event_id: EVENT, receipt: { repair_task: RETRY } }),
    {
      events: [event()],
      files: { [inbox(RETRY)]: retry() },
      reads: ['events', inbox(RETRY)],
    },
  ),
  canonical(
    'a needs-human row whose owner decision is missing is refused before the retry is read',
    'owner-decision-required',
    row({ status: 'needs-human', previous_event_id: EVENT, receipt: { repair_task: RETRY } }),
    {
      events: [],
      files: { [inbox(RETRY)]: retry() },
      reads: ['events'],
    },
  ),

  // ---- superseded by a prepared retry -------------------------------------
  {
    name: 'a stale record naming a valid retry passes',
    expect: 'ok',
    reads: ['queue', inbox(RETRY)],
    queue: queueOf(owned({ state: 'stale', error: `superseded by prepared retry ${RETRY}` })),
    files: { [inbox(RETRY)]: retry() },
  },
  {
    name: 'a stale record whose retry is missing is superseded',
    expect: 'already-superseded',
    reads: ['queue', inbox(RETRY)],
    queue: queueOf(owned({ state: 'stale', error: `superseded by prepared retry ${RETRY}` })),
  },
  {
    name: 'a stale record whose retry is of another origin is superseded',
    expect: 'already-superseded',
    reads: ['queue', inbox(RETRY)],
    queue: queueOf(owned({ state: 'stale', error: `superseded by prepared retry ${RETRY}` })),
    files: { [inbox(RETRY)]: retry({ origin_job: 'crq-R-F9' }) },
  },
  {
    name: 'a stale record whose retry is not recovery_worktree true is superseded',
    expect: 'already-superseded',
    reads: ['queue', inbox(RETRY)],
    queue: queueOf(owned({ state: 'stale', error: `superseded by prepared retry ${RETRY}` })),
    files: { [inbox(RETRY)]: retry({ recovery_worktree: 'yes' }) },
  },
  {
    name: 'a stale record without a note is superseded',
    expect: 'already-superseded',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'stale' })),
  },
  {
    name: 'a stale record with another note is superseded',
    expect: 'already-superseded',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'stale', error: 'stale source' })),
  },
  {
    name: 'a stale record with a non-string note is superseded',
    expect: 'already-superseded',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'stale', error: 5 })),
  },
  {
    name: 'a stale note naming an id outside the job grammar is never read',
    expect: 'already-superseded',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'stale', error: 'superseded by prepared retry bad id!' })),
  },
  {
    name: 'a stale note with an empty id is never read',
    expect: 'already-superseded',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'stale', error: 'superseded by prepared retry ' })),
  },
  {
    name: 'a stale note without its trailing space does not match the prefix',
    expect: 'already-superseded',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'stale', error: `superseded by prepared retry${RETRY}` })),
  },
  {
    name: 'a stale record whose retry is a non-empty list is an AttributeError',
    expect: { error: 'AttributeError', message: "'list' object has no attribute 'get'" },
    reads: ['queue', inbox(RETRY)],
    queue: queueOf(owned({ state: 'stale', error: `superseded by prepared retry ${RETRY}` })),
    files: { [inbox(RETRY)]: [1] },
  },
  {
    name: 'a published stale record is refused as published first',
    expect: 'already-published',
    reads: ['queue'],
    queue: queueOf(owned({ state: 'stale', fix_pr: 'https://example.invalid/pull/1' })),
  },
  {
    name: 'a canonical refusal comes before the stale check',
    expect: 'canonical-finding-reassigned',
    reads: ['queue', triage(FID)],
    queue: queueOf(owned({ state: 'stale', error: `superseded by prepared retry ${RETRY}` })),
    job: jobWith({ canonical_finding_id: FID }),
    files: { [triage(FID)]: row({ status: 'dismissed' }), [inbox(RETRY)]: retry() },
  },
  {
    name: 'a delivered canonical row then a valid stale retry passes, reading the triage row first',
    expect: 'ok',
    reads: ['queue', triage(FID), inbox(RETRY)],
    queue: queueOf(owned({ state: 'stale', error: `superseded by prepared retry ${RETRY}` })),
    job: jobWith({ canonical_finding_id: FID }),
    files: { [triage(FID)]: row(), [inbox(RETRY)]: retry() },
  },
];

interface Outcome {
  readonly ok?: true;
  readonly refusal?: RecoveryOwnerRefusal;
  readonly reason?: string;
  readonly error?: PyErrorKind | string;
  readonly message?: string;
  readonly reads: readonly string[];
}

interface Laid {
  readonly scenario: Scenario;
  readonly root: string;
  readonly job: unknown;
}

function writeFileBody(root: string, rel: string, body: FileBody): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  const text =
    typeof body === 'object' && body !== null && 'raw' in body
      ? (body as { raw: string }).raw
      : JSON.stringify(body);
  // `raw('\u0000')` stands for invalid UTF-8: write the byte, not the character.
  if (text === '\u0000') writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
  else writeFileSync(path, text);
}

function lay(scenario: Scenario): Laid {
  const root = mkdtempSync(join(tmpdir(), 'repair-owner-'));
  dirs.push(root);
  const job = scenario.job === undefined ? jobWith({}) : scenario.job;
  writeFileBody(root, inbox(JOB), job);
  for (const [rel, body] of Object.entries(scenario.files ?? {})) writeFileBody(root, rel, body);
  return { scenario, root, job };
}

const PY = String.raw`
import importlib.util, json, pathlib, sys
from types import SimpleNamespace
from unittest import mock
sys.path.insert(0, sys.argv[1])
import repair_tick
from crq_repair import recovery
spec = importlib.util.spec_from_file_location('repair_owner_oracle', pathlib.Path(sys.argv[1]) / 'crq_repair.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
CONFIG = {'repair': {'roles': {'judge_critical': {'driver': 'cq'}}}}
out = []
for s in json.loads(sys.argv[2]):
    root = pathlib.Path(s['root'])
    service.ROOT = root
    reads = []
    def load_queue(s=s, reads=reads):
        reads.append('queue')
        return json.loads(json.dumps(s['queue']))
    def retained(s=s, reads=reads):
        reads.append('events')
        if isinstance(s['events'], dict):
            raise ValueError('backfill repair write-back requires existing ledger configuration')
        return s['events']
    def finding_inbox(c, s=s, retained=retained):
        return SimpleNamespace(publication=SimpleNamespace(retained=retained))
    original = pathlib.Path.read_text
    def read_text(self, *a, root=root, reads=reads, original=original, **k):
        try:
            reads.append(str(self.relative_to(root)))
        except ValueError:
            pass
        return original(self, *a, **k)
    fake = SimpleNamespace(load_queue=load_queue, ran_locked=lambda fn: (fn(), True)[1])
    entry = {}
    with mock.patch.dict(sys.modules, {'crq': fake}), \
         mock.patch.object(repair_tick, 'finding_inbox', finding_inbox), \
         mock.patch.object(recovery, 'recover', lambda *a, **k: 'OWNED'), \
         mock.patch.object(pathlib.Path, 'read_text', read_text):
        try:
            if service.recover_job(CONFIG, s['job_id']) != 'OWNED':
                raise AssertionError('recover was not reached')
            entry['ok'] = True
        except Exception as e:
            entry['error'] = 'OSError' if isinstance(e, OSError) else (
                'ValueError' if isinstance(e, ValueError) else type(e).__name__)
            entry['message'] = str(e)
    # The first read is recover_job's own load of the job file, before the check.
    entry['reads'] = reads[1:]
    out.append(entry)
print(json.dumps(out))
`;

/**
 * Python 3.15 (the local `python3`) reworded two TypeErrors this closure can
 * raise; production is 3.14 (AGENTS.md), whose text the port emits. Fold the
 * newer wording back so the oracle compares on every minor.
 */
function productionWording(message: string): string {
  return message
    .replace(/is not a container or iterable$/, 'is not iterable')
    .replace(
      /^cannot use '(\w+)' as a dict key \(unhashable type: '\1'\)$/,
      "unhashable type: '$1'",
    );
}

function runPython(laid: readonly Laid[]): Outcome[] {
  const specs = laid.map(({ scenario, root }) => ({
    root,
    job_id: JOB,
    queue: scenario.queue,
    events: scenario.events ?? [],
  }));
  const stdout = execFileSync('python3', ['-I', '-c', PY, PYTHON_DIR, JSON.stringify(specs)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return (JSON.parse(stdout) as Array<Record<string, unknown>>).map((entry): Outcome => {
    const reads = entry.reads as readonly string[];
    if (entry.ok === true) return { ok: true, reads };
    const message = entry.message as string;
    const refusal = entry.error === 'ValueError' ? REFUSAL_OF.get(message) : undefined;
    if (refusal !== undefined) return { refusal, reason: message, reads };
    const kind = entry.error as string;
    return {
      error: kind,
      ...(kind === 'AttributeError' || kind === 'TypeError'
        ? { message: productionWording(message) }
        : {}),
      reads,
    };
  });
}

/** `json.loads(path.read_text())` for a fixture file: OSError, ValueError, else the parsed value. */
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function readJsonFile(path: string): unknown {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new PyError('OSError', e instanceof Error ? e.message : String(e));
  }
  try {
    return toPlainJsonRetainingNumbers(
      parseJsonValue(decoder.decode(bytes), { parseConstant: pythonNonFinite }),
    );
  } catch (e) {
    throw new PyError('ValueError', e instanceof Error ? e.message : String(e));
  }
}

async function runTs({ scenario, root, job }: Laid): Promise<Outcome> {
  const reads: string[] = [];
  const fileReads = fileRepairHarvestReads({
    stateRoot: join(root, 'state'),
    worktreeRoot: join(root, 'wt'),
  });
  const probes: RepairRecoveryOwnerReads = {
    loadQueue: () => {
      reads.push('queue');
      return Promise.resolve(JSON.parse(JSON.stringify(scenario.queue)) as unknown);
    },
    readTriageRow: (findingId) => {
      reads.push(triage(findingId));
      return Promise.resolve().then(() => readJsonFile(join(root, triage(findingId))));
    },
    retainedEvents: () => {
      reads.push('events');
      const events = scenario.events ?? [];
      if (!Array.isArray(events)) {
        return Promise.reject(
          new PyError(
            'ValueError',
            'backfill repair write-back requires existing ledger configuration',
          ),
        );
      }
      return Promise.resolve(events as readonly unknown[]);
    },
    readJob: (jobId) => {
      if (checkRepairJobId(jobId)) reads.push(inbox(jobId));
      return fileReads.readJob(jobId);
    },
  };
  try {
    const decision = await decideRecoveryOwner({ job, jobId: JOB }, probes);
    if (decision.ok) return { ok: true, reads };
    return { refusal: decision.refusal, reason: decision.reason, reads };
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    return {
      error: e.kind,
      ...(e.kind === 'AttributeError' || e.kind === 'TypeError' ? { message: e.message } : {}),
      reads,
    };
  }
}

/** What a scenario's `expect` normalises to, with reads attached. */
function expected(scenario: Scenario): Outcome {
  const { expect: want, reads } = scenario;
  if (want === 'ok') return { ok: true, reads };
  if (typeof want === 'string') return { refusal: want, reason: REASON[want], reads };
  return {
    error: want.error,
    ...(want.message === undefined ? {} : { message: want.message }),
    reads,
  };
}

describe('recovery ownership preflight (check_owner) against Python recover_job', () => {
  const laid = SCENARIOS.map(lay);
  const python = runPython(laid);

  it('has uniquely named scenarios', () => {
    const names = SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(SCENARIOS.map((scenario, index) => [scenario.name, index] as const))(
    '%s',
    async (_name, index) => {
      const item = laid[index];
      const oracle = python[index];
      if (item === undefined || oracle === undefined) throw new Error('missing scenario');
      const want = expected(item.scenario);
      expect(oracle).toEqual(want);
      expect(await runTs(item)).toEqual(want);
    },
  );

  it('covers every refusal and every error class the closure can raise', () => {
    const refusals = new Set<string>();
    const errors = new Set<string>();
    for (const scenario of SCENARIOS) {
      if (typeof scenario.expect === 'string') refusals.add(scenario.expect);
      else errors.add(scenario.expect.error);
    }
    refusals.delete('ok');
    expect([...refusals].sort()).toEqual(Object.keys(REASON).sort());
    expect([...errors].sort()).toEqual(['AttributeError', 'OSError', 'TypeError', 'ValueError']);
  });
});
