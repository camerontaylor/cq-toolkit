/**
 * Seeded differential for the repair-side tick passes.
 *
 * Every case in `crq-repair-tick-parity/cases.json` was produced by the real
 * `repair_tick.backfill`, `archive_legacy` and `harvest` (driven through the
 * crq.py harvest loop) over seeded on-disk state. Each case is rebuilt here,
 * run through `composeFullTick(...).phases` (`repairBackfill`, `archiveLegacy`,
 * `harvestItems`) and compared per phase on the exception class that escaped,
 * the queue, the harvest log, the effect-call log, the ledger events spooled
 * and the file tree left behind.
 *
 * Unbound effects use the SAME deterministic stub on both sides: makeWorktree,
 * removeWorktree, verify, mechanical, requireCanonicalDelivery, saveQueue,
 * publish and the replay budget's clock. markFindingOutcome,
 * recordUnpublishedFixedSibling and cleanupHarvested run for real.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { GitPool } from '../../../src/adapters/crq/gitExec.js';
import {
  fileArtifactStore,
  fileFindingPublication,
} from '../../../src/adapters/crq/findingStore.js';
import { fileRepairCleanup } from '../../../src/adapters/crq/repairCleanupEffects.js';
import { fileRepairHarvestReads } from '../../../src/adapters/crq/repairHarvestReads.js';
import { fileRepairOutcomeEffects } from '../../../src/adapters/crq/repairOutcomeEffects.js';
import {
  composeFullTick,
  type TickCompositionInput,
} from '../../../src/adapters/crq/tickComposition.js';
import { ledgerCanonicalBytes } from '../../../src/policy/crq/ledger.js';
import {
  JsonObject,
  parseJsonValue,
  pythonNonFinite,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';
import {
  repairHarvest,
  ReplayBudget,
  type RepairHarvestEffects,
} from '../../../src/queue-runner/repairHarvest.js';
import type { HarvestReviewEffects } from '../../../src/queue-runner/harvestReview.js';

const FIXTURE = new URL(
  '../../../apps/crq-python/fixtures/crq-repair-tick-parity/cases.json',
  import.meta.url,
);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

interface Spec {
  name: string;
  files: Record<string, string | { __bytes_b64: string }>;
  runs?: Record<
    string,
    { meta?: string | { __bytes_b64: string }; review?: string | { __bytes_b64: string } }
  >;
  ledger?: string[];
  git: Record<string, string>;
  findings?: Record<
    string,
    { finding: Record<string, unknown>; source: Record<string, unknown> }[]
  >;
  max_rounds?: number;
  merged_current?: boolean;
  budget?: number;
  wall?: number;
  clone?: boolean;
  canonical?: Record<string, string>;
  verify?: Record<string, string>;
  mechanical?: Record<string, string>;
  publish?: string;
  finding_ledger?: boolean;
  row_task?: string | null;
  no_rollout?: boolean;
}
interface PhaseOutcome {
  error: string | null;
  queue: unknown;
}
interface Expected {
  phases: Record<'backfill' | 'archive' | 'harvest', PhaseOutcome>;
  log: string[];
  calls: string[];
  events: unknown[];
  tree: Record<string, string>;
}

const text = readFileSync(FIXTURE, 'utf8');
const exact = parseJsonValue(text, { parseConstant: pythonNonFinite }) as JsonObject;
const plain = toPlainJson(exact, { bigints: true }) as {
  at: string;
  wall: number;
  finding_id: string;
  rollout_text: string;
  triage_row: Record<string, unknown>;
  seed_events: unknown[];
  cases: (Spec & { expected: Expected })[];
};
/** `exact` keeps every number as Python wrote it (`1` vs `1.0`); `plain` is for the specs. */
const exactCases = exact.get('cases') as JsonObject[];
const SEEDS = exact.get('seed_events') as JsonValue[];

const bytesOf = (value: string | { __bytes_b64: string }, root: string): Buffer =>
  typeof value === 'string'
    ? Buffer.from(value.replaceAll('{ROOT}', root), 'utf8')
    : Buffer.from(value.__bytes_b64, 'base64');

