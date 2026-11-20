/**
 * `harvest_review` (crq.py:2619) for every kind except local-review, which stays
 * on `harvestLocalReviewExit`. Inactive: nothing imports this outside tests and
 * the harvest wiring. Every effect is injected; the queue and items are plain
 * records edited in place (numbers may arrive as retained `JsonNumber` leaves),
 * and the caller owns tick.lock.
 *
 * Python semantics kept: a seam error, a missing key (`KeyError`) or a wrong
 * type (`AttributeError`/`TypeError`) abandons the rest of the harvest, so it
 * throws here; only the two `except` clauses Python has (repair enqueue on a
 * receipt, legacy coverage lineage) are caught. Step order is the crash-recovery
 * contract: artifacts, `review_finished`, receipt, then queue mutation and save.
 */
import { JsonNumber, JsonObject, parseJsonValue, toPlainJson } from '../policy/crq/jsonValue.js';
import { pyPrefix } from './harvestDelivery.js';

export type Rec = Record<string, unknown>;
export type Item = Rec;
export type Queue = Rec;

/** `classify()` result; only the fields the harvest reads are typed. */
export interface Classification extends Rec {
  readonly outcome: string;
  readonly findings: unknown;
  readonly severity_counts: unknown;
  readonly counted: boolean;
}

/** A legacy coverage lineage that cannot be resolved (Python `ValueError`). */
export class CoverageLineageError extends Error {
  override readonly name = 'CoverageLineageError';
}

export interface HarvestKinds {
  readonly localReview: string;
  readonly reviewReceipt: string;
  readonly pushCurrent: string;
  readonly backfill: string;
  readonly author: string;
}

export interface HarvestConfig {
  /** `CONFIG["max_item_failures"]` */
  readonly maxItemFailures: number;
  /** `CONFIG["error_backoff_min"]` */
  readonly errorBackoffMin: number;
  /** `CONFIG["rate_limit_default_backoff_min"]` */
  readonly rateLimitDefaultBackoffMin: number;
}

export interface CoverageSeam {
  /** `coverage.new_ledger()` */
  newLedger(): unknown;
  /** `coverage._legacy_origins(q, item)`; throws {@link CoverageLineageError}. */
  legacyOrigins(q: Queue, item: Item): void;
  /** `coverage.record_review(...)`: returns the new ledger. */
  recordReview(
    ledger: unknown,
    args: {
      runId: unknown;
      completedAt: string;
      reviewedPaths: readonly unknown[];
      reviewSha: unknown;
      counted: true;
      outcome: 'completed';
      focusPaths: unknown;
    },
  ): unknown;
  /** `coverage.record_legacy_success(q, item, terminal_paths)` */
  recordLegacySuccess(q: Queue, item: Item, reviewedPaths: readonly unknown[]): void;
  /** `coverage.record_legacy_failure(q, item, at, outcome, run_id)` */
  recordLegacyFailure(q: Queue, item: Item, at: string, outcome: string, runId: string): void;
}

