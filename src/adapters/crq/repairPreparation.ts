/**
 * Filesystem, process and state binding for the operator-only
 * `crq repair-prepare` (E1 durable enqueue).
 *
 * This is the adapter layer: it reads files, spawns git and the secret
 * scanner, holds the real `tick.lock` and performs the atomic job/queue
 * writes. Every root is supplied explicitly by the caller
 * (`--runner-root`, `--state-root`); no working-directory default is
 * consulted. The only environment input is the `PATH` snapshot the entry
 * threads in for the gitleaks availability probe (Python's `shutil.which`);
 * this module never reads the ambient environment itself.
 *
 * It composes the merged C1 modules and changes none of them:
 * `prepareRepairGates` (read half, exact mutation bytes) and
 * `executeRepairPreparation` (write ordering). The operator command is not a
 * unit capability; `capabilities.json` stays `['watchdog']`.
 *
 * Copied-state-root rule: never run this against live CRQ state before the
 * declared cutover. The first production-shaped run must be a copied state
 * root, because the commit point rewrites the whole `state/queue.json` from a
 * re-serialized parse.
 *
 * Failure mapping (frozen statuses, no new state field): refusals and
 * completed/refused effects exit 1, an unconfirmed effect step exits 1 with an
 * `indeterminate` artifact, a busy `tick.lock` exits 3 (Python `ran_locked`
 * parity), an unsupported lock exits 1 typed, and usage errors exit 2.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDenylistPatterns } from '../../ops/dev/denylist.js';
import { makeSubprocessDevEffects } from '../../ops/dev/effects.js';
import type {
  RepairGateGit,
  RepairPreparationState,
  RepairScan,
  PrepareRepairGatesResult,
} from '../../ops/crq/internal/repairPrepareGates.js';
import { prepareRepairGates } from '../../ops/crq/internal/repairPrepareGates.js';
import type {
  RepairPreparationEffects,
  RepairPreparationExecutionResult,
} from '../../ops/crq/internal/repairPrepareExecution.js';
import { executeRepairPreparation } from '../../ops/crq/internal/repairPrepareExecution.js';
import {
  FindingInbox,
  type FindingPublication,
} from '../../ops/review/internal/crq/findingInbox.js';
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { atomicJsonText } from '../../policy/crq/pythonJson.js';
import { checkCanonicalFindingId } from '../../policy/crq/repairBinding.js';
import { withFixInstructions } from '../../policy/crq/repairGates.js';
import type { RunnerArtifact, RunnerResult } from '../../queue-runner/runner.js';
import { atomicWrite } from './atomic.js';
import { fileFindingStore, type FindingStore } from './findingStore.js';
import { withLock } from './lock.js';
import { makeRepairScan } from './repairScan.js';
import { SlotBusyError, UnsupportedLockError } from '../lock/slotLock.js';

/** `bounded.JOB_ID`: one exact CRQ job id, never a path. */
const JOB_ID = /^crq-[A-Za-z0-9._-]+$/;
const DEFAULT_MAX_ROUNDS_PER_PIN = 2;

export function checkRepairJobId(value: string): boolean {
  return JOB_ID.test(value);
}

/** Python text-mode reads translate CRLF and lone CR to LF. */
function pythonUniversalNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Strict UTF-8 like the other crq adapters: an invalid byte raises instead of
 * becoming U+FFFD. `ignoreBOM` keeps a leading BOM, so the JSON parser rejects
 * it as Python does.
 */
