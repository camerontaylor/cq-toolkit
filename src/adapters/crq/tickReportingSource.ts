/**
 * The reporting section of a tick, bound to the filesystem and `gh`: `write_status(q)`,
 * `local_review_pr.publish(q)` and `client_health.record(q, ...)`, plus the `DeliveryEnv`
 * ports (`gh`, artifact reads, the push-findings repo lookup and issue filer).
 *
 * Every effect is an existing port: the status route is `writeStatusForDocuments` over the
 * in-memory queue, the outbox and health record are `ops/crq` ports with injected effects,
 * and the delivery gh is a `spawnSync` runner with Python's `subprocess.run(..., timeout=)`
 * failure shapes. Nothing here enables a unit: the caller injects the result through
 * `ComposeInput.remaining` / `ComposeInput.delivery`.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { currentEntryEnv } from '../../config/run-env.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import {
  FindingIssueRuntimeError,
  GhSpawnError as FindingGhSpawnError,
  GhTimeoutError as FindingGhTimeoutError,
  fileFindingIssue,
  findingIssuesEnabled,
  GH_TIMEOUT as FINDING_GH_TIMEOUT,
  type GhPort as FindingGhPort,
} from '../../policy/crq/findingIssues.js';
import {
  GhSpawnError,
  GhTimeoutError,
  type GhPort,
  type GhResult,
} from '../../policy/crq/prReviewFindings.js';
import { ReceiptOsError, type ReceiptFiles } from '../../policy/crq/receiptPrepare.js';
import { readContentAddressedReceipt } from './reviewEffects.js';
import { adequate, ValueError } from '../../policy/crq/reviewAdmission.js';
import { authenticatedGh } from '../../policy/crq/reviewIdentity.js';
import { DeliveryRuntimeError } from '../../ops/crq/internal/deliverPending.js';
import { recordClientHealth, type ClientHealthEffects } from '../../ops/crq/clientHealthRecord.js';
import { publishLocalReviewPr } from '../../ops/crq/localReviewPrOutbox.js';
import { retainedReceiptDocument } from '../../ops/crq/reviewCapability.js';
import { parseConfig, validateQueue, validateQueueExact } from '../../ops/crq/statusWriter.js';
import type { TickPhases } from '../../queue-runner/tickOrchestrator.js';
import { atomicWriteSync } from './atomic.js';
import type { ComposeInput } from './composeTick.js';
import { checkoutSha } from './checkoutSha.js';
import { nodeIdentityDeps } from './identityProcess.js';
import { isoUtc, queueBytes } from './queueEffects.js';
import {
  fileStatusWriterEffects,
  resolveComposerSeams,
  writeStatusForDocuments,
} from './statusWriter.js';
import { realRunCommand, type SummaryStateRoots } from './summarySource.js';
import type { StatusStateRoots } from './statusSource.js';

/** `pr_review_findings.GH_TIMEOUT` (and `local_review_pr`'s `findings._gh`). */
const DELIVERY_GH_TIMEOUT_SECONDS = 60;