async function layout(spec: Spec, root: string): Promise<void> {
  for (const [rel, value] of Object.entries(spec.files)) {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), bytesOf(value, root));
  }
  for (const [run, files] of Object.entries(spec.runs ?? {})) {
    const directory = join(root, 'runs', run);
    await mkdir(directory, { recursive: true });
    if (files.meta !== undefined)
      await writeFile(join(directory, 'meta.json'), bytesOf(files.meta, root));
    if (files.review !== undefined)
      await writeFile(join(directory, 'review.ndjson'), bytesOf(files.review, root));
  }
  await mkdir(join(root, 'ledger'), { recursive: true });
  for (const name of spec.ledger ?? []) await writeFile(join(root, 'ledger', name), name);
  await mkdir(join(root, 'worktrees'), { recursive: true });
}

/** The finding ledger: rollout, triage row and the seeded event chain. */
async function ledgerLayout(spec: Spec, root: string): Promise<void> {
  if (!spec.finding_ledger) return;
  for (const directory of [
    'backfill/findings/triage',
    'backfill/publication/pending',
    'artifacts',
    'repair/inbox',
  ])
    await mkdir(join(root, directory), { recursive: true });
  const publication = fileFindingPublication({
    root: join(root, 'backfill', 'publication'),
    artifacts: fileArtifactStore(join(root, 'artifacts')),
  });
  for (const seed of SEEDS) await publication.spool(seed);
  const row = { ...plain.triage_row } as Record<string, unknown>;
  row['receipt'] = spec.row_task == null ? {} : { repair_task: spec.row_task };
  await writeFile(
    join(root, 'backfill/findings/triage', `${plain.finding_id}.json`),
    `${JSON.stringify(row, null, 2)}\n`,
  );
  if (!spec.no_rollout)
    await writeFile(
      join(root, 'backfill-rollout.json'),
      plain.rollout_text.replaceAll('{ROOT}', root),
    );
}

/** `tree()` of the emitter: every file under the root but the clone, the stub and `.git`. */
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(directory: string, parts: string[]): Promise<void> {
    for (const entry of (await readdir(directory)).sort()) {
      const here = [...parts, entry];
      if (here[0] === 'clone' || here[0] === 'stub' || here.includes('.git')) continue;
      const path = join(directory, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink()) out[here.join('/')] = `-> ${await readlink(path)}`;
      else if (info.isDirectory()) await walk(path, here);
      else if (info.isFile())
        out[here.join('/')] = (await readFile(path)).toString('utf8').replaceAll(root, '<ROOT>');
    }
  }
  await walk(root, []);
  return out;
}

function failure(mode: string, message: string): PyError | null {
  if (mode === 'ok') return null;
  if (mode === 'ValueError' || mode === 'DetectorUnavailable' || mode === 'RuntimeError')
    return new PyError(mode, message);
  throw new Error(`unknown failure mode ${mode}`);
}

/** The Python class name an escaped error stands for. */
function errorClass(error: unknown): string {
  if (error instanceof PyError) return error.kind;
  const named = (error as { pythonError?: unknown } | null)?.pythonError;
  if (typeof named === 'string') return named;
  if (error instanceof Error) return error.constructor.name;
  return typeof error;
}

const scrubbed = (value: unknown, root: string): unknown =>
  JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v)).replaceAll(
      root,
      '<ROOT>',
    ),
  );