export interface HarvestReviewEffects {
  readonly kinds: HarvestKinds;
  readonly config: HarvestConfig;
  readonly coverage: CoverageSeam;
  /** `(RUNS / run_id / "exit.json").exists()` */
  exitFileExists(runId: string): Promise<boolean>;
  /** `run_liveness(rdir, item, run, has_exit)` */
  runLiveness(
    runId: string,
    item: Item,
    run: Rec,
    hasExit: boolean,
  ): Promise<'alive' | 'ambiguous' | 'harvest'>;
  /** `json.loads(exit.json)["exit"]`; throws when the file or key is missing. */
  readExitCode(runId: string): Promise<number | null>;
  /** `ended_at` of exit.json as epoch ms; null on OSError/ValueError/TypeError or absent. */
  readEndedAtMs(runId: string): Promise<number | null>;
  /** `usage_slots.write_next(STATE / "next-review-at", now())` */
  writeNext(): Promise<void>;
  readMeta(runId: string): Promise<Rec>;
  /** `classify(rdir / "review.ndjson", exit_code)` */
  classify(runId: string, exitCode: number | null): Promise<Classification>;
  writeClassification(runId: string, cls: Classification): Promise<void>;
  /** `findings_md(rdir / "review.ndjson", meta, cls)` written to findings.md. */
  writeFindings(runId: string, meta: Rec, cls: Classification): Promise<void>;
  /** `str(rdir / name)` */
  runPath(runId: string, name: string): string;
  /** Text of `review.ndjson`; throws when absent (Python `read_text`). */
  readReviewText(runId: string): Promise<string>;
  event(kind: string, data: Rec): Promise<void>;
  saveQueue(q: Queue): Promise<void>;
  /** `remove_worktree(Path(worktree), branch, clone=...)` */
  removeWorktree(worktree: unknown, branch: unknown, clone: string | null): Promise<void>;
  nowMs(): number;
  /** `iso(...)`: UTC, whole seconds, `Z`. */
  iso(ms?: number): string;
  /** `item_repo(item)` */
  itemRepo(item: Item): string;
  /** `repo_registry.same_repo(repo, REPO)` */
  isPrimaryRepo(repo: string): boolean;
  /** `repo_registry.by_repo(REPOS, repo)["clone"]`, null when the repo is not registered. */
  cloneFor(repo: string): string | null;
  /** `current_document(...)` then `review_receipt.write_receipt(STATE / "receipts", doc)`: the id. */
  writeReceipt(
    item: Item,
    outcome: string,
    meta: Rec,
    cls: Classification,
    runId: string,
  ): Promise<string>;
  /** `repair_tick.merged_current_enabled(module)` */
  mergedCurrentEnabled(): boolean;
  /** `repair_tick.enqueue(module, q, item, meta, rdir)`: truthy when repair is pending. */
  repairEnqueue(q: Queue, item: Item, meta: Rec, runId: string): Promise<unknown>;
  /** `backfill_runtime.harvest(...)` */
  backfillHarvest(
    q: Queue,
    item: Item,
    runId: string,
    meta: Rec,
    cls: Classification,
    exitCode: number | null,
    terminalVerified: boolean,
  ): Promise<string | null | undefined>;
  /** `_request_pr_review(item, run_id, meta, rdir, cls)` */
  requestPrReview(item: Item, runId: string, meta: Rec, cls: Classification): Promise<void>;
}

// ------------------------------------------------------------ Python helpers

/** Python truthiness over plain values and retained `JsonNumber` leaves. */
export function py(v: unknown): boolean {
  if (v instanceof JsonNumber) return v.integer !== null ? v.integer !== 0n : v.float !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof JsonObject) return v.entries.length > 0;
  if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
  if (typeof v === 'bigint') return v !== 0n;
  return Boolean(v);
}
function num(v: unknown, what: string): number {
  if (typeof v === 'number') return v;
  if (v instanceof JsonNumber) return v.integer !== null ? Number(v.integer) : (v.float as number);
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TypeError(`${what} is not a number`);
}
/** A float operand keeps a float result (`1.5 * 2` is `3.0`, not `3`). */
function sameKind(source: unknown, value: number): number | JsonNumber {
  return source instanceof JsonNumber && source.kind === 'float' ? JsonNumber.float(value) : value;
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** `f"{v}"` for the values these messages interpolate. */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v instanceof JsonNumber) return v.raw;
  return String(v);
}
function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber);
}
function rec(v: unknown, what: string): Rec {
  if (!isRec(v)) throw new TypeError(`${what} is not an object`);
  return v;
}
/** `d["key"]`: a missing key is a KeyError. */
function req(o: Rec, key: string): unknown {
  if (!(key in o)) throw new TypeError(`${key} missing`);
  return o[key];
}
/**
 * `cls["outcome"]` and its siblings: a classification missing a required key is a
 * KeyError at the access, not an `undefined` that consumes the run.
 */
