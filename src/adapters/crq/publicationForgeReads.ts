/**
 * Offline forge READ bindings for the repair publication seam: the two `gh`
 * reads `repair_tick` makes about a repair's PR, `c.pr_info(pr)` and
 * `c.gh_json(['pr', 'list', '--repo', REPO, '--head', <branch>, '--state', 'all',
 * '--json', 'number,url,state,headRefOid'])`. Inactive and standalone: nothing
 * imports this from a runtime entry point, and it names no type from the
 * publication orchestration. {@link PublicationForgeReads} is a structural
 * subset of `PublicationPublishEffects`, `PublicationRecoveryEffects` and
 * `PublicationFinalizeEffects`; a test pins that.
 *
 * Bound here, both read-only `gh` calls in the primary clone:
 * - `prInfo`: `crq.pr_info(pr)`, `gh pr view <pr> --repo <REPO> --json
 *   number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt`.
 * - `listBranchPrs`: the `--head <branch> --state all` listing. No `--limit`, so
 *   `gh`'s own default page applies, exactly as in Python.
 *
 * Left explicit, none of it implemented here: `createPr` is a forge write,
 * `lsRemoteHeads` and `push` talk to the remote over Git, and nothing here wires
 * into `tick`, a runtime, or a deployment.
 *
 * Transport reuse. The seam is the existing `GhFn` (`forge-github/gh.ts`) and the
 * existing `ForgeBudget` (`policy/crq/forgeBudget.ts`). `crq.gh_json` takes its
 * subprocess timeout from the active forge window (`ForgeBudget.take()`, which
 * raises `RefreshExhausted` before any request when the allowance is gone) and
 * from a fixed 120 seconds otherwise; `options.budget` is that window and its
 * absence is the 120 seconds. The runner is made per request, because its time
 * bound is that request's.
 *
 * Failure classes, which the publication orchestration branches on:
 * - A non-zero `gh` exit is `RuntimeError('<first six argv words> … exit <n>:
 *   <stderr stripped, 400 code points>')`, with `text=True` universal newlines and
 *   Python's `str.strip()`.
 * - The time bound and a missing `gh` are NOT a miss: both are `OSError` here
 *   (Python's `TimeoutExpired` and `FileNotFoundError` are not `RuntimeError`). The
 *   runner reports them as exit 124 with its own marker and exit 127; `gh` itself
 *   exits with neither the marker nor 127.
 * - Output that is not JSON is `ValueError` (Python's `JSONDecodeError`); the
 *   message text is Node's parser's, not CPython's. `NaN` and `Infinity` parse, as
 *   in `json.loads`.
 * - `RefreshExhausted` is the budget's own error, unchanged.
 *
 * Malformed answers keep Python's laziness. `prInfo` returns the parsed object
 * with `state`, `headRefName` and `headRefOid` as properties that raise
 * `KeyError('<key>')` when `gh` did not print the key, at the read and not before, so
 * a closed PR that lacks `headRefName` is still `stale` and one that is open and
 * lacks it is a `KeyError`. A branch row lacks `headRefOid` the same way (a lone row
 * is the only one whose key is read), and a row that is not an object raises
 * `TypeError` there. A `prInfo` answer that is not an object is a `TypeError` with
 * CPython's subscript message at once: every Python consumer subscripts it first.
 *
 * Narrowings, all refusals where Python would run `gh` or read the answer anyway:
 * - The PR is a non-negative integer (`number`, `bigint`, a retained `JsonNumber`
 *   int) or its decimal digits. Python takes `str()` of anything, so `-5` or a
 *   string option would reach `gh` as an argument.
 * - `repo` is `owner/name` over `[A-Za-z0-9_.-]`; the branch passes
 *   `branchPathFault`.
 * - A `listBranchPrs` answer that is not a JSON array is a `TypeError`. Python reads
 *   `null`, `{}`, `0` and `''` as "no PR" (`if not prs`), which would send
 *   finalization on to `gh pr create` for a read that did not answer.
 *   `prInfo` answers `{}` or a falsy non-object the same way in `publish` (no open
 *   PR to guard); here `{}` raises `KeyError('state')` and a falsy non-object a
 *   `TypeError`, so a read that did not answer never reads as "no PR".
 * - Numbers read as ordinary JavaScript numbers (a safe integer) or `bigint`, so an
 *   integral float such as `5.0` reads as `5`. `gh pr view` and `gh pr list` never
 *   print a float for these fields.
 * - The runner decodes `gh` output as lossy UTF-8; Python's strict `text=True`
 *   decode would raise `UnicodeDecodeError` on invalid bytes, which cannot be seen
 *   through `GhFn`. `gh` prints valid UTF-8.
 * - A missing working directory reads as a missing `gh` (`[Errno 2] ... 'gh'`).
 */
