/**
 * The `dispatch()` wrapper of `crq_repair` (apps/crq-python/crq_repair.py:329-461):
 * `dispatch` (the provider-fallback loop), `_dispatch` (preparation, the
 * secret scans, the last-boundary deadline and blackout checks, the driver
 * switch), `review_diff_sections`, and the `correlation` identity they run
 * under, over injected effects.
 *
 * INJECTED EFFECTS ONLY and inactive: nothing imports this outside tests; it is
 * not routed, not in `LIVE_UNIT_COMMANDS` and `repairUnit.ts` is untouched. The
 * wall clock (`monotonic`, `utc`, `now`), git, the cooldown state, the provider
 * environment, the retention call, the scanner, the snapshot reads and the four
 * driver entry points are all supplied by the caller ({@link DispatchEffects});
 * the module owns the order of the gates, the budget arithmetic and the typed
 * stops. The caller binds the pause reads to `repairPauseSource.ts`
 * (`providerCooldowns`, `blocked`, `providerReady`) and `retainPreservingNested`
 * to `repairWorktreeCapture.ts`.
 *
 * Mirrored from Python, including its quirks:
 *
 * - the wall-clock deadline is `monotonic() + wall_clock_min * 60`, with the
 *   clock read BEFORE the config is subscripted (a malformed budget still reads
 *   the clock), and every launch is charged only the time that remains
 *   (`stop: budget` below 1 ms, `wall_clock_min` rewritten to `remaining / 60`);
 * - the fallback loop applies to any driver (`fallback_roles` itself only
 *   widens a `cq` role); a provider seen once, or whose environment is not
 *   ready, is skipped; a persisted cooldown is a wait, not a launch;
 * - before every paid fallback launch (`attempted`) the blackout is rechecked
 *   against the REMAINING budget and answers the typed `stop: blackout`, never a
 *   rate-limit pause; between launches the tree is retained, then
 *   `reset --hard <baseline>` and `clean -ffdx` (ignored files and nested
 *   repositories are removed; the retention call preserved the nested ones);
 * - `triage_context` jobs go straight to the CQ judge, before the deadline,
 *   the scans or the blackout check;
 * - the review diff is split per `diff --git` section by Python `splitlines`
 *   and each section is scanned under its own path (`review-diff-scan-<i>.json`);
 * - `rate-limit` stops record the provider's cooldown and the loop moves on;
 *   the final stop is the earliest recorded end as `retry_after_ms`, at least
 *   1000.
 *
 * Where Python lets an uncaught exception escape the port throws a
 * {@link PyError} of the same class (the oracle pins class, and the message
 * where this code authors it).
 *
 * Caller contract: `str()` of `job['run']`, `job['job']` and `review_diff` is pinned by
 * vectors for every JSON type, but a float only keeps its point (`7.0`) if the job arrives
 * with numbers retained (`parseJsonValue` + `toPlainJsonRetainingNumbers`). A job from plain
 * `JSON.parse` has already turned `7.0` into `7`, and nothing here can detect that.
 */
import { pyTruthy } from '../policy/crq/queueDoc.js';
import { JsonNumber, pythonNumberText } from '../policy/crq/jsonValue.js';
import { UtcParseError, parseUtcDetailed, utcHasOffset } from '../policy/crq/utc.js';
import { splitlines, pyStrip } from '../ops/crq/deploy/gitGuards.js';
import { pyRepr } from '../ops/crq/deploy/postSwitch.js';
import { PyError } from './pyErrors.js';
import { get as pyGet, pyTypeName, subscript as pySubscript } from './repairProgressSelection.js';

type Dict = Record<string, unknown>;

const DEADLINE_STOP = { stop: 'budget', summary: 'repair dispatch wall-clock deadline reached' };
const MIN_REMAINING_SECONDS = 0.001;
const DEFAULT_DIFF_PATH = 'review-diff.txt';