async function run(spec: Spec, queue: JsonObject) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-repair-tick-parity-')));
  temporary.push(root);
  await layout(spec, root);
  await ledgerLayout(spec, root);
  const calls: string[] = [];
  const gitAnswers = spec.git;
  const worktreeRoot = join(root, 'worktrees');
  if (spec.clone) {
    await mkdir(join(root, 'clone'));
    execFileSync('git', ['init', '--quiet', join(root, 'clone')], { env: GIT_ENV });
  }
  const iso = (): string => plain.at;
  const reads = fileRepairHarvestReads({ stateRoot: root, worktreeRoot });
  const outcomes = fileRepairOutcomeEffects({ stateRoot: root, iso, maxFindingRetries: 2 });
  const fx: RepairHarvestEffects = {
    ...reads,
    ...outcomes,
    cleanupHarvested: spec.clone
      ? fileRepairCleanup({ stateRoot: root, worktreeRoot, clone: join(root, 'clone') })
      : undefined,
    requireCanonicalDelivery: (job) => {
      const id = job['job'];
      calls.push(`canonical ${String(id)}`);
      const mode = spec.canonical?.[id as string] ?? 'ok';
      if (mode === 'mismatch')
        return Promise.reject(
          new PyError('ValueError', `canonical delivery mismatch for ${String(id)}`),
        );
      if (mode === 'unavailable')
        return Promise.reject(
          new PyError('ValueError', `canonical delivery state unavailable: ${String(id)}`),
        );
      return Promise.resolve();
    },
    makeWorktree: (name, commit) => {
      calls.push(`make_worktree ${name} ${commit}`);
      return Promise.resolve({ path: join(root, 'wt', name), branch: `br-${name}` });
    },
    removeWorktree: (path, branch) => {
      calls.push(`remove_worktree ${path.replaceAll(root, '<ROOT>')} ${branch}`);
      return Promise.resolve();
    },
    verify: (_worktree, predecessor, commits, jobId) => {
      calls.push(`verify ${jobId} ${String(predecessor)} ${commits.join(',')}`);
      const error = failure(spec.verify?.[jobId] ?? 'ok', `verify rejected ${jobId}`);
      return error === null ? Promise.resolve() : Promise.reject(error);
    },
    mechanical: (_worktree, _predecessor, _commits, jobId) => {
      calls.push(`mechanical ${jobId}`);
      const mode = spec.mechanical?.[jobId] ?? 'ok';
      if (mode === 'ValueError')
        return Promise.reject(new PyError('ValueError', `mechanical rejected ${jobId}`));
      if (mode === 'DetectorUnavailable')
        return Promise.reject(new PyError('DetectorUnavailable', `detector down ${jobId}`));
      return Promise.resolve();
    },
    saveQueue: () => {
      calls.push('save_queue');
      return Promise.resolve();
    },
    publish: (_q, _item, runId, _record, fixed) => {
      calls.push(`publish ${runId} ${fixed.length}`);
      return spec.publish === 'raise'
        ? Promise.reject(new PyError('ValueError', `publish rejected ${runId}`))
        : Promise.resolve();
    },
    replayBudget: new ReplayBudget({
      count: spec.budget ?? 25,
      clock: () => 0,
      wall: () => spec.wall ?? plain.wall,
    }),
  };
  const input = {
    stateRoot: root,
    config: new JsonObject([]),
    clone: join(root, 'clone'),
    watchdogHome: root,
    root: '/r',
    runnerRoot: root,
    repo: 'o/r',
    now: () => Date.parse(plain.at),
    delivery: {} as never,
    admit: {} as never,
    repairBackfill: {
      ledgerRoot: join(root, 'ledger'),
      defaultRef: 'origin/main',
      mergedCurrentEnabled: spec.merged_current === true,
      maxRoundsPerPin: spec.max_rounds ?? 2,
      git: (...args: string[]) => {
        const key = args.join(' ');
        if (!Object.hasOwn(gitAnswers, key))
          return Promise.reject(new PyError('KeyError', `'${key}'`));
        return Promise.resolve(gitAnswers[key] as string);
      },
      findings: (runId: string) =>
        Promise.resolve(
          (spec.findings?.[runId] ?? []).map((row) => ({
            finding: row.finding,
            source: row.source,
          })),
        ),
    },
    harvest: {
      local: {
        kind: 'local-review',
        harvest: (q: JsonObject) => Promise.resolve({ queue: q, message: null }),
        republish: (q: JsonObject) => Promise.resolve(q),
        reconcileCompleted: (q: JsonObject) => Promise.resolve(q),
      },
      reviewReceiptKind: 'review-receipt',
      worktree: { pool: new GitPool(), worktreePrefix: 'wt-' },
      review: {
        kinds: {},
        config: { maxItemFailures: 3, errorBackoffMin: 5, rateLimitDefaultBackoffMin: 30 },
        iso,
      } as unknown as HarvestReviewEffects,
      repairHarvest: (
        q: Parameters<typeof repairHarvest>[0],
        item: Parameters<typeof repairHarvest>[1],
      ) => repairHarvest(q, item, fx),
    },
  } as unknown as TickCompositionInput;
  const { phases } = composeFullTick(input);

  const result: Record<string, PhaseOutcome> = {};
  let current = queue;
  const log: string[] = [];
  async function phase(
    name: string,
    work: (q: JsonObject) => Promise<{ queue: JsonObject; log?: readonly string[] } | JsonObject>,
  ) {
    const before = current;
    try {
      const out = await work(current);
      if (out instanceof JsonObject) current = out;
      else {
        current = out.queue;
        if (name === 'harvest') log.push(...(out.log ?? []));
      }
      result[name] = { error: null, queue: current };
    } catch (error) {
      current = before;
      result[name] = { error: errorClass(error), queue: before };
    }
  }
  await phase('backfill', (q) => phases.repairBackfill(q));
  await phase('archive', (q) => phases.archiveLegacy(q));
  await phase('harvest', (q) => phases.harvestItems(q, false));
  if (result['harvest']?.error != null) log.length = 0;

  let events: JsonValue[] = [];
  if (spec.finding_ledger) {
    const publication = fileFindingPublication({
      root: join(root, 'backfill', 'publication'),
      artifacts: fileArtifactStore(join(root, 'artifacts')),
    });
    events = (await publication.retained()).filter((value) => {
      const key = (value as JsonObject).get('source_key') as string;
      return key.startsWith('repair-outcome:') && !key.startsWith('repair-outcome:seed-');
    });
  }
  return { root, result, log, calls, events, tree: await tree(root) };
}

