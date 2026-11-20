/**
 * `crq.launch`: admission of one planned item into a detached `_review` run,
 * over the plain mutable queue records `startOne` already edits in place.
 * Inactive: nothing binds it to a tick, slot or unit.
 *
 * The order is Python's and is load-bearing: author lease check, unique run
 * directory, per-kind clone and scan classes, the secret scan (a failure blocks
 * the item and returns the run id, leaving the artifact), worktree checkout,
 * meta construction, the author grant recheck, then meta.json, the work-started
 * record, the `reviewing` reservation saved BEFORE the spawn, and the spawn.
 * Everything that touches the world is injected through {@link LaunchEffects};
 * the caller owns tick.lock throughout.
 */
import { StartAuthorRefused, type StartPlan, type StartRecord } from './startOne.js';
import {
  AUTHOR_KIND,
  BACKFILL_KIND,
  LOCAL_REVIEW_KIND,
  REVIEW_RECEIPT_KIND as RECEIPT_KIND,
} from '../policy/crq/tickSchedule.js';
import { ReviewSpawnError } from './reviewLaunch.js';
import { ReviewCheckoutError } from './reviewPreparation.js';

export const PUSH_KIND = 'push-current';
const AUTHOR_FAILED = 'author_failed';

/** `UNIVERSAL_SCAN_CLASSES`: the secret shapes every foreign scan carries. */
export const UNIVERSAL_SCAN_CLASSES: readonly string[] = [
  'class:token-ssh-plumbing',
  'class:route-key-material',
  'class:key-material-env',
  'class:inline-secret-assignments',
];

/** The plan fields `launch` reads beyond {@link StartPlan}. */
export interface LaunchPlan extends StartPlan {
  readonly cycle?: unknown;
  readonly branch?: unknown;
  readonly pr_head?: unknown;
  readonly review_pin?: unknown;
  readonly range_policy?: unknown;
  readonly profile?: unknown;
  readonly config_digest?: unknown;
}

export interface LaunchScanDecision {
  readonly ok: boolean;
  readonly denylistHits: number;
  readonly gitleaksHits: number;
  readonly artifactPath: string;
}

export interface RepoCloneConfig {
  readonly clone: string;
  readonly scanExtraClasses: readonly string[];
}

export interface LaunchEffects {
  /** `iso()`. */
  nowIso(): string;
  /** `now().strftime('%Y%m%dT%H%M%SZ')`. */
  runStamp(): string;
  /** `item_repo(item)`. */
  itemRepo(item: StartRecord): string;
  /** `repo_registry.same_repo(item_repo(item), REPO)`. */
  isPrimaryRepo(repo: string): boolean;
  /** `repo_registry.by_repo(REPOS, repo)`. */
  repoConfig(repo: string): RepoCloneConfig | null;
  /** `local_review_runtime.transport.clone_for`: an on-demand clone path. */
  onDemandClone(repo: string): Promise<string>;
  /** `launch_band(item)`. */
  launchBand(item: StartRecord): 'interactive' | 'background';
  /** `rdir.mkdir(parents=True)`; throws on a collision. Returns the run directory. */
  allocateRun(runId: string): Promise<string>;
  /**
   * `secret_scan` (range) or `secret_scan_diff` over the hardened projection
   * patch with the item's exemption base. `clone` is null for the primary repo.
   */
  scan(request: {
    mode: 'range' | 'projection';
    item: StartRecord;
    base: string;
    head: string;
    clone: string | null;
    classes: readonly string[] | null;
    rdir: string;
  }): Promise<LaunchScanDecision>;
  /** The backfill context scan, run only after the main scan was clean. */
  scanBackfillContext(request: {
    item: StartRecord;
    base: string;
    head: string;
    rdir: string;
  }): Promise<LaunchScanDecision>;
  /** `current_document(item, 'blocked-secret-scan', rdir=)` then `write_receipt`: the receipt id. */
  writeBlockedReceipt(item: StartRecord, rdir: string): Promise<string>;
  /** `make_worktree`; throws {@link ReviewCheckoutError} for RuntimeError/TimeoutExpired. */
  checkout(request: {
    runId: string;
    head: string;
    clone: string | null;
  }): Promise<{ path: string; branch: string }>;
  removeWorktree(path: string, branch: string, clone: string | null): Promise<void>;
  /** `author_lease.check_queue(item, at)`; throws {@link StartAuthorRefused}. */
  checkAuthor(item: StartRecord, at: string): void;
  /** `author_lease.grant_queue(item, at)`; mutates the item, throws {@link StartAuthorRefused}. */
  grantAuthor(item: StartRecord, at: string): void;
  writeMeta(rdir: string, meta: Record<string, unknown>): Promise<void>;
  /** `append_work_record`; best effort, a failure never fails the launch. */
  workStarted(record: Record<string, unknown>): Promise<void>;
  saveQueue(): Promise<void>;
  /** Start the detached child; throws {@link ReviewSpawnError} for an OS spawn failure. */
  spawn(runId: string, rdir: string): Promise<number>;
  event(
    kind: 'blocked' | 'spawn_failed' | 'review_started',
    data: Record<string, unknown>,
  ): Promise<void>;
}