async function readTextStrict(path: string): Promise<string> {
  const bytes = await readFile(path);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return pythonUniversalNewlines(text);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Read one state file: absent is `undefined`, a symlink or non-regular file is
 * an error, every other failure propagates so the gates map it to their typed
 * refusal. A symlink is never followed.
 */
async function readOptionalStateFile(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error('state path is not a regular file');
  return readTextStrict(path);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- pure parse

export type RepairConfigError = 'config-unreadable' | 'config-invalid' | 'clone-missing';

export type RepairConfigResult =
  | { readonly ok: true; readonly value: { clone: string; maxRoundsPerPin: number } }
  | { readonly ok: false; readonly error: RepairConfigError };

/**
 * `<runner-root>/config.json`: one non-empty `clone`, and
 * `repair.max_rounds_per_pin` defaulting to Python's 2. A present but
 * non-numeric or negative ceiling is refused rather than guessed.
 */
export function parseRepairConfig(text: string): RepairConfigResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'config-unreadable' };
  }
  if (!plainObject(value)) return { ok: false, error: 'config-unreadable' };
  const clone = value['clone'];
  if (typeof clone !== 'string' || clone.trim() === '') {
    return { ok: false, error: 'clone-missing' };
  }
  const repair = value['repair'];
  if (repair !== undefined && !plainObject(repair)) {
    return { ok: false, error: 'config-invalid' };
  }
  const ceiling = repair === undefined ? undefined : repair['max_rounds_per_pin'];
  if (ceiling === undefined) {
    return { ok: true, value: { clone, maxRoundsPerPin: DEFAULT_MAX_ROUNDS_PER_PIN } };
  }
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0) {
    return { ok: false, error: 'config-invalid' };
  }
  return { ok: true, value: { clone, maxRoundsPerPin: ceiling } };
}

export type RolloutResult =
  | { readonly ok: true; readonly durableArtifactRoot: string }
  | { readonly ok: false };

/**
 * The only field this slice consumes from `<state-root>/backfill-rollout.json`:
 * `durable_artifact_root`, needed lazily for a canonical handoff. Absent or
 * malformed configuration fails closed; the full backfill prerequisite set is
 * not re-implemented here.
 */
export function parseBackfillRollout(text: string): RolloutResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!plainObject(value)) return { ok: false };
  const root = value['durable_artifact_root'];
  if (typeof root !== 'string' || root.trim() === '') return { ok: false };
  return { ok: true, durableArtifactRoot: root };
}

export interface RepairPrepareInvocation {
  readonly jobId: string;
  readonly sourceSha: string;
  readonly revalidationPath: string;
  readonly instructionsPath?: string;
  readonly runnerRoot: string;
  readonly stateRoot: string;
}

export type RepairPrepareArgv =
  | { readonly ok: true; readonly value: RepairPrepareInvocation }
  | { readonly ok: false; readonly message: string };

const ARGV_FLAGS = {
  '--source-sha': 'sourceSha',
  '--revalidation': 'revalidationPath',
  '--instructions-file': 'instructionsPath',
  '--runner-root': 'runnerRoot',
  '--state-root': 'stateRoot',
} as const;

type ArgvFlag = keyof typeof ARGV_FLAGS;

function isArgvFlag(value: string): value is ArgvFlag {
  return Object.hasOwn(ARGV_FLAGS, value);
}

/**
 * Strict operator argv: `<job> --source-sha <sha> --revalidation <path>
 * --runner-root <dir> --state-root <dir> [--instructions-file <path>]`.
 * Unknown flags, duplicate flags, missing values and extra positionals are
 * usage errors (exit 2). The job-id grammar and the SHA grammar are checked
 * separately at their own boundaries.
 */
export function parseRepairPrepareArgv(argv: readonly string[]): RepairPrepareArgv {
  const jobId = argv[0];
  if (jobId === undefined || isArgvFlag(jobId)) {
    return { ok: false, message: 'missing historical job id' };
  }
  const values: Partial<Record<ArgvFlag, string>> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === undefined || !isArgvFlag(flag)) {
      return { ok: false, message: `unknown flag: ${flag ?? ''}` };
    }
    if (values[flag] !== undefined) {
      return { ok: false, message: `duplicate flag: ${flag}` };
    }
    const value = argv[index + 1];
    if (value === undefined) return { ok: false, message: `missing value for ${flag}` };
    values[flag] = value;
  }
  for (const required of ['--source-sha', '--revalidation', '--runner-root', '--state-root']) {
    if (values[required as ArgvFlag] === undefined) {
      return { ok: false, message: `missing required flag: ${required}` };
    }
  }
  const sourceSha = values['--source-sha'] as string;
  const revalidationPath = values['--revalidation'] as string;
  const runnerRoot = values['--runner-root'] as string;
  const stateRoot = values['--state-root'] as string;
  const instructionsPath = values['--instructions-file'];
  return {
    ok: true,
    value: {
      jobId,
      sourceSha,
      revalidationPath,
      ...(instructionsPath === undefined ? {} : { instructionsPath }),
      runnerRoot,
      stateRoot,
    },
  };
}

// -------------------------------------------------------------- pure artifact