/**
 * DOCUMENTED DEVIATIONS, each a deliberate TS behaviour the replay pins rather than hides.
 *
 * 1. Parser wording. Python's `json`/`utf-8` messages (`Expecting property name ... (char 1)`,
 *    `'utf-8' codec can't decode byte ...`, the BOM text) and the missing-triage-row path
 *    (`[Errno 2] No such file or directory: '<triage>.json'`) reach the queue through
 *    `error`/`reason`/`last_error`. TS carries its own parser's wording; the exception class is
 *    the same and is compared exactly. Both sides are normalised to a token before comparing.
 * 2. `meta names another run` (`repairBackfill`): Python enqueues the verdict under the id in
 *    `meta.json`; TS records the cycle as `legacy_repair_missing` instead, so the ledger cannot
 *    archive with the cycle unresolved. Pinned by `META_NAMES_ANOTHER_RUN`.
 * 3. `NaN` in a repair result (`harvest-result-nan-reason`): `json.dump` writes it; the TS queue
 *    writer refuses a non-finite number (`non-finite JSON number`).
 * 4. `queue.items` absent (`error-items-key-missing`): the TS harvest phase reads items through
 *    the schedule policy (`TickScheduleError`); Python raises `KeyError`.
 * 5. The malformed-inbox family. Python lets the error escape the loop into `last_error` and the run
 *    stays queued; TS terminalises the run as `invalid repair inbox: ...` (PR #2241 F9/F10). One seed
 *    each: bad JSON (`harvest-inbox-malformed`), list/scalar/null (`harvest-inbox-list|scalar|null`),
 *    non-UTF-8 and BOM (`harvest-inbox-non-utf8|bom`). The identity guard is the same deviation in
 *    the other direction: a swapped inbox `job` (`harvest-inbox-job-swapped`) or an inbox `item`
 *    that differs from the queue id (`harvest-inbox-item-differs`) is harvested normally by
 *    Python and terminalised by TS. For these seeds the harvest queue document is not compared
 *    (only the error class and the `invalid repair inbox: ` text); the log, calls, events and
 *    tree ARE compared against Python's, and the cases are listed in `PINNED_PHASE`.
 *    NOT COVERED: the TS-only replay arm in `repairHarvest.ts` (a FAILED verdict whose reason
 *    starts `invalid repair inbox: `). No Python verdict can carry that reason, so no seed can
 *    reach it; `repairHarvestReplay.test.ts` and `repairHarvest.test.ts` pin it.
 * 6. Array items in `queue.items`: `liveItems` (`tickSchedule.ts`, held) silently drops an array
 *    item where Python raises `AttributeError` on `.get`. A scalar item reaches the harvest guard
 *    and matches Python (`error-item-not-a-dict`); an array item is not seeded.
 * 7. Replay budget and `Number(bigint)`: `pyNumberOrNull` rounds a prior `replay_attempted` above
 *    2^53 where Python's int arithmetic is exact. The field is `time.time()` in practice; unseeded.
 */