/** Python `text[:n]` counts code points. */
function clip(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join('');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source[key] ?? null;
  return out;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`invalid launch plan ${name}`);
  return value;
}

function flagList(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

const truthy = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== 0 &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0) &&
  !(
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0
  );

export async function launch(
  queue: StartRecord,
  item: StartRecord,
  plan: LaunchPlan,
  fx: LaunchEffects,
): Promise<string> {
  const kind = String(item.kind);
  if (kind === AUTHOR_KIND) fx.checkAuthor(item, fx.nowIso());
  const runId = `${String(item.id)}-${fx.runStamp()}`;
  const rdir = await fx.allocateRun(runId);
  const base = requireString(plan.base, 'base');
  const head = requireString(plan.head, 'head');
  const itemRepo = fx.itemRepo(item);
  let clone: string | null = null;
  let classes: readonly string[] | null = null;
  if (kind === PUSH_KIND) {
    const cfg = fx.repoConfig(itemRepo);
    if (cfg === null) throw new Error(`push item names an unconfigured repo: ${itemRepo}`);
    clone = cfg.clone;
    classes = [...UNIVERSAL_SCAN_CLASSES, ...cfg.scanExtraClasses];
  } else if (
    (kind === 'open' || kind === 'delta' || kind === LOCAL_REVIEW_KIND) &&
    !fx.isPrimaryRepo(itemRepo)
  ) {
    const cfg = fx.repoConfig(itemRepo);
    if (cfg === null && kind === LOCAL_REVIEW_KIND) {
      clone = await fx.onDemandClone(itemRepo);
      classes = UNIVERSAL_SCAN_CLASSES;
    } else if (cfg === null) {
      throw new Error(`${kind} item names an unconfigured repo: ${itemRepo}`);
    } else {
      clone = cfg.clone;
      classes = [...UNIVERSAL_SCAN_CLASSES, ...cfg.scanExtraClasses];
    }
  }
  let scan = await fx.scan({
    mode: kind === RECEIPT_KIND || kind === PUSH_KIND ? 'projection' : 'range',
    item,
    base,
    head,
    clone,
    classes,
    rdir,
  });
  if (scan.ok && kind === BACKFILL_KIND)
    scan = await fx.scanBackfillContext({ item, base, head, rdir });
  if (!scan.ok) {
    item.state = 'blocked';
    item.last_error =
      `secret scan failed before upload: ${String(scan.denylistHits)} denylist + ` +
      `${String(scan.gitleaksHits)} gitleaks hit(s) — see ${rdir}/secret-scan.json`;
    if (kind === AUTHOR_KIND && 'author_lease' in item) {
      record(item.author_lease).secret_scan_blocked = true;
      await fx.saveQueue();
    }
    if (kind === RECEIPT_KIND || kind === PUSH_KIND) {
      item.receipt_id = await fx.writeBlockedReceipt(item, rdir);
      await fx.saveQueue();
    }
    await fx.event('blocked', { item: item.id, reason: item.last_error });
    return runId;
  }
  let worktree: { path: string; branch: string };
  try {
    worktree = await fx.checkout({ runId, head, clone });
  } catch (error) {
    if (!(error instanceof ReviewCheckoutError)) throw error;
    if (kind === AUTHOR_KIND)
      // An admitted author head the clone cannot check out stays ungranted and
      // waits for its lease deadline instead of failing every tick.
      throw new StartAuthorRefused('author head cannot be checked out', { cause: error });
    item.state = 'blocked';
    item.last_error = clip(`review worktree checkout failed: ${messageOf(error)}`, 300);
    await fx.event('blocked', { item: item.id, reason: item.last_error });
    await fx.saveQueue();
    return runId;
  }
  const cliCmd = ['coderabbit', 'review', '--agent', '--deep'];
  if (
    kind === AUTHOR_KIND ||
    kind === RECEIPT_KIND ||
    kind === PUSH_KIND ||
    truthy(plan.range_policy)
  )
    cliCmd.push('--committed');
  const startedAt = fx.nowIso();
  const meta: Record<string, unknown> = {
    run_id: runId,
    item_id: item.id,
    pr: item.pr,
    kind,
    repo: itemRepo,
    workId: `crq:${runId}`,
    label: plan.label,
    cycle: plan.cycle ?? null,
    base,
    head,
    pr_head: plan.pr_head ?? head,
    review_pin: plan.review_pin ?? base,
    target: plan.target,
    pr_branch: plan.branch ?? null,
    worktree: worktree.path,
    wt_branch: worktree.branch,
    dirty_diff: 'clean tree',
    range_policy: plan.range_policy ?? null,
    band: fx.launchBand(item),
    started_at: startedAt,
    cmd: [...cliCmd, '--base-commit', base],
  };
  if (truthy(plan.profile)) {
    const flags = record(plan.profile).flags;
    meta.profile = plan.profile;
    meta.config_digest = plan.config_digest;
    meta.cmd = ['coderabbit', 'review', ...flagList(flags)];
  }
  if (kind === LOCAL_REVIEW_KIND) {
    const flags = record(item.profile).flags;
    meta.profile = item.profile;
    meta.cmd = ['coderabbit', 'review', ...flagList(flags)];
  }
  if (kind === BACKFILL_KIND)
    meta.backfill = pick(item, ['subject_id', 'job_id', 'attempt_id', 'target', 'scope_digest']);
  if (kind === RECEIPT_KIND) {
    meta.capture = item.capture;
    meta.source = item.subject;
  }
  const subject = record(item.subject);
  if (kind === PUSH_KIND)
    meta.push = { base: subject.base, head: subject.head, target: plan.target };
  if (kind === 'merged' || kind === 'coverage') {
    const measure = record(item.measure);
    meta.planned_paths = measure.synthetic_paths ?? null;
    meta.reviewed_tip = measure.merge_queue ?? null;
    meta.coverage_sha = item.coverage_sha ?? null;
    meta.coverage_paths = item.coverage_paths ?? null;
  }
  if (kind === AUTHOR_KIND)
    meta.author = pick(record(item.author), ['request_id', 'base', 'head', 'target', 'cycle']);
  // Nothing is reserved yet, so any failure before the reservation removes the
  // prepared worktree. Python removes it only for `AuthorRefused` around the
  // grant; removing it for every error here (including the meta write) is
  // deliberately broader, because a leaked worktree is worse than a removed one.
  try {
    if (kind === AUTHOR_KIND)
      // Scan/worktree preparation may outlast the wait deadline. Recheck
      // immediately before reservation, still under the same tick lock.
      fx.grantAuthor(item, fx.nowIso());
    await fx.writeMeta(rdir, meta);
  } catch (error) {
    await fx.removeWorktree(worktree.path, worktree.branch, clone);
    throw error;
  }
  try {
    await fx.workStarted({
      type: 'work-started',
      workId: meta.workId,
      at: startedAt,
      source: 'crq',
      role: 'reviewer',
      task: `pr${String(item.pr)}`,
      runId,
      harness: 'coderabbit',
      repo: itemRepo,
      pr: item.pr,
      head,
    });
  } catch {
    /* best effort (R5): a failed append never fails the launch */
  }
  item.state = 'reviewing';
  const run: Record<string, unknown> = {
    run_id: runId,
    pid: null,
    started_at: startedAt,
    band: meta.band,
    launch_pending: true,
  };
  item.run = run;
  item.wait_reason = null;
  const starts: unknown[] = Array.isArray(queue.starts) ? queue.starts : [];
  queue.starts = starts;
  starts.push(startedAt);
  // Reserve identity/quota BEFORE any child or remote status mutation. A crash
  // leaves a known run to reconcile, never a pending item to redispatch.
  await fx.saveQueue();
  let pid: number;
  try {
    pid = await fx.spawn(runId, rdir);
  } catch (error) {
    if (
      !(error instanceof ReviewSpawnError) ||
      (kind !== AUTHOR_KIND && kind !== LOCAL_REVIEW_KIND)
    )
      throw error;
    // A failed spawn is a CONSUMED, DISTINCT terminal admission: the start was
    // persisted above, so no automatic retry can double-spend it.
    item.run = {
      run_id: runId,
      pid: null,
      started_at: startedAt,
      band: meta.band,
      launch_pending: false,
      spawn_failed_at: fx.nowIso(),
      error: clip(error.message, 200),
    };
    item.state = kind === LOCAL_REVIEW_KIND ? 'failed' : AUTHOR_FAILED;
    item.last_error = clip(`${kind} spawn failed (no retry): ${error.message}`, 300);
    // Persist the terminal state first: if the event write rejects, the queue
    // must not stay at the `launch_pending` reservation with no child.
    await fx.saveQueue();
    await fx.event('spawn_failed', { item: item.id, run: runId, error: clip(error.message, 200) });
    return runId;
  }
  run.pid = pid;
  run.launch_pending = false;
  await fx.saveQueue();
  await fx.event('review_started', {
    item: item.id,
    run: runId,
    base,
    head,
    label: plan.label,
  });
  return runId;
}
