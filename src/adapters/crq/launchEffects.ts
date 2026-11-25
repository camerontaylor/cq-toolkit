/**
 * File-backed {@link LaunchEffects} for `admit.startOne` (`crq.launch`,
 * `crq.py:2004`), and the launch-bound part of {@link CoverageEffects}.
 *
 * Bound here, each to the Python it mirrors:
 * - `iso`, the run stamp, `item_repo`, `repo_registry.same_repo` / `by_repo`;
 * - `launch_band` (`policy/crq/tickSchedule.launchBand`);
 * - `rdir.mkdir(parents=True)` (exclusive mkdir);
 * - `make_worktree` / `remove_worktree` (`crq.py:331` / `:351`);
 * - `repair_tick.atomic(rdir / "meta.json", meta)` (indent 2, ASCII, newline);
 * - `append_work_record` (`crq.py:72`, best effort) and `event` (`crq.py:193`);
 * - the `_review` spawn (`subprocess.Popen([sys.executable, crq.py, "_review", run_id])`).
 *
 * NOT bound here (no adapter exists yet): the secret scans, the blocked
 * receipt, the author lease, the on-demand clone and the queue save. Each is a
 * REQUIRED injected seam, so a caller cannot build a launch that silently
 * skips one.
 */
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { atomicWrite } from './atomic.js';
import { GitPool, gitCall } from './gitExec.js';
import { checkoutReviewWorktree } from './reviewPreparation.js';
import { spawnReviewWrapper } from './reviewProcess.js';
import type { LaunchEffects, RepoCloneConfig } from '../../queue-runner/launch.js';
import { sameRepoIdentity } from '../../policy/crq/repoRegistry.js';
import { launchBand, type ScheduleContext } from '../../policy/crq/tickSchedule.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';

/** The seams with no adapter yet; each is required, none has a default. */
export type LaunchInjectedEffects = Pick<
  LaunchEffects,
  | 'scan'
  | 'scanBackfillContext'
  | 'writeBlockedReceipt'
  | 'checkAuthor'
  | 'grantAuthor'
  | 'onDemandClone'
  | 'saveQueue'
>;

export interface FileLaunchOptions extends LaunchInjectedEffects {
  readonly stateRoot: string;
  /** `CONFIG["worktree_root"]`. */
  readonly worktreeRoot: string;
  /** `CONFIG["worktree_prefix"]`. */
  readonly worktreePrefix: string;
  /** `CONFIG["clone"]`: the primary repository clone. */
  readonly primaryClone: string;
  /** `CONFIG["repo"]`. */
  readonly primaryRepo: string;
  /** `repo_registry.parse(CONFIG)` reduced to what launch reads. */
  readonly repos: readonly (RepoCloneConfig & { readonly repo: string })[];
  /** `launch_band` inputs, read per call so the clock is current. */
  readonly scheduleContext: () => ScheduleContext;
  /** The runner root (`ROOT`): the spawn's cwd. */
  readonly root: string;
  /** Absolute path of the crq entry the child re-enters (`crq.py`). */
  readonly entry: string;
  /** `[sys.executable]`: the interpreter and any leading flags. */
  readonly executable?: string;
  readonly executableArgs?: readonly string[];
  /** `WORK_RECORDS`; absent means no work-record file is configured. */
  readonly workRecords?: string;
  readonly pool: GitPool;
  readonly now?: () => Date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `now().strftime('%Y%m%dT%H%M%SZ')`. */
export function runStampOf(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** `iso()`: whole-second UTC with a `Z`. */
export function isoOf(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function jsonLine(value: Record<string, unknown>): string {
  return `${pythonJsonText(value as never, { asciiOnly: true, sortKeys: false, spacedSeparators: true })}\n`;
}

export function fileLaunchEffects(options: FileLaunchOptions): LaunchEffects {
  const now = options.now ?? (() => new Date());
  const eventsPath = join(options.stateRoot, 'events.jsonl');
  const rawEvent = async (kind: string, data: Record<string, unknown>): Promise<void> => {
    await mkdir(options.stateRoot, { recursive: true });
    await appendFile(eventsPath, jsonLine({ at: isoOf(now()), event: kind, ...data }));
  };
  const event: LaunchEffects['event'] = rawEvent;
  const cloneOf = (clone: string | null): string => clone ?? options.primaryClone;
  return {
    nowIso: () => isoOf(now()),
    runStamp: () => runStampOf(now()),
    // `item.get("repo") or REPO`: an empty or missing repo is the primary repo.
    itemRepo: (item) => {
      const repo = (item as { repo?: unknown }).repo;
      return typeof repo === 'string' && repo !== '' ? repo : options.primaryRepo;
    },
    isPrimaryRepo: (repo) => sameRepoIdentity(repo, options.primaryRepo),
    repoConfig: (repo) => options.repos.find((entry) => sameRepoIdentity(entry.repo, repo)) ?? null,
    onDemandClone: options.onDemandClone,
    launchBand: (item) => launchBand(item as never, options.scheduleContext()),
    allocateRun: async (runId) => {
      // `rdir.mkdir(parents=True)`: exclusive, so a collision throws.
      const rdir = join(options.stateRoot, 'runs', runId);
      await mkdir(dirname(rdir), { recursive: true });
      await mkdir(rdir);
      return rdir;
    },
    scan: options.scan,
    scanBackfillContext: options.scanBackfillContext,
    writeBlockedReceipt: options.writeBlockedReceipt,
    checkout: ({ runId, head, clone }) =>
      checkoutReviewWorktree({
        clone: cloneOf(clone),
        worktreeRoot: options.worktreeRoot,
        prefix: options.worktreePrefix,
        runId,
        head,
        pool: options.pool,
      }),
    // `remove_worktree`: every step is `check=False`; only the directory
    // sweep is guarded by the worktree prefix, as in Python.
    removeWorktree: async (path, branch, clone) => {
      const cwd = cloneOf(clone);
      await gitCall(options.pool, cwd, ['worktree', 'remove', '--force', path]);
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (name.startsWith(options.worktreePrefix)) await rm(path, { recursive: true, force: true });
      await gitCall(options.pool, cwd, ['worktree', 'prune']);
      if (branch) await gitCall(options.pool, cwd, ['branch', '-D', branch]);
    },
    checkAuthor: options.checkAuthor,
    grantAuthor: options.grantAuthor,
    writeMeta: async (rdir, meta) => {
      await atomicWrite(
        join(rdir, 'meta.json'),
        pythonJsonText(meta as never, {
          asciiOnly: true,
          sortKeys: false,
          indent: 2,
          trailingNewline: true,
        }),
      );
    },
    // Best effort: a failed append records `work_record_failed` and never throws.
    workStarted: async (record) => {
      if (options.workRecords === undefined) return;
      try {
        await mkdir(dirname(options.workRecords), { recursive: true });
        await appendFile(options.workRecords, jsonLine({ host: hostname(), ...record }));
      } catch (error) {
        try {
          await rawEvent('work_record_failed', {
            error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
          });
        } catch {
          // Same disk; the record stays best effort.
        }
      }
    },
    saveQueue: options.saveQueue,
    spawn: (runId) =>
      spawnReviewWrapper({
        stateRoot: options.stateRoot,
        runId,
        cwd: options.root,
        executable: options.executable ?? process.execPath,
        args: [...(options.executableArgs ?? []), options.entry, '_review'],
      }),
    event,
  };
}