const WORDING: readonly [RegExp, string][] = [
  [
    /(?:Expecting|Extra data|Unterminated|Unexpected UTF-8 BOM)[^"]*?line \d+ column \d+ \(char \d+\)/g,
    '<PARSE>',
  ],
  [/expected [A-Za-z ]+ at byte offset \d+/g, '<PARSE>'],
  [/'utf-8' codec can't decode byte 0x[0-9a-f]+ in position \d+: [a-z ]+/g, '<DECODE>'],
  [/The encoded data was not valid for encoding utf-8/g, '<DECODE>'],
  [
    /\[Errno 2\] No such file or directory: '<ROOT>[^']*triage\/[0-9a-f]+\.json'/g,
    '<NO-TRIAGE-ROW>',
  ],
  [/triage row [0-9a-f]+ does not exist/g, '<NO-TRIAGE-ROW>'],
];
const normalised = (text: string): string =>
  WORDING.reduce((t, [re, to]) => t.replace(re, to), text);

const META_NAMES_ANOTHER_RUN = 'meta names another run';
const PINNED_PHASE: Record<
  string,
  { phase: 'harvest'; error: string; queueIncludes?: string; compareRest?: boolean }
> = {
  'harvest-result-nan-reason': { phase: 'harvest', error: 'Error' },
  'error-items-key-missing': { phase: 'harvest', error: 'TickScheduleError' },
  ...Object.fromEntries(
    [
      'harvest-inbox-malformed',
      'harvest-inbox-list',
      'harvest-inbox-scalar',
      'harvest-inbox-null',
      'harvest-inbox-non-utf8',
      'harvest-inbox-bom',
      'harvest-inbox-job-swapped',
      'harvest-inbox-item-differs',
    ].map((name) => [
      name,
      {
        phase: 'harvest',
        error: 'null',
        queueIncludes: 'invalid repair inbox: ',
        compareRest: true,
      },
    ]),
  ),
};

const canonicalText = (value: JsonValue, root: string): string =>
  Buffer.from(ledgerCanonicalBytes(value)).toString('utf8').replaceAll(root, '<ROOT>');
/** A queue as Python's `json.dumps` writes it: `1` vs `1.0`, NaN and key order all count. */
const queueText = (value: unknown, root: string): string =>
  pythonJsonText(value, { asciiOnly: true, sortKeys: false, keyOrder: 'insertion' }).replaceAll(
    root,
    '<ROOT>',
  );

describe('repair tick passes against the Python oracle', () => {
  test('the fixture is not vacuous', () => {
    expect(plain.cases.length).toBeGreaterThan(200);
    const errors = (phase: 'backfill' | 'archive' | 'harvest') =>
      new Set(plain.cases.map((c) => c.expected.phases[phase].error));
    for (const phase of ['backfill', 'archive', 'harvest'] as const) {
      expect(errors(phase).has(null)).toBe(true);
      expect(errors(phase).size).toBeGreaterThan(1);
    }
    expect(plain.cases.some((c) => c.expected.events.length > 0)).toBe(true);
    expect(plain.cases.some((c) => c.expected.log.length > 0)).toBe(true);
    expect(
      plain.cases.some((c) => c.expected.calls.some((call) => call.startsWith('publish'))),
    ).toBe(true);
  });

  test.each(plain.cases.map((c, index) => [c.name, index] as const))('%s', async (_name, index) => {
    const spec = plain.cases[index] as Spec & { expected: Expected };
    const expected = spec.expected;
    const queue = (exactCases[index] as JsonObject).get('queue') as JsonObject;
    const exactExpected = (exactCases[index] as JsonObject).get('expected') as JsonObject;
    const actual = await run(spec, queue);
    const backfillText = queueText((actual.result['backfill'] as PhaseOutcome).queue, actual.root);
    if (backfillText.includes(META_NAMES_ANOTHER_RUN)) {
      // Deviation 2: Python files the verdict under the run named in meta.json.
      expect((actual.result['backfill'] as PhaseOutcome).error).toBeNull();
      expect(JSON.stringify(expected.phases.backfill.queue)).not.toContain(META_NAMES_ANOTHER_RUN);
      expect(backfillText).toMatch(/"legacy_repair_missing":\[\{[^\]]*meta names another run/);
      return;
    }
    for (const name of ['backfill', 'archive', 'harvest'] as const) {
      const got = actual.result[name] as PhaseOutcome;
      const pinned = PINNED_PHASE[spec.name];
      if (pinned?.phase === name) {
        expect(String(got.error)).toBe(pinned.error);
        if (pinned.queueIncludes)
          expect(queueText(got.queue, actual.root)).toContain(pinned.queueIncludes);
        continue;
      }
      expect({ phase: name, error: got.error }).toEqual({
        phase: name,
        error: expected.phases[name].error,
      });
      const wantedQueue = ((exactExpected.get('phases') as JsonObject).get(name) as JsonObject).get(
        'queue',
      ) as JsonValue;
      expect(normalised(queueText(got.queue, actual.root))).toBe(
        normalised(queueText(wantedQueue, actual.root)),
      );
    }
    // A pinned phase ends differently, so its log and effect calls differ with it.
    const pin = PINNED_PHASE[spec.name];
    if (pin?.compareRest) {
      // The terminal path. Python's own log and calls differ (an escaped error into last_error, or a
      // normal harvest for the identity seeds), so TS's are pinned exactly; events and tree still
      // match Python's, and the queue's terminal fields are asserted.
      expect(actual.log).toEqual([]);
      expect(actual.calls).toEqual(['save_queue']);
      const exactQueue = (actual.result['harvest'] as PhaseOutcome).queue as JsonObject;
      const item = (exactQueue.get('items') as JsonValue[])[0] as JsonObject;
      const run1 = (item.get('repair_runs') as JsonObject).get('run-1') as JsonObject;
      expect(item.get('state')).toBe('repair_failed');
      expect(item.get('last_error')).toBe('repair_failed; needs human');
      expect(run1.get('state')).toBe('failed');
      expect(run1.get('siblings_recorded')).toEqual(['crq-run-1-F1']);
      const wantedEvents = exactExpected.get('events') as JsonValue[];
      expect(actual.events.map((e) => canonicalText(e, actual.root))).toEqual(
        wantedEvents.map((e) => canonicalText(e, actual.root)),
      );
      expect(scrubbed(actual.tree, actual.root)).toEqual(expected.tree);
      return;
    }
    if (pin) return;
    expect(actual.log).toEqual(expected.log);
    expect(actual.calls).toEqual(expected.calls);
    const wanted = exactExpected.get('events') as JsonValue[];
    expect(actual.events.map((e) => canonicalText(e, actual.root))).toEqual(
      wanted.map((e) => canonicalText(e, actual.root)),
    );
    expect(scrubbed(actual.tree, actual.root)).toEqual(expected.tree);
  });
});