const ERRNO: Readonly<Record<string, readonly [number, string]>> = {
  ENOENT: [2, 'No such file or directory'],
  EACCES: [13, 'Permission denied'],
  EPERM: [1, 'Operation not permitted'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
};

const pyRepr = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** `str(OSError)` for a Node fs error on `path`: `[Errno 2] No such file or directory: 'p'`. */
export function pythonOsErrorText(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  const known = code === undefined ? undefined : ERRNO[code];
  if (known !== undefined) return `[Errno ${known[0]}] ${known[1]}: ${pyRepr(path)}`;
  const errno = (error as NodeJS.ErrnoException).errno;
  const text = error instanceof Error ? error.message : String(error);
  return `[Errno ${errno === undefined ? 0 : Math.abs(errno)}] ${text}: ${pyRepr(path)}`;
}

/** `Path(p).read_text(errors="replace")`; a filesystem failure throws with its Node error. */
export function readTextReplacing(path: string): string {
  return new TextDecoder('utf-8').decode(readFileSync(path));
}

interface SpawnedGh {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `subprocess.run(argv, capture_output=True, text=True, input=..., timeout=...)` over
 * `spawnSync`. A timeout and a spawn failure return `timeout` / `spawn` with Python's
 * `str(exc)`, for the caller to wrap in its own port error class.
 */
function runProcess(
  argv: readonly string[],
  inputText: string | null,
  timeoutSeconds: number,
): SpawnedGh | { readonly timeout: string } | { readonly spawn: string } {
  const [command, ...args] = argv;
  if (command === undefined) return { spawn: '[Errno 2] No such file or directory' };
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: inputText ?? undefined,
    timeout: timeoutSeconds * 1000,
    killSignal: 'SIGKILL',
    env: currentEntryEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT')
      return {
        timeout: `Command [${argv.map(pyRepr).join(', ')}] timed out after ${timeoutSeconds} seconds`,
      };
    return { spawn: pythonOsErrorText(result.error, command) };
  }
  return { returncode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** `pr_review_findings._gh`: the delivery gh runner, 60-second timeout. */
export function deliveryGh(): GhPort {
  return (argv, { inputText }): GhResult => {
    const outcome = runProcess(argv, inputText, DELIVERY_GH_TIMEOUT_SECONDS);
    if ('timeout' in outcome) throw new GhTimeoutError(outcome.timeout);
    if ('spawn' in outcome) throw new GhSpawnError(outcome.spawn);
    return {
      returncode: JsonNumber.int(outcome.returncode),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  };
}

/** `finding_issues._gh`: the issue filer's gh runner, 10-second timeout. */
export function findingIssueGh(): FindingGhPort {
  return (argv, { inputText }) => {
    const outcome = runProcess(argv, inputText, FINDING_GH_TIMEOUT);
    if ('timeout' in outcome) throw new FindingGhTimeoutError(outcome.timeout);
    if ('spawn' in outcome) throw new FindingGhSpawnError(outcome.spawn);
    return outcome;
  };
}

/** The config's per-repo entry for `repo` (`repo_registry.by_repo(REPOS, repo)`), or null. */
function configuredRepo(config: JsonObject, repo: string): JsonObject | null {
  const entries = config.get('repos');
  if (!Array.isArray(entries) || repo === '') return null;
  const wanted = repo.toLowerCase();
  for (const entry of entries) {
    if (!(entry instanceof JsonObject)) continue;
    const slug = entry.get('repo');
    if (typeof slug === 'string' && slug.toLowerCase() === wanted) return entry;
  }
  return null;
}

export interface DeliveryRoots {
  readonly config: JsonObject;
  /** `crq.REPO`, the primary repository slug. */
  readonly primaryRepo: string;
}

/**
 * The `DeliveryEnv` ports a tick needs beyond the seams: the review gh, App authentication,
 * artifact reads and the push-findings effects. The primary repo is never in `config.repos`
 * (Python's `REPOS` excludes it), so its push findings are not debt (`repoMode` null).
 */
export function fileDeliveryEnv(input: DeliveryRoots): ComposeInput['delivery'] {
  const files: ReceiptFiles = {
    readBytes(path) {
      try {
        return new Uint8Array(readFileSync(path));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Only FileNotFoundError is "absent"; Python raises IsADirectoryError /
        // NotADirectoryError (OSError subclasses) for the other two, with their own text.
        if (code === 'ENOENT') return null;
        // Python's OSError: the delivery layer maps only ReceiptOsError, so a raw Node error
        // would abort the whole phase instead of recording the item's delivery error.
        throw new ReceiptOsError('OSError', pythonOsErrorText(error, path));
      }
    },
  };
  const findingGh = findingIssueGh();
  return {
    gh: deliveryGh(),
    authenticate: (repo) => authenticatedGh(nodeIdentityDeps(), repo),
    files,
    readText(path) {
      try {
        return readTextReplacing(path);
      } catch (error) {
        throw new ReceiptOsError('OSError', pythonOsErrorText(error, path));
      }
    },
    primaryRepo: input.primaryRepo,
    push: {
      repoMode: async (repo) => {
        const entry = configuredRepo(input.config, repo);
        if (entry === null) return null;
        return { enabled: findingIssuesEnabled(entry) };
      },
      readFindings: async (path) => {
        try {
          return readTextReplacing(path);
        } catch (error) {
          throw new DeliveryRuntimeError(pythonOsErrorText(error, path));
        }
      },
      fileIssue: async (call) => {
        const entry = configuredRepo(input.config, call.repo);
        // Only `repo` and `findings` are read from the parsed registry entry.
        const repoConfig = new JsonObject([
          ['repo', call.repo],
          ['findings', entry?.get('findings') ?? 'issue'],
        ]);
        try {
          const result = await fileFindingIssue({
            repoConfig,
            base: call.base,
            head: call.head,
            meta: call.meta,
            severityCounts: call.severityCounts,
            findingsMarkdown: call.findingsMd,
            gh: findingGh,
          });
          const number = result.issue_number;
          return new JsonObject([
            ['issue_url', result.issue_url],
            [
              'issue_number',
              number === null ? null : typeof number === 'number' ? JsonNumber.int(number) : number,
            ],
            ['created', result.created],
          ]);
        } catch (error) {
          if (error instanceof FindingIssueRuntimeError)
            throw new DeliveryRuntimeError(error.message);
          throw error;
        }
      },
    },
  };
}

export interface ReportingInput {
  readonly roots: StatusStateRoots & SummaryStateRoots;
  readonly config: JsonObject;
  /** `crq.REPO`. */
  readonly primaryRepo: string;
  /** `crq.CLONE`: the cwd of the advisory's gh calls. */
  readonly clone: string;
  /** `RUNNER_ROOT`: the checkout whose HEAD `client_health.sha` records. */
  readonly runnerRoot: string;
  /** The review-delivery gh (`DeliveryEnv.gh`), so the outbox shares one runner. */
  readonly gh: GhPort;
  /** The retained-receipt reader (bytes of one receipt; rejects when absent). */
  readonly readReceipt?: (receiptId: string) => Promise<Uint8Array>;
  readonly now?: () => number;
}

class ForgeProcessError extends Error {
  readonly pythonError: string;
  constructor(pythonError: string, message: string) {
    super(message);
    this.pythonError = pythonError;
  }
}

/** `spawnSync` needs an unsigned integer; the budget's remaining seconds are fractional. */
export function forgeTimeoutMs(seconds: number): number {
  return Math.max(1, Math.ceil(seconds * 1000));
}

/** `crq.gh_json(args, definite_failure)` in the advisory: gh in the clone, bounded, parsed. */
export function forgeJson(clone: string) {
  return async (
    args: string[],
    options: { timeoutSeconds: number; definiteFailure?: boolean },
  ): Promise<JsonValue> => {
    const argv = ['gh', ...args];
    const [command, ...rest] = argv;
    const result = spawnSync(command ?? 'gh', rest, {
      encoding: 'utf8',
      cwd: clone,
      timeout: forgeTimeoutMs(options.timeoutSeconds),
      killSignal: 'SIGKILL',
      env: currentEntryEnv(),
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ETIMEDOUT')
        throw new ForgeProcessError(
          'TimeoutExpired',
          `Command [${argv.map(pyRepr).join(', ')}] timed out after ${options.timeoutSeconds} seconds`,
        );
      throw new ForgeProcessError('FileNotFoundError', pythonOsErrorText(result.error, 'gh'));
    }
    if (result.status !== 0) {
      // `gh_json(..., definite_failure=True)` (the create) uses `check_returncode()`; every
      // other call goes through `run(check=True)`, which raises a bare RuntimeError.
      if (options.definiteFailure === true)
        throw new ForgeProcessError(
          'CalledProcessError',
          `Command [${argv.map(pyRepr).join(', ')}] returned non-zero exit status ${result.status ?? -1}.`,
        );
      throw new ForgeProcessError(
        'RuntimeError',
        `${argv.slice(0, 6).join(' ')} … exit ${result.status ?? -1}: ${(result.stderr ?? '').trim().slice(0, 400)}`,
      );
    }
    try {
      return parseJsonText(result.stdout);
    } catch {
      throw new ForgeProcessError('JSONDecodeError', 'Expecting value');
    }
  };
}

const parseJsonText = (text: string): JsonValue => parseJsonValue(text, { duplicates: 'last' });

/**
 * The default retained-receipt reader: `<stateRoot>/receipts/<id>.json`, bounded and checked
 * against its content address, the same reader `reviewEffects` binds.
 */
export function stateReceiptReader(stateRoot: string): (receiptId: string) => Promise<Uint8Array> {
  return (receiptId) => readContentAddressedReceipt(join(stateRoot, 'receipts'), receiptId);
}

/** The three reporting phases, for `ComposeInput.remaining`. */
export function fileReportingPhases(
  input: ReportingInput,
): Pick<TickPhases, 'writeStatus' | 'publishLocalReviewPr' | 'recordClientHealth'> {
  const now = input.now ?? Date.now;
  const queuePath = join(input.roots.stateRoot, 'queue.json');
  const saveQueue = (queue: JsonObject): void => atomicWriteSync(queuePath, queueBytes(queue));
  const iso = (): string => isoUtc(new Date(now()));
  const runs = join(input.roots.stateRoot, 'runs');
  const readReceipt = input.readReceipt ?? stateReceiptReader(input.roots.stateRoot);
  const threshold = input.config.get('discovery_incomplete_ticks');
  return {
    async writeStatus(queue) {
      // `write_status(q)` reads the in-memory queue, not queue.json: serve the same bytes the
      // tick would save so the status, summary and drainable-repair seams see one revision.
      const queueText = queueBytes(queue);
      const base = fileStatusWriterEffects(input.roots, realRunCommand, () => now() / 1000);
      const effects = { ...base, readQueue: async () => queueText };
      const documents = {
        queue: validateQueue(queueText),
        config: parseConfig(await effects.readConfig()),
        queueExact: validateQueueExact(queueText),
      };
      const seams = await resolveComposerSeams(input.roots.stateRoot, documents.queue);
      await writeStatusForDocuments({ ...effects, composerSeams: seams }, documents);
    },
    publishLocalReviewPr: (queue) =>
      publishLocalReviewPr(queue, {
        saveQueue,
        iso,
        epochSeconds: () => now() / 1000,
        retained: async (item) => {
          // `admission.adequate` raises ValueError for a malformed item; `retained` is None.
          try {
            if (!adequate(item)) return null;
          } catch (error) {
            if (error instanceof ValueError) return null;
            throw error;
          }
          return retainedReceiptDocument(item, readReceipt);
        },
        gh: input.gh,
        findingsPath: (runId) => join(runs, runId, 'review.ndjson'),
        readText: (path) => {
          try {
            return readTextReplacing(path);
          } catch (error) {
            // An OSError's `str(exc)` is what the outbox row records.
            throw new ReceiptOsError('OSError', pythonOsErrorText(error, path));
          }
        },
      }),
    recordClientHealth: (queue, discoveryEnabled) => {
      const effects: ClientHealthEffects = {
        saveQueue,
        iso,
        checkoutSha: () => checkoutSha(input.runnerRoot),
        repo: input.primaryRepo,
        incompleteTicksThreshold: threshold,
        forgeJson: forgeJson(input.clone),
      };
      return recordClientHealth(queue, discoveryEnabled, effects);
    },
  };
}