/** How the injected `tick.lock` failed, when it failed before entering. */
export type RepairPrepareLockFailure = 'busy' | 'unsupported' | 'error';

/**
 * Map the executor's frozen result to the runner's one JSON artifact and an
 * exit code. No new status is introduced: `indeterminate` is the existing op
 * status for an unconfirmed effect, and a busy lock is the one Python-parity
 * exit-3 case.
 */
export function repairPreparationArtifact(
  result: RepairPreparationExecutionResult,
  lockFailure: RepairPrepareLockFailure | undefined,
): RunnerResult {
  if (result.ok) {
    return {
      artifact: {
        status: 'ok',
        value: {
          jobId: result.value.jobId,
          effects: result.value.effects,
          ...(result.value.handoff === undefined ? {} : { handoff: result.value.handoff }),
          remainingGates: result.value.remainingGates,
        },
        ...(result.lockExit === undefined ? {} : { lockExit: result.lockExit }),
      },
      exitCode: 0,
    };
  }
  switch (result.kind) {
    case 'refused':
      return {
        artifact: {
          status: 'failed',
          error: 'refused',
          refusal: result.refusal,
          ...(result.lockExit === undefined ? {} : { lockExit: result.lockExit }),
        },
        exitCode: 1,
      };
    case 'plan-inconsistent':
      return {
        artifact: {
          status: 'failed',
          error: 'plan-inconsistent',
          detail: result.detail,
          ...(result.lockExit === undefined ? {} : { lockExit: result.lockExit }),
        },
        exitCode: 1,
      };
    case 'plan-failed':
      return {
        artifact: {
          status: 'failed',
          error: 'plan-failed',
          diagnostic: result.diagnostic,
          ...(result.lockExit === undefined ? {} : { lockExit: result.lockExit }),
        },
        exitCode: 1,
      };
    case 'effect-failed': {
      const unconfirmed = result.steps.some((step) => step.outcome === 'unconfirmed');
      const evidence = {
        step: result.step,
        steps: result.steps,
        effects: result.effects,
        ...(result.refusal === undefined ? {} : { refusal: result.refusal }),
        ...(result.lockExit === undefined ? {} : { lockExit: result.lockExit }),
      };
      return unconfirmed
        ? {
            artifact: { status: 'indeterminate', detail: 'effect-failed', ...evidence },
            exitCode: 1,
          }
        : { artifact: { status: 'failed', error: 'effect-failed', ...evidence }, exitCode: 1 };
    }
    case 'lock-unavailable': {
      const artifact: RunnerArtifact =
        lockFailure === 'busy'
          ? { status: 'failed', error: 'tick lock busy' }
          : {
              status: 'failed',
              error: lockFailure === 'unsupported' ? 'lock-unsupported' : 'lock-unavailable',
            };
      return { artifact, exitCode: lockFailure === 'busy' ? 3 : 1 };
    }
  }
}

// ------------------------------------------------------------- real bindings