function creq<K extends 'outcome' | 'findings' | 'severity_counts' | 'counted'>(
  cls: Classification,
  key: K,
): Classification[K] {
  if (!(key in cls)) throw new TypeError(`classification.${key} missing`);
  return cls[key];
}
/** `d.get(key, default)` as a value (a present key wins, even when null). */
function getOr(o: Rec, key: string, fallback: unknown): unknown {
  return key in o ? o[key] : fallback;
}
/** `d.setdefault(key, [])` followed by `.append`. */
function appendTo(o: Rec, key: string, value: unknown): void {
  if (!(key in o)) o[key] = [];
  const list = o[key];
  if (!Array.isArray(list)) throw new TypeError(`${key} is not a list`);
  list.push(value);
}
/** `d.setdefault(key, {})` returning the (possibly new) dict. */
function setdefaultRec(o: Rec, key: string): Rec {
  if (!(key in o)) o[key] = {};
  return rec(o[key], key);
}
/** Python `str.splitlines()` line boundaries (code points, `\r\n` as one). */
const LINE_BREAKS = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);
function pySplitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!LINE_BREAKS.has(text.charCodeAt(i))) continue;
    lines.push(text.slice(start, i));
    if (text.charCodeAt(i) === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** The `q.get("backfill_reservations", {}).get(id, {})["terminal_at"] = ...` no-op-when-absent write. */
function markReservationTerminal(q: Queue, attemptId: unknown, at: string): void {
  const all = getOr(q, 'backfill_reservations', {});
  const reservations = rec(all, 'backfill_reservations');
  // JSON object keys are strings: a non-string id never matches.
  // Own keys only: an inherited member (`constructor`, `toString`) is not a reservation.
  const reservation =
    typeof attemptId === 'string' && Object.hasOwn(reservations, attemptId)
      ? reservations[attemptId]
      : undefined;
  if (reservation === undefined) return;
  rec(reservation, 'reservation').terminal_at = at;
}

function pauseFor(q: Queue, outcome: string, runId: string): void {
  q.paused = true;
  q.pause_reason = `${outcome} on ${runId}; owner action needed`;
}

/** `set_rate_cooldown(q, cls, rdir)` */
export async function setRateCooldown(
  q: Queue,
  cls: Classification,
  runId: string,
  fx: Pick<HarvestReviewEffects, 'readEndedAtMs' | 'nowMs' | 'iso' | 'config'>,
): Promise<void> {
  let seconds: number;
  if (cls.wait_seconds !== undefined && cls.wait_seconds !== null) {
    seconds = num(cls.wait_seconds, 'wait_seconds');
  } else {
    const configured = q.rl_backoff_min;
    seconds =
      (py(configured) ? num(configured, 'rl_backoff_min') : fx.config.rateLimitDefaultBackoffMin) *
      60;
  }
  const ended = (await fx.readEndedAtMs(runId)) ?? fx.nowMs();
  const until = ended + seconds * 1000;
  const current = parseCooldown(q.cooldown_until);
  q.cooldown_until = fx.iso(current !== null ? Math.max(current, until) : until);
}
function parseCooldown(value: unknown): number | null {
  if (!py(value)) return null;
  if (typeof value !== 'string') throw new TypeError('cooldown_until is not a string');
  const ms = Date.parse(value.endsWith('Z') ? value : `${value}Z`);
  if (Number.isNaN(ms)) throw new Error(`invalid cooldown_until: ${value}`);
  return ms;
}

/** `author_dispatch_failed`: a consumed terminal with no automatic retry. */
async function authorDispatchFailed(
  item: Item,
  run: Rec,
  outcome: string,
  cls: Classification,
  fx: HarvestReviewEffects,
  why?: string,
): Promise<void> {
  const detail = why ?? `author review ${outcome} (not counted)`;
  const suffix = why ? '' : py(cls.message) ? `: ${fmt(cls.message)}` : '';
  item.state = 'author_failed';
  item.last_error = pyPrefix(
    `${detail}${suffix}; no automatic retry — owner disposition required`,
    300,
  );
  item.run = null;
  await fx.event('author_failed', { item: item.id, run: run.run_id, outcome });
}

/** Terminal `reviewedFiles` paths of the stream's `complete` records. */
function terminalPaths(text: string): unknown[] {
  const paths: unknown[] = [];
  for (const line of pySplitLines(text)) {
    let terminal: unknown;
    try {
      terminal = toPlainJson(parseJsonValue(line), { bigints: true });
    } catch {
      continue;
    }
    if (!isRec(terminal)) throw new TypeError('review stream record is not an object');
    if (terminal.type !== 'complete') continue;
    const reviewed = py(terminal.reviewedFiles) ? terminal.reviewedFiles : [];
    // Count-only terminal formats cannot establish per-path credit.
    if (!Array.isArray(reviewed)) continue;
    for (const entry of reviewed) {
      const value =
        typeof entry === 'string'
          ? entry
          : isRec(entry)
            ? py(entry.path)
              ? entry.path
              : entry.fileName
            : null;
      if (py(value)) paths.push(value);
    }
  }
  return paths;
}

// ------------------------------------------------------------------ harvest

const WAIT_ALIVE = 'detached review still alive';
const WAIT_ALIVE_AUTHOR = 'author: run alive';
const WAIT_AMBIGUOUS =
  'run not releasable (unverifiable identity, missing exit, or incomplete legacy ownership) — capacity retained, owner disposition required';
const WAIT_AMBIGUOUS_AUTHOR =
  'author: run not releasable (unverifiable identity, missing exit, or incomplete legacy ownership) — capacity retained, owner disposition required';

/** `harvest_review(q, item, dry)`; throws for a local-review item. */
export async function harvestReview(
  q: Queue,
  item: Item,
  dry: boolean,
  fx: HarvestReviewEffects,
): Promise<string | null> {
  const kind = req(item, 'kind');
  if (kind === fx.kinds.localReview)
    throw new Error('local-review is harvested by harvestLocalReviewExit');
  const r = rec(req(item, 'run'), 'item.run');
  const runId = req(r, 'run_id');
  if (typeof runId !== 'string') throw new TypeError('run.run_id is not a string');
  const isAuthor = kind === fx.kinds.author;
  const hasExit = await fx.exitFileExists(runId);
  const state = await fx.runLiveness(runId, item, r, hasExit);
  if (state === 'alive') {
    item.wait_reason = isAuthor ? WAIT_ALIVE_AUTHOR : WAIT_ALIVE;
    return null;
  }
  if (state === 'ambiguous') {
    // Fail closed: capacity retained, owner disposition required, no TTL release.
    if (!dry) await fx.event('review_ambiguous', { item: req(item, 'id'), run: runId });
    item.wait_reason = isAuthor ? WAIT_AMBIGUOUS_AUTHOR : WAIT_AMBIGUOUS;
    return null;
  }
  // "harvest": terminal exit evidence, valid identity, complete ownership, nothing alive.
  const exitCode = await fx.readExitCode(runId);
  if (dry) return `would harvest ${runId}`;
  await fx.writeNext();
  const meta = await fx.readMeta(runId);
  const cls = await fx.classify(runId, exitCode);
  await fx.writeClassification(runId, cls);
  await fx.writeFindings(runId, meta, cls);
  // One finished event per harvested run, before any kind-specific early return.
  await fx.event('review_finished', {
    item: req(item, 'id'),
    run: runId,
    outcome: creq(cls, 'outcome'),
    findings: creq(cls, 'findings'),
    severity: creq(cls, 'severity_counts'),
  });
  const id = fmt(item.id);
  if (kind === fx.kinds.reviewReceipt) return harvestReceipt(q, item, r, runId, meta, cls, id, fx);
  if (kind === fx.kinds.pushCurrent) return harvestPush(q, item, r, runId, meta, cls, id, fx);
  if (kind === fx.kinds.backfill) {
    const result = await fx.backfillHarvest(q, item, runId, meta, cls, exitCode, true);
    const attempts = getOr(item, 'attempts', []);
    if (!Array.isArray(attempts)) throw new TypeError('attempts is not a list');
    if (!py(item.run) && !attempts.some((a) => rec(a, 'attempt').run_id === runId)) {
      appendTo(item, 'attempts', {
        run_id: runId,
        band: getOr(r, 'band', 'background'),
        started_at: getOr(r, 'started_at', null),
        outcome: creq(cls, 'outcome'),
      });
      await fx.saveQueue(q);
    }
    return result ?? null;
  }
  if (kind === 'coverage') {
    try {
      fx.coverage.legacyOrigins(q, item);
    } catch (error) {
      if (!(error instanceof CoverageLineageError)) throw error;
      item.state = 'blocked';
      item.vendor_state = 'terminal';
      item.run = null;
      const unresolved = 'legacy coverage lineage unresolved: ' + error.message;
      item.last_error = unresolved;
      if (py(item.attempt_id)) markReservationTerminal(q, item.attempt_id, fx.iso());
      if (creq(cls, 'outcome') === 'auth' || creq(cls, 'outcome') === 'action_required')
        pauseFor(q, creq(cls, 'outcome'), runId);
      if (creq(cls, 'outcome') === 'rate_limited') await setRateCooldown(q, cls, runId, fx);
      await fx.saveQueue(q);
      await fx.removeWorktree(req(meta, 'worktree'), req(meta, 'wt_branch'), null);
      return unresolved;
    }
    if (py(item.attempt_id)) {
      item.vendor_state = 'terminal';
      markReservationTerminal(q, item.attempt_id, fx.iso());
    }
  }
  return harvestGeneric(q, item, r, runId, meta, cls, id, fx);
}

async function harvestReceipt(
  q: Queue,
  item: Item,
  r: Rec,
  runId: string,
  meta: Rec,
  cls: Classification,
  id: string,
  fx: HarvestReviewEffects,
): Promise<string> {
  // Receipt before queue mutation: a crash here is recovered by re-harvest.
  const partial = partialScope(item);
  const outcome = receiptOutcome(cls, partial);
  const receiptId = await fx.writeReceipt(item, outcome, meta, cls, runId);
  item.receipt_id = receiptId;
  appendTo(item, 'attempts', {
    run_id: runId,
    band: getOr(r, 'band', 'background'),
    started_at: getOr(r, 'started_at', null),
    outcome: creq(cls, 'outcome'),
    counted: creq(cls, 'counted'),
    receipt_id: receiptId,
  });
  item.run = null;
  if (outcome === 'terminal-with-findings') item.remediation_state = 'pending-merged-evidence';
  if (creq(cls, 'counted') && py(creq(cls, 'findings')) && !partial && fx.mergedCurrentEnabled()) {
    try {
      await fx.repairEnqueue(q, item, meta, runId);
    } catch (error) {
      item.repair_error = pyPrefix(message(error), 300);
    }
  }
  // Separate from cycles: backfill must never duplicate these jobs.
  item.state = creq(cls, 'counted') ? 'done' : 'blocked';
  item.last_error = getOr(cls, 'message', null);
  if (creq(cls, 'outcome') === 'rate_limited') await setRateCooldown(q, cls, runId, fx);
  if (creq(cls, 'outcome') === 'action_required' || creq(cls, 'outcome') === 'auth')
    pauseFor(q, creq(cls, 'outcome'), runId);
  await fx.saveQueue(q);
  await fx.removeWorktree(req(meta, 'worktree'), req(meta, 'wt_branch'), null);
  return `${id}: ${outcome}; receipt ${receiptId} (repair evidence tracked separately)`;
}

function partialScope(item: Item): boolean {
  const paths = rec(req(item, 'capture'), 'item.capture').paths;
  if (!Array.isArray(paths)) throw new TypeError('capture.paths is not a list');
  return paths.some((p) => {
    const d = req(rec(p, 'capture path'), 'disposition');
    return d === 'unsupported' || d === 'ambiguous';
  });
}
function receiptOutcome(cls: Classification, partial: boolean): string {
  if (!creq(cls, 'counted')) return creq(cls, 'outcome');
  if (partial) return 'partial-scope';
  return py(creq(cls, 'findings')) ? 'terminal-with-findings' : 'terminal-clean';
}

/** `iso(now() + timedelta(minutes=error_backoff_min * 2 ** (failures - 1)))` */
function backoffIso(failures: number, fx: HarvestReviewEffects): string {
  return fx.iso(fx.nowMs() + fx.config.errorBackoffMin * 2 ** (failures - 1) * 60000);
}

async function harvestPush(
  q: Queue,
  item: Item,
  r: Rec,
  runId: string,
  meta: Rec,
  cls: Classification,
  id: string,
  fx: HarvestReviewEffects,
): Promise<string> {
  // Receipt before queue mutation; findings stay in the receipt and no repair,
  // coverage, ledger or publication path ever runs for a foreign repo.
  const partial = partialScope(item);
  const outcome = receiptOutcome(cls, partial);
  const receiptId = await fx.writeReceipt(item, outcome, meta, cls, runId);
  item.receipt_id = receiptId;
  appendTo(item, 'attempts', {
    run_id: runId,
    band: getOr(r, 'band', 'background'),
    started_at: getOr(r, 'started_at', null),
    outcome: creq(cls, 'outcome'),
    counted: creq(cls, 'counted'),
    receipt_id: receiptId,
  });
  item.run = null;
  const repo = fx.itemRepo(item);
  if (creq(cls, 'counted')) {
    // reviewed_tip advances ONLY on a counted review of the pinned range; a split
    // part covers a path subset and must never advance it.
    const record = setdefaultRec(setdefaultRec(q, 'push_discovery'), repo);
    const subject = rec(req(item, 'subject'), 'item.subject');
    const wholeRange = !(py(subject.paths_filter) || py(item.depends_on));
    const reviewed = record.reviewed_tip;
    if (
      wholeRange &&
      (reviewed === undefined || reviewed === null || reviewed === req(subject, 'base'))
    )
      record.reviewed_tip = req(rec(req(item, 'capture'), 'item.capture'), 'target');
    item.failures = 0;
    item.last_error = null;
    item.state = 'done';
    if (py(creq(cls, 'findings'))) {
      // Findings delivery debt: one idempotent issue, retried by later ticks.
      item.issue_request = {
        run_id: runId,
        severity_counts: creq(cls, 'severity_counts'),
        findings_md: fx.runPath(runId, 'findings.md'),
        base: req(subject, 'base'),
        head: req(subject, 'head'),
      };
      item.issue_pending = true;
    }
  } else if (creq(cls, 'outcome') === 'rate_limited') {
    await setRateCooldown(q, cls, runId, fx);
    item.last_error = `rate limited (${fmt(cls.message)}); not counted`;
    item.state = 'pending';
  } else if (creq(cls, 'outcome') === 'action_required' || creq(cls, 'outcome') === 'auth') {
    pauseFor(q, creq(cls, 'outcome'), runId);
    item.last_error = getOr(cls, 'message', null);
    item.state = 'pending';
  } else {
    const previous = getOr(item, 'failures', 0);
    const failures = num(previous, 'item.failures') + 1;
    item.failures = sameKind(previous, failures);
    item.last_error = `${creq(cls, 'outcome')}: ${fmt(cls.message)}`;
    if (
      creq(cls, 'outcome') === 'skipped' ||
      creq(cls, 'outcome') === 'too_large' ||
      failures >= fx.config.maxItemFailures
    ) {
      item.state = 'blocked';
    } else {
      item.state = 'pending';
      item.not_before = backoffIso(failures, fx);
    }
  }
  // Delivery debt is persisted here, never uploaded inline.
  await fx.saveQueue(q);
  await fx.removeWorktree(req(meta, 'worktree'), req(meta, 'wt_branch'), fx.cloneFor(repo));
  return `${id}: ${outcome}; receipt ${receiptId}`;
}

async function harvestGeneric(
  q: Queue,
  item: Item,
  r: Rec,
  runId: string,
  meta: Rec,
  cls: Classification,
  id: string,
  fx: HarvestReviewEffects,
): Promise<string> {
  const kind = item.kind;
  const openOrDelta = kind === 'open' || kind === 'delta';
  // A foreign open/delta review's worktree branch lives in that repo's clone.
  let cleanupClone: string | null = null;
  if (openOrDelta && !fx.isPrimaryRepo(fx.itemRepo(item)))
    cleanupClone = fx.cloneFor(fx.itemRepo(item));
  await fx.removeWorktree(req(meta, 'worktree'), req(meta, 'wt_branch'), cleanupClone);
  const attempt: Rec = {
    run_id: runId,
    band: getOr(r, 'band', 'background'),
    started_at: getOr(r, 'started_at', null),
    outcome: creq(cls, 'outcome'),
    counted: creq(cls, 'counted'),
    at: fx.iso(),
    head: req(meta, 'head'),
    base: req(meta, 'base'),
    message: getOr(cls, 'message', null),
  };
  appendTo(item, 'attempts', attempt);
  item.run = null;
  const o = creq(cls, 'outcome');
  if (o === 'completed') return harvestCompleted(q, item, r, runId, meta, cls, id, fx);
  if (o === 'rate_limited') {
    await setRateCooldown(q, cls, runId, fx);
    attempt.deadline = req(q, 'cooldown_until');
    const backoff = py(q.rl_backoff_min)
      ? num(q.rl_backoff_min, 'rl_backoff_min')
      : fx.config.rateLimitDefaultBackoffMin;
    const doubled = backoff * 2;
    q.rl_backoff_min =
      doubled < 240 ? sameKind(py(q.rl_backoff_min) ? q.rl_backoff_min : null, doubled) : 240;
    item.last_error = `rate limited (${fmt(cls.message)}); not counted`;
    if (kind === fx.kinds.author) {
      await authorDispatchFailed(
        item,
        r,
        o,
        cls,
        fx,
        `rate limited (${fmt(cls.message)}); global cooldown until ${fmt(q.cooldown_until)}`,
      );
      return `${id}: rate limited → global cooldown until ${fmt(q.cooldown_until)}; author terminal (no retry)`;
    }
    item.state = 'pending';
    return `${id}: rate limited → global cooldown until ${fmt(q.cooldown_until)}`;
  }
  if (o === 'action_required' || o === 'auth') {
    q.paused = true;
    q.pause_reason = `${o} on ${runId}: ${fmt(cls.message)} — owner action needed (never --use-credits)`;
    item.last_error = q.pause_reason;
    await fx.event('queue_paused', { reason: q.pause_reason });
    if (kind === fx.kinds.author) {
      await authorDispatchFailed(
        item,
        r,
        o,
        cls,
        fx,
        `${o} → queue PAUSED (${fmt(q.pause_reason)})`,
      );
      return `${id}: ${o} → queue PAUSED; author terminal (no retry)`;
    }
    item.state = 'pending';
    return `${id}: ${o} → queue PAUSED`;
  }
  // error / interrupted / skipped / too_large: item-level backoff, never counted
  const previous = getOr(item, 'failures', 0);
  const failures = num(previous, 'item.failures') + 1;
  item.failures = sameKind(previous, failures);
  item.last_error = `${o}: ${fmt(cls.message)}`;
  if (kind === 'coverage') fx.coverage.recordLegacyFailure(q, item, fx.iso(), o, runId);
  if (kind === fx.kinds.author) {
    // An attempted author dispatch is always a consumed terminal.
    await authorDispatchFailed(item, r, o, cls, fx);
    return `${id}: ${o} (not counted) → ${fmt(item.state)} (author, no retry)`;
  }
  if (o === 'skipped' || o === 'too_large' || failures >= fx.config.maxItemFailures) {
    item.state = 'blocked';
  } else {
    item.state = 'pending';
    item.not_before = backoffIso(failures, fx);
  }
  return `${id}: ${o} (not counted) → ${fmt(item.state)}`;
}

async function harvestCompleted(
  q: Queue,
  item: Item,
  r: Rec,
  runId: string,
  meta: Rec,
  cls: Classification,
  id: string,
  fx: HarvestReviewEffects,
): Promise<string> {
  const kind = item.kind;
  const openOrDelta = kind === 'open' || kind === 'delta';
  item.failures = 0;
  item.last_error = null;
  const head = req(meta, 'head');
  const record: Rec = {
    run_id: runId,
    cycle: req(meta, 'cycle'),
    base: req(meta, 'base'),
    head,
    pr_head: getOr(meta, 'pr_head', head),
    dirty_diff: 'clean tree',
    range_policy: getOr(meta, 'range_policy', null),
    ndjson: fx.runPath(runId, 'review.ndjson'),
    findings: creq(cls, 'findings'),
    severity_counts: creq(cls, 'severity_counts'),
    completed_at: fx.iso(),
  };
  if (py(meta.profile)) {
    record.profile = meta.profile;
    record.config_digest = req(meta, 'config_digest');
  }
  if (kind === fx.kinds.author) {
    // Genuine cycle evidence, but NEVER repair debt and NEVER coverage credit.
    appendTo(item, 'author_cycles', record);
    item.state = 'done';
    return `${id}: completed (${fmt(creq(cls, 'findings'))} findings) [author: no repair/coverage credit]`;
  }
  appendTo(item, 'cycles', record);
  if (openOrDelta && py(item.pr) && py(creq(cls, 'findings'))) {
    // All repos use the same durable, bounded PR-review delivery.
    await fx.requestPrReview(item, runId, meta, cls);
  }
  if (openOrDelta && py(item.pr) && !py(creq(cls, 'findings'))) {
    // Clean receipts never replace undelivered findings debt.
    item.clean_review_request = {
      run_id: runId,
      pr: item.pr,
      base: req(meta, 'base'),
      head,
      ndjson: fx.runPath(runId, 'review.ndjson'),
    };
    item.clean_review_pending = true;
    item.clean_review_attempts = 0;
  }
  if (openOrDelta && !fx.isPrimaryRepo(fx.itemRepo(item))) {
    // Foreign cycles are real evidence; coverage and repair stay primary-only.
    item.state = 'done';
    return `${id}: completed (${fmt(creq(cls, 'findings'))} findings)`;
  }
  const paths = terminalPaths(await fx.readReviewText(runId));
  const reviewSha = py(meta.coverage_sha)
    ? meta.coverage_sha
    : py(meta.reviewed_tip)
      ? meta.reviewed_tip
      : head;
  const focus = py(meta.coverage_paths) ? meta.coverage_paths : getOr(meta, 'planned_paths', null);
  q.coverage = fx.coverage.recordReview(py(q.coverage) ? q.coverage : fx.coverage.newLedger(), {
    runId: req(meta, 'run_id'),
    completedAt: record.completed_at as string,
    reviewedPaths: paths,
    reviewSha,
    counted: true,
    outcome: 'completed',
    focusPaths: focus,
  });
  if (kind === 'coverage' && py(item.coverage_source))
    fx.coverage.recordLegacySuccess(q, item, paths);
  const repairPending = await fx.repairEnqueue(q, item, meta, runId);
  item.state = py(repairPending) ? 'repairing' : 'done';
  return `${id}: completed (${fmt(creq(cls, 'findings'))} findings)`;
}