import { pyRepr } from '../../ops/crq/deploy/rollbackRecover.js';
import { pyStrip } from '../../ops/crq/deploy/gitGuards.js';
import {
  parseJsonValue,
  pythonNonFinite,
  pythonNumberText,
  toPlainJson,
  JsonNumber,
} from '../../policy/crq/jsonValue.js';
import { MAX_TAKE_SECONDS, type ForgeBudget } from '../../policy/crq/forgeBudget.js';
import { branchPathFault } from '../../shared/refname.js';
import { PyError } from '../../queue-runner/pyErrors.js';
import { ghNameOk, makeGhRunner, type GhFn } from '../forge-github/gh.js';
import { clip } from './publicationGitReads.js';

/** `crq.pr_info`'s `--json` field list. */
export const PR_INFO_FIELDS =
  'number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt';
/** The branch listing's `--json` field list. */
export const BRANCH_PR_FIELDS = 'number,url,state,headRefOid';
/** `crq.gh_json`'s subprocess timeout outside a forge window, in seconds. */
export const DEFAULT_GH_TIMEOUT_SECONDS = 120;

/** The fields every Python consumer reads from `pr_info`; a missing one is a `KeyError` at the read. */
const INFO_KEYS = ['state', 'headRefName', 'headRefOid'] as const;

/** The `pr_info` answer: `gh pr view`'s object, whose consumed keys raise `KeyError` when absent. */
export interface ForgePrInfo {
  readonly state: unknown;
  readonly headRefName: unknown;
  readonly headRefOid: unknown;
  readonly [field: string]: unknown;
}

/** One `gh pr list --json number,url,state,headRefOid` row; `headRefOid` raises when absent. */
export interface ForgeBranchPr {
  readonly number: unknown;
  readonly url: unknown;
  readonly state: unknown;
  readonly headRefOid: unknown;
}

/** The publication forge read seams, bound to one repository and one clone. */
export interface PublicationForgeReads {
  /** `c.pr_info(pr)`. */
  prInfo(pr: unknown): Promise<ForgePrInfo>;
  /** `c.gh_json(['pr', 'list', '--repo', REPO, '--head', branch, '--state', 'all', '--json', ...])`. */
  listBranchPrs(branch: string): Promise<readonly ForgeBranchPr[]>;
}

/** What one `gh` request is made with: the runner is built per request, for its own time bound. */
export interface GhRequest {
  /** This request's time bound; the runner kills `gh` and reports exit 124 when it passes. */
  readonly timeoutMs: number;
  /** `c.CLONE`: `gh` runs there. */
  readonly cwd: string;
}

export interface PublicationForgeReadsOptions {
  /** `c.REPO`, `owner/name`. */
  readonly repo: string;
  /** `c.CLONE`: the primary clone, the working directory of every `gh` call. */
  readonly clone: string;
  /** `crq._FORGE_BUDGET`: the active forge window. Absent, every request has 120 seconds. */
  readonly budget?: ForgeBudget;
  /** The `gh` runner for one request; defaults to the shared `makeGhRunner`. */
  readonly ghFor?: (request: GhRequest) => GhFn;
}

const REPO_FORM = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGITS = /^[0-9]+$/;

/** `str(pr)` for the integral PR numbers a queue holds; anything else is refused, not stringified. */
function prArgument(pr: unknown): string {
  if (typeof pr === 'string' && DIGITS.test(pr)) return pr;
  if (typeof pr === 'bigint' && pr >= 0n) return pr.toString();
  if (typeof pr === 'number' && Number.isSafeInteger(pr) && pr >= 0) return String(pr);
  if (pr instanceof JsonNumber && pr.kind === 'int' && (pr.integer as bigint) >= 0n)
    return (pr.integer as bigint).toString();
  throw new PyError('ValueError', 'PR number must be a non-negative integer');
}

/** Seconds as CPython prints them in `TimeoutExpired`: the int 120 and the clamp's int 10, else a float. */
function secondsText(seconds: number): string {
  return seconds === DEFAULT_GH_TIMEOUT_SECONDS || seconds === MAX_TAKE_SECONDS
    ? String(seconds)
    : pythonNumberText(seconds);
}