/** The four driver entry points `_dispatch` reaches (`crq_repair.drivers`). */
export interface DispatchDrivers {
  /** `cq.judge(config, role, job, wt, directory)`. */
  cqJudge(config: Dict, role: unknown, job: Dict, wt: string, directory: string): Promise<unknown>;
  /** `cq.invoke(config, role, job, wt, directory)`. */
  cqInvoke(config: Dict, role: unknown, job: Dict, wt: string, directory: string): Promise<unknown>;
  /** `codex.invoke(config, role, job, wt, directory, judge=judge)`. */
  codexInvoke(
    config: Dict,
    role: unknown,
    job: Dict,
    wt: string,
    directory: string,
    judge: boolean,
  ): Promise<unknown>;
  /** `paseo.invoke(config, role, job, wt, directory)`; `_dispatch` only calls it for a judge. */
  paseoInvoke(
    config: Dict,
    role: unknown,
    job: Dict,
    wt: string,
    directory: string,
  ): Promise<unknown>;
}

export interface DispatchEffects {
  /** `time.monotonic()` in seconds. */
  monotonic(): number;
  /** `utc()`: the `%Y-%m-%dT%H:%M:%SZ` stamp of now. */
  utc(): string;
  /** `datetime.now(timezone.utc)` as epoch microseconds. */
  nowMicros(): bigint;
  /** `git(wt, *args)`: stdout. */
  git(wt: string, ...args: string[]): Promise<string>;
  /** `provider_cooldowns()`; throws on corrupt state, which escapes. */
  providerCooldowns(): Promise<ReadonlyMap<string, string>>;
  /** `provider_ready(role)`. */
  providerReady(role: Dict): unknown;
  /** `remember_provider_limit(provider, report)`: the persisted cooldown end. */
  rememberProviderLimit(provider: unknown, report: Dict): Promise<string>;
  /** `blocked(repair)` at the real clock. */
  blocked(repair: unknown): unknown;
  /** `retain_preserving_nested(wt, base, directory)`. */
  retainPreservingNested(wt: string, base: string | null, directory: string): Promise<void>;
  /**
   * `with correlation(job, judge)`: run `fn` with `CQ_PARENT_WORK_ID` unset and `values`
   * exported, restoring the previous environment afterwards.
   */
  withCorrelation<T>(values: Readonly<Record<string, string>>, fn: () => Promise<T>): Promise<T>;
  /** `directory.mkdir(parents=True, exist_ok=True)`. */
  mkdir(directory: string): Promise<void>;
  /** `require_canonical_delivery(ROOT, job)`. */
  requireCanonicalDelivery(job: Dict): Promise<void>;
  /** `source_snapshot(config, job)`. */
  sourceSnapshot(config: Dict, job: Dict): Promise<unknown>;
  /** `triage_context_safe(c, context, output)`; only its truthiness counts. */
  triageContextSafe(context: Dict, output: string): Promise<unknown>;
  /** `atomic(path, value)`. */
  atomicWrite(path: string, value: unknown): Promise<void>;
  readonly drivers: DispatchDrivers;
}

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `value.get(key, default)`: the default only when the key is absent. */
function getDefault(value: unknown, key: string, fallback: unknown): unknown {
  if (!isDict(value)) {
    throw new PyError('AttributeError', `'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** `copy.deepcopy` of decoded JSON: a retained `JsonNumber` is immutable, so it is shared. */
function copyKeepingNumbers(value: unknown): unknown {
  if (value instanceof JsonNumber) return value;
  if (Array.isArray(value)) return value.map(copyKeepingNumbers);
  if (isDict(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyKeepingNumbers(v)]));
  }
  return value;
}

/**
 * Python `str(value)` over decoded JSON. A float must arrive as a retaining `JsonNumber`
 * (`7.0` stays `7.0`); a bare JavaScript number cannot tell `7` from `7.0`, so it reads as an int.
 */
function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof JsonNumber) {
    return value.kind === 'float' ? pythonNumberText(value.float as number) : value.raw;
  }
  return pyRepr(value);
}

/** `directory / name` for a `Path` and a plain component (`''` and `'.'` add nothing). */
function joinPath(directory: string, name: unknown): string {
  if (typeof name !== 'string') {
    throw new PyError(
      'TypeError',
      `unsupported operand type(s) for /: 'PosixPath' and '${pyTypeName(name)}'`,
    );
  }
  if (name === '' || name === '.') return directory;
  return `${directory.replace(/\/+$/, '')}/${name}`;
}

/** `float * 60` for a decoded JSON number or bool, else Python's `TypeError`. */
function minutesToSeconds(minutes: unknown): number {
  if (typeof minutes === 'number') return minutes * 60;
  if (typeof minutes === 'boolean') return Number(minutes) * 60;
  throw new PyError(
    'TypeError',
    `unsupported operand type(s) for +: 'float' and '${pyTypeName(minutes)}'`,
  );
}

/** `copy.deepcopy(config)` with `repair.budget.wall_clock_min` replaced. */
function withBudget(config: Dict, minutes: number): Dict {
  const copy = structuredClone(config);
  ((copy.repair as Dict).budget as Dict).wall_clock_min = minutes;
  return copy;
}

/**
 * `review_diff_sections(diff)`: `(path, text)` per `diff --git` section. Text before the
 * first header keeps the generic path; a header without a ` b/` separator is scanned under
 * the whole header line; an empty diff is one empty section.
 */
export function reviewDiffSections(diff: unknown): Array<[string, string]> {
  const sections: Array<[string, string]> = [];
  let path = DEFAULT_DIFF_PATH;
  let lines: string[] = [];
  for (const line of splitlines(pyStr(diff))) {
    if (line.startsWith('diff --git ')) {
      if (lines.length > 0) sections.push([path, lines.join('\n')]);
      const at = line.lastIndexOf(' b/');
      // `rpartition` without the separator leaves the whole line as the tail.
      path = pyStrip(at === -1 ? line : line.slice(at + 3)) || DEFAULT_DIFF_PATH;
      lines = [];
    }
    lines.push(line);
  }
  if (lines.length > 0 || sections.length === 0) sections.push([path, lines.join('\n')]);
  return sections;
}

/** `role_provider(role)`: the model's provider prefix (`codex` is OpenAI), else the driver's. */
function roleProvider(role: unknown): string | number | boolean | null {
  const model = pySubscript(role, 'model');
  if (typeof model !== 'string') {
    throw new PyError(
      'AttributeError',
      `'${pyTypeName(model)}' object has no attribute 'partition'`,
    );
  }
  const alias = (name: string): string => (name === 'codex' ? 'openai' : name);
  const slash = model.indexOf('/');
  if (slash !== -1) return alias(model.slice(0, slash));
  const driver = pySubscript(role, 'driver');
  if (typeof driver === 'string') return alias(driver);
  if (typeof driver === 'object' && driver !== null) {
    throw new PyError('TypeError', `unhashable type: '${pyTypeName(driver)}'`);
  }
  return driver as number | boolean | null;
}

/** `for model in fallback_models`: a list, a string's characters or a dict's keys. */
function iterateModels(models: unknown): unknown[] {
  if (Array.isArray(models)) return models;
  if (typeof models === 'string') return [...models];
  if (isDict(models)) return Object.keys(models);
  throw new PyError('TypeError', `'${pyTypeName(models)}' object is not iterable`);
}

/** `fallback_roles(config, role)`: the role, then a `cq` copy per distinct fallback model. */
function fallbackRoles(config: Dict, role: unknown): Dict[] {
  const roles: Dict[] = [role as Dict];
  for (const model of iterateModels(
    pySubscript(pySubscript(config, 'repair'), 'fallback_models'),
  )) {
    if (pySubscript(role, 'driver') === 'cq' && model !== pySubscript(role, 'model')) {
      roles.push({ ...(role as Dict), driver: 'cq', model });
    }
  }
  return roles;
}

/** `correlation(job, judge)`: the CQ_* identity pinned to the selected job. */
function correlationValues(job: unknown, judge: boolean): Record<string, string> {
  return {
    CQ_WORK_ID: `crq:${pyStr(pySubscript(job, 'run'))}`,
    CQ_RUN_ID: pyStr(pySubscript(job, 'job')),
    CQ_ROLE: judge ? 'judge' : 'fixer',
    CQ_TASK: 'crq-repair',
  };
}

/** `_dispatch(config, role, job, wt, directory, judge, deadline)`. */
async function innerDispatch(
  effects: DispatchEffects,
  config: Dict,
  role: unknown,
  jobIn: unknown,
  wt: string,
  directory: string,
  judge: boolean,
  deadline: number | null,
): Promise<unknown> {
  await effects.mkdir(directory);
  const job = copyKeepingNumbers(jobIn) as Dict;
  if (pyGet(job, 'triage_context') !== null) {
    return effects.drivers.cqJudge(config, role, job, wt, directory);
  }
  await effects.requireCanonicalDelivery(job);
  const snapshot = await effects.sourceSnapshot(config, job);
  // The excerpt leaves the machine for every driver: scan it before it is persisted.
  const snapshotPath = pyGet(snapshot, 'path');
  const snapshotContext: Dict = {
    current_path: pyTruthy(snapshotPath) ? snapshotPath : 'source-snapshot.txt',
    source: getDefault(snapshot, 'source', ''),
  };
  if (
    !pyTruthy(
      await effects.triageContextSafe(snapshotContext, `${directory}/source-snapshot-scan.json`),
    )
  ) {
    throw new PyError('ValueError', 'source snapshot secret scan rejected; refusing dispatch');
  }
  // The review diff is serialized into the judge prompt: each file section gets the same scan,
  // under its own path so path-gated rules apply as they do for the snapshot.
  for (const [index, [sectionPath, section]] of reviewDiffSections(
    getDefault(job, 'review_diff', ''),
  ).entries()) {
    const clean = await effects.triageContextSafe(
      { current_path: sectionPath, source: section },
      `${directory}/review-diff-scan-${index}.json`,
    );
    if (!pyTruthy(clean)) {
      throw new PyError('ValueError', 'review diff secret scan rejected; refusing dispatch');
    }
  }
  job.source_snapshot = snapshot;
  await effects.atomicWrite(`${directory}/source-snapshot.json`, snapshot);
  // Preparation can outlast the margin the admission checks allowed: sample the clock again at
  // this last boundary, charge the driver only what remains, and feed it to the blackout check.
  let bounded = config;
  if (deadline !== null) {
    const remaining = deadline - effects.monotonic();
    if (remaining < MIN_REMAINING_SECONDS) return { ...DEADLINE_STOP };
    bounded = withBudget(config, remaining / 60);
  }
  if (pyTruthy(await effects.blocked(getDefault(bounded, 'repair', {})))) {
    return {
      stop: 'blackout',
      summary: 'GLM peak blackout began during preparation; driver call not started',
    };
  }
  const driver = pySubscript(role, 'driver');
  if (driver === 'cq') {
    return judge
      ? effects.drivers.cqJudge(bounded, role, job, wt, directory)
      : effects.drivers.cqInvoke(bounded, role, job, wt, directory);
  }
  if (driver === 'codex')
    return effects.drivers.codexInvoke(bounded, role, job, wt, directory, judge);
  if (driver === 'paseo' && judge)
    return effects.drivers.paseoInvoke(bounded, role, job, wt, directory);
  throw new PyError('ValueError', 'unsupported role driver');
}

/** `dispatch(config, role, job, wt, directory, judge=False)`. */
export async function dispatch(
  effects: DispatchEffects,
  config: unknown,
  role: unknown,
  job: unknown,
  wt: string,
  directory: string,
  judge = false,
): Promise<unknown> {
  const cfg = config as Dict;
  const repairSection = getDefault(cfg, 'repair', {});
  if (!pyTruthy(pyGet(repairSection, 'fallback_models'))) {
    return effects.withCorrelation(correlationValues(job, judge), () =>
      innerDispatch(effects, cfg, role, job, wt, directory, judge, null),
    );
  }
  // Fallback admission applies to the lane being dispatched, not only CQ fixers.
  const started = effects.monotonic();
  const budget = pySubscript(pySubscript(cfg, 'repair'), 'budget');
  const deadline = started + minutesToSeconds(pySubscript(budget, 'wall_clock_min'));
  const waits: string[] = [];
  const baseline = judge ? null : await effects.git(wt, 'rev-parse', 'HEAD');
  let attempted = false;
  const seen = new Set<unknown>();
  let previousDirectory: string | null = null;
  const values = correlationValues(job, judge);
  const result = await effects.withCorrelation(values, async () => {
    for (const candidate of fallbackRoles(cfg, role)) {
      const provider = roleProvider(candidate);
      if (seen.has(provider) || !pyTruthy(effects.providerReady(candidate))) continue;
      seen.add(provider);
      const state = await effects.providerCooldowns(); // another item may have exhausted it
      const stamp = typeof provider === 'string' ? (state.get(provider) ?? '') : '';
      if (stamp > effects.utc()) {
        waits.push(stamp);
        continue;
      }
      let remaining = deadline - effects.monotonic();
      if (remaining < MIN_REMAINING_SECONDS) return { ...DEADLINE_STOP };
      if (attempted && !judge) {
        await effects.retainPreservingNested(wt, baseline, previousDirectory as string);
        // A fresh checkout at the baseline: -x removes ignored files, the doubled -f removes
        // nested repositories (retention already moved those into the evidence directory).
        await effects.git(wt, 'reset', '--hard', baseline as string);
        await effects.git(wt, 'clean', '-ffdx');
        // Retention and reset consume the shared budget; remeasure before the next launch.
        remaining = deadline - effects.monotonic();
        if (remaining < MIN_REMAINING_SECONDS) return { ...DEADLINE_STOP };
      }
      // A prior provider's run consumed wall clock: a fallback whose window would now reach the
      // blackout defers without spending. The typed clock stop writes no rate-limit pause.
      const bounded = withBudget(cfg, remaining / 60);
      if (attempted && pyTruthy(await effects.blocked(bounded.repair))) {
        return { stop: 'blackout', summary: 'GLM peak blackout; fallback launch deferred' };
      }
      attempted = true;
      previousDirectory = joinPath(directory, provider);
      const report = await innerDispatch(
        effects,
        bounded,
        candidate,
        job,
        wt,
        previousDirectory,
        judge,
        deadline,
      );
      if (!isDict(report)) {
        throw new PyError(
          'AttributeError',
          `'${pyTypeName(report)}' object has no attribute 'update'`,
        );
      }
      report.driver = pySubscript(candidate, 'driver');
      report.model = pySubscript(candidate, 'model');
      if (report.stop !== 'rate-limit') return report;
      waits.push(await effects.rememberProviderLimit(provider, report));
    }
    return undefined;
  });
  if (result !== undefined) return result;
  if (waits.length === 0) {
    return { stop: 'configuration', summary: 'no configured repair provider is available' };
  }
  const earliest = waits.reduce((a, b) => (b < a ? b : a)).replaceAll('Z', '+00:00');
  let end: bigint | null;
  try {
    end = parseUtcDetailed(earliest);
  } catch (e) {
    // fromisoformat's component errors (`day 30 must be in range 1..28 ...`) keep their text.
    if (e instanceof UtcParseError) throw new PyError('ValueError', e.message);
    throw e;
  }
  if (end === null)
    throw new PyError('ValueError', `Invalid isoformat string: ${pyRepr(earliest)}`);
  if (!utcHasOffset(earliest)) {
    throw new PyError('TypeError', "can't subtract offset-naive and offset-aware datetimes");
  }
  const seconds = Number(end - effects.nowMicros()) / 1_000_000;
  return { stop: 'rate-limit', retry_after_ms: Math.max(1000, seconds * 1000) };
}