function decodeStrict(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function runGit(clone: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', clone, ...args],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          // No git prose, path or stderr is echoed: the gates carry the typed
          // refusal, and the adapter must not leak repository details.
          reject(new Error('git read failed'));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * `RepairGateGit` over the configured clone: `rev-parse origin/main`,
 * `rev-parse <sha>:<path>` and `show <sha>:<path>`. `show` output is decoded
 * strictly and newline-translated, matching Python's `text=True` subprocess.
 */
function makeRepairGateGit(clone: string): RepairGateGit {
  return {
    async currentTip(): Promise<string> {
      return decodeStrict(await runGit(clone, ['rev-parse', 'origin/main'])).trim();
    },
    async blobOid(sourceSha: string, path: string): Promise<string> {
      return decodeStrict(await runGit(clone, ['rev-parse', `${sourceSha}:${path}`])).trim();
    },
    async showFile(sourceSha: string, path: string): Promise<string> {
      return pythonUniversalNewlines(
        decodeStrict(await runGit(clone, ['show', `${sourceSha}:${path}`])),
      );
    },
  };
}

/** `shutil.which('gitleaks')`: an executable regular file on the given `PATH`. */
function gitleaksOnPath(path: string | undefined): boolean {
  if (path === undefined) return false;
  for (const directory of path.split(':')) {
    if (directory === '') continue;
    const candidate = join(directory, 'gitleaks');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Bind the scanner lazily: the denylist rules are read from
 * `origin/main:policy/denylist/patterns.yml` inside the tick-lock scope, as
 * Python's `crq` reads them at run time. A failed load becomes the gates'
 * `secret-scan-unavailable`, never a clean verdict.
 */
function makeLazyRepairScan(clone: string, gitleaksPath: string | undefined): RepairScan {
  let loaded: Promise<RepairScan> | undefined;
  const load = async (): Promise<RepairScan> => {
    const patternsText = decodeStrict(
      await runGit(clone, ['show', 'origin/main:policy/denylist/patterns.yml']),
    );
    const patterns = parseDenylistPatterns(
      patternsText,
      'origin/main:policy/denylist/patterns.yml',
    );
    return makeRepairScan({
      rules: patterns.rules,
      gitleaksEffects: makeSubprocessDevEffects(clone),
      gitleaksAvailable: () => gitleaksOnPath(gitleaksPath),
    });
  };
  return {
    async scanDiff(request) {
      loaded ??= load();
      return (await loaded).scanDiff(request);
    },
  };
}

/** `crq.iso()`: `YYYY-MM-DDTHH:MM:SSZ` in UTC. */
function repairPreparationClock(now: number = Date.now()): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Unit-test seams; production passes none and binds only from the roots. */
export interface RepairPreparationSeams {
  readonly git?: RepairGateGit;
  readonly scan?: RepairScan;
  readonly now?: () => string;
  readonly withTickLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The entry's `PATH` snapshot; the only environment input this adapter takes. */
  readonly gitleaksPath?: string | undefined;
}

interface RepairPreparationRoots {
  readonly runnerRoot: string;
  readonly stateRoot: string;
}

function usageArtifact(message: string): RunnerResult {
  return {
    artifact: { error: { kind: 'usage', subcommand: 'repair-prepare', message, exitCode: 2 } },
    exitCode: 2,
  };
}

function setupArtifact(error: string): RunnerResult {
  return { artifact: { status: 'failed', error }, exitCode: 1 };
}

function canonicalFindingId(oldJobJson: string): string | undefined {
  try {
    const value = parseJsonValue(oldJobJson);
    if (!(value instanceof JsonObject)) return undefined;
    const id = value.get('canonical_finding_id');
    return checkCanonicalFindingId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one operator preparation. Returns the runner's single JSON artifact and
 * the exit code; the caller only prints and exits.
 */
export async function runRepairPrepare(
  argv: readonly string[],
  seams: RepairPreparationSeams = {},
): Promise<RunnerResult> {
  const parsed = parseRepairPrepareArgv(argv);
  if (!parsed.ok) return usageArtifact(parsed.message);
  const invocation = parsed.value;
  if (!checkRepairJobId(invocation.jobId)) return setupArtifact('job-id-invalid');

  const roots: RepairPreparationRoots = {
    runnerRoot: invocation.runnerRoot,
    stateRoot: invocation.stateRoot,
  };

  let config: RepairConfigResult;
  try {
    config = parseRepairConfig(await readTextStrict(join(roots.runnerRoot, 'config.json')));
  } catch {
    config = { ok: false, error: 'config-unreadable' };
  }
  if (!config.ok) return setupArtifact(config.error);

  let evidence: JsonObject;
  try {
    const value = parseJsonValue(await readTextStrict(invocation.revalidationPath));
    if (!(value instanceof JsonObject)) return setupArtifact('evidence-unreadable');
    evidence = value;
  } catch {
    return setupArtifact('evidence-unreadable');
  }
  if (invocation.instructionsPath !== undefined) {
    let instructions: string;
    try {
      instructions = await readTextStrict(invocation.instructionsPath);
    } catch {
      return setupArtifact('instructions-unreadable');
    }
    evidence = withFixInstructions(evidence, instructions);
  }
  const evidenceJson = atomicJsonText(evidence);

  const git = seams.git ?? makeRepairGateGit(config.value.clone);
  const scan = seams.scan ?? makeLazyRepairScan(config.value.clone, seams.gitleaksPath);
  const now = seams.now ?? (() => repairPreparationClock());

  let lockFailure: RepairPrepareLockFailure | undefined;
  const classifyLockFailure = (error: unknown): void => {
    lockFailure =
      error instanceof SlotBusyError
        ? 'busy'
        : error instanceof UnsupportedLockError
          ? 'unsupported'
          : 'error';
  };

  const state: RepairPreparationState = {
    async readInboxJob(jobId: string): Promise<string | undefined> {
      if (!checkRepairJobId(jobId)) throw new Error('invalid inbox job id');
      return readOptionalStateFile(join(roots.stateRoot, 'repair', 'inbox', `${jobId}.json`));
    },
    async readTriageRow(findingId: string): Promise<string | undefined> {
      if (!checkCanonicalFindingId(findingId)) return undefined;
      return readOptionalStateFile(
        join(roots.stateRoot, 'backfill', 'findings', 'triage', `${findingId}.json`),
      );
    },
    async readPreparedJob(jobId: string): Promise<string | undefined> {
      if (!checkRepairJobId(jobId)) return undefined;
      return readOptionalStateFile(join(roots.stateRoot, 'repair', 'inbox', `${jobId}.json`));
    },
  };

  let store: Promise<{ inbox: FindingInbox; publication: FindingPublication }> | undefined;
  const findingStore = (): Promise<{ inbox: FindingInbox; publication: FindingPublication }> => {
    store ??= (async () => {
      const rollout = parseBackfillRollout(
        await readTextStrict(join(roots.stateRoot, 'backfill-rollout.json')),
      );
      if (!rollout.ok) throw new Error('canonical handoff configuration unavailable');
      const files: FindingStore = fileFindingStore({
        stateRoot: roots.stateRoot,
        durableArtifactRoot: rollout.durableArtifactRoot,
      });
      return { inbox: new FindingInbox(files.files), publication: files.publication };
    })();
    return store;
  };

  const publication: FindingPublication = {
    retained: async () => (await findingStore()).publication.retained(),
    spool: async (value) => (await findingStore()).publication.spool(value),
  };

  const produce = async (): Promise<PrepareRepairGatesResult> => {
    let oldJobJson: string | undefined;
    try {
      oldJobJson = await state.readInboxJob(invocation.jobId);
    } catch {
      return { ok: false, refusal: 'old-job-unreadable' };
    }
    if (oldJobJson === undefined) return { ok: false, refusal: 'old-job-unreadable' };
    let queueJson: string;
    try {
      queueJson = await readTextStrict(join(roots.stateRoot, 'queue.json'));
    } catch {
      return { ok: false, refusal: 'queue-item-unreadable' };
    }
    // The finding store is bound only when a canonical handoff is possible.
    if (canonicalFindingId(oldJobJson) !== undefined) {
      try {
        await findingStore();
      } catch {
        return { ok: false, refusal: 'canonical-handoff-unavailable' };
      }
    }
    return prepareRepairGates(
      {
        oldJobJson,
        oldJobId: invocation.jobId,
        queueJson,
        sourceSha: invocation.sourceSha,
        evidenceJson,
        maxRoundsPerPin: config.value.maxRoundsPerPin,
      },
      { git, state, scan },
    );
  };

  const effects: RepairPreparationEffects = {
    withTickLock: async <T>(fn: () => Promise<T>): Promise<T> => {
      const locked =
        seams.withTickLock ??
        (<U>(callback: () => Promise<U>): Promise<U> =>
          withLock(join(roots.stateRoot, 'tick.lock'), { wait: false }, callback));
      try {
        return await locked(fn);
      } catch (error) {
        classifyLockFailure(error);
        throw error;
      }
    },
    async persistJob(jobId: string, bytes: string): Promise<void> {
      if (!checkRepairJobId(jobId)) throw new Error('invalid prepared job id');
      const directory = join(roots.stateRoot, 'repair', 'inbox');
      await mkdir(directory, { recursive: true });
      await atomicWrite(join(directory, `${jobId}.json`), bytes);
    },
    async persistQueue(bytes: string): Promise<void> {
      await mkdir(roots.stateRoot, { recursive: true });
      await atomicWrite(join(roots.stateRoot, 'queue.json'), bytes);
    },
    inbox: {
      handoff: async (target, request) => (await findingStore()).inbox.handoff(target, request),
    },
    publication,
    now,
  };

  try {
    const result = await executeRepairPreparation(produce, effects);
    return repairPreparationArtifact(result, lockFailure);
  } catch {
    return { artifact: { status: 'failed', error: 'internal-error' }, exitCode: 1 };
  }
}