/** Python `type(value).__name__` and the `TypeError` text a `value['key']` raises. */
function subscriptMessage(value: unknown): string {
  if (Array.isArray(value)) return 'list indices must be integers or slices, not str';
  if (typeof value === 'string') return "string indices must be integers, not 'str'";
  if (typeof value === 'boolean') return "'bool' object is not subscriptable";
  if (typeof value === 'number' && !Number.isInteger(value))
    return "'float' object is not subscriptable";
  if (value === null || value === undefined) return "'NoneType' object is not subscriptable";
  return "'int' object is not subscriptable";
}

/** A property that raises where Python's `d['key']` would: not enumerable, so it never serializes. */
function raising(target: object, key: string, error: () => PyError): void {
  Object.defineProperty(target, key, {
    enumerable: false,
    configurable: true,
    get() {
      throw error();
    },
  });
}

/** The plain parsed value: safe integers are numbers, larger ones `bigint`. */
function plain(text: string): unknown {
  return toPlainJson(parseJsonValue(text, { duplicates: 'last', parseConstant: pythonNonFinite }), {
    bigints: true,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The forge read bindings. Throws `Error` on a repository that is not `owner/name`. */
export function forgePublicationReads(
  options: PublicationForgeReadsOptions,
): PublicationForgeReads {
  const { repo, clone, budget } = options;
  if (!REPO_FORM.test(repo) || !repo.split('/').every(ghNameOk))
    throw new Error('invalid forge repository');
  const ghFor = options.ghFor ?? ((request: GhRequest) => makeGhRunner({ ...request }));

  /** `crq.gh_json`: one budgeted `gh` request, the exit checked, the output parsed. */
  async function ghJson(args: readonly string[]): Promise<unknown> {
    const seconds = budget === undefined ? DEFAULT_GH_TIMEOUT_SECONDS : budget.take();
    const timeoutMs = Math.max(1, Math.ceil(seconds * 1000));
    const argv = ['gh', ...args];
    const result = await ghFor({ timeoutMs, cwd: clone })([...args]);
    if (
      result.code === 124 &&
      result.stderr.endsWith(`gh timed out after ${String(timeoutMs)}ms`)
    ) {
      throw new PyError(
        'OSError',
        `Command '${pyRepr(argv)}' timed out after ${secondsText(seconds)} seconds`,
      );
    }
    if (result.code === 127)
      throw new PyError('OSError', "[Errno 2] No such file or directory: 'gh'");
    if (result.code !== 0) {
      const stderr = pyStrip(result.stderr.replace(/\r\n?/g, '\n'));
      throw new PyError(
        'RuntimeError',
        `${argv.slice(0, 6).join(' ')} … exit ${String(result.code)}: ${clip(stderr, 400)}`,
      );
    }
    try {
      return plain(result.stdout);
    } catch {
      throw new PyError('ValueError', 'Expecting value');
    }
  }

  return {
    async prInfo(pr) {
      const value = await ghJson([
        'pr',
        'view',
        prArgument(pr),
        '--repo',
        repo,
        '--json',
        PR_INFO_FIELDS,
      ]);
      if (!isObject(value)) throw new PyError('TypeError', subscriptMessage(value));
      const info: Record<string, unknown> = { ...value };
      for (const key of INFO_KEYS)
        if (!Object.hasOwn(value, key))
          raising(info, key, () => new PyError('KeyError', `'${key}'`));
      return info as ForgePrInfo;
    },

    async listBranchPrs(branch) {
      const fault = branchPathFault(branch);
      if (fault !== null) throw new PyError('ValueError', fault);
      const value = await ghJson([
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        BRANCH_PR_FIELDS,
      ]);
      if (!Array.isArray(value))
        throw new PyError('TypeError', `gh pr list printed no list: ${pyRepr(value).slice(0, 80)}`);
      return value.map((row: unknown): ForgeBranchPr => {
        if (!isObject(row)) {
          const opaque: Record<string, unknown> = {};
          raising(opaque, 'headRefOid', () => new PyError('TypeError', subscriptMessage(row)));
          return opaque as unknown as ForgeBranchPr;
        }
        const copy: Record<string, unknown> = { ...row };
        if (!Object.hasOwn(row, 'headRefOid'))
          raising(copy, 'headRefOid', () => new PyError('KeyError', "'headRefOid'"));
        return copy as unknown as ForgeBranchPr;
      });
    },
  };
}
