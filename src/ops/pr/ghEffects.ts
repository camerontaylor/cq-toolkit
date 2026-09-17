// PR lane (goal D3) — the REAL `gh` subprocess effects adapter: the
// registry importer's binding of {@link PrEffects} for dispatched runs.
// Construction is INERT (closure-only — the execFile spawns only when an
// effect is called), so resolving a registry entry never touches the
// network; the ops' own seam docs govern the effects' meaning.
//
// Transport conventions (the sweep family's subprocess idiom, kept
// consistent):
//   - execFile with an ARGS ARRAY — never a shell string, so no input value
//     can be re-parsed as shell syntax (the repo's tooling convention).
//   - `GH_PROMPT_DISABLED=1` on every invocation: gh's interactive prompts
//     become hard failures instead of hangs (the op maps the fault; the
//     runner never stalls waiting for a TTY).
//   - One wall clock per invocation: a call exceeding `timeoutMs` is
//     SIGKILLed and reported as a fault — never awaited forever.
//   - mapGhFault mirrors mapWorktreeGitFault's branch order: maxBuffer
//     overflow first (a size limit is not a timeout), then the SIGKILL
//     timeout, then exit-code + captured stderr.
//   - PR bodies and comments travel over STDIN (`--body-file -`), so no
//     markdown body is ever argv.
//
// Parsing is kept small and exported pure ({@link parsePrList},
// {@link parseCreatedPr}, {@link checksOfRollup},
// {@link reviewStateOfDecision}) — fixture-tested in
// test/ops/pr/registry.test.ts against captured gh JSON shapes.
import { execFile } from 'node:child_process';
import type { PrChecks, PrEffects, PrReviewState } from './assemblePrs.js';

/** Generous capture ceiling — a big pr list must not truncate into a fault. */
const GH_OUTPUT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * The default wall-clock cap for one gh subprocess (the checkRunner's
 * 600_000ms registry default). gh is network-bound; a hung call must
 * surface as a REJECTION naming the timeout — never an eternal await.
 */
const DEFAULT_GH_TIMEOUT_MS = 600_000;

/** Per-call timeout options of {@link makeSubprocessPrEffects}; absent fields fall back to the shipped default. */
export interface SubprocessPrEffectsOptions {
  timeoutMs?: number;
}

/**
 * Map an execFile failure onto the gh adapter's fault taxonomy (the
 * worktreeFor adapter's branch order, renamed for gh's argv shape).
 * Exported for the fault-mapping pins; runGh is the only production call
 * site.
 */
export function mapGhFault(
  args: string[],
  error: { message: string; killed?: boolean | null; code?: unknown },
  stderr: string,
  timeoutMs: number,
): Error {
  const name = `gh ${[args[0], args[1]].filter((part) => part !== undefined).join(' ')}`;
  if (error.message.includes('maxBuffer')) {
    return new Error(
      `${name} exceeded the output limit (maxBuffer ${String(GH_OUTPUT_MAX_BUFFER_BYTES)} bytes) — the listing is too large to map`,
      { cause: error },
    );
  }
  if (error.killed === true) {
    return new Error(
      `${name} timed out after ${String(timeoutMs)}ms and was SIGKILLed — the gh call never produced evidence`,
      { cause: error },
    );
  }
  const exit = typeof error.code === 'number' ? ` (exit ${String(error.code)})` : '';
  return new Error(
    `${name}${exit} failed — ${stderr.trim() !== '' ? stderr.trim() : error.message}`,
    { cause: error },
  );
}

/**
 * Run gh with an execFile ARGS ARRAY. A non-zero exit, a spawn failure, or
 * a run exceeding `timeoutMs` (SIGKILL) rejects with the mapped fault.
 * `stdin` (a PR body or comment) is written to the child and the pipe
 * closed; an EPIPE from a child that exited before draining stdin is
 * swallowed — the execFile callback already carries the exit failure.
 */
function runGh(args: string[], cwd: string, timeoutMs: number, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      {
        cwd,
        maxBuffer: GH_OUTPUT_MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(mapGhFault(args, error, stderr, timeoutMs));
          return;
        }
        resolve(stdout);
      },
    );
    if (stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    }
  });
}

/** Parse gh's stdout as JSON; a non-parsing payload is a fault, never a guess. */
function parseGhJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what} printed non-JSON output — payload untrustworthy`);
  }
}

// ---------------------------------------------------------------------------
// Exported pure parsers — fixture-tested against captured gh JSON shapes
// ---------------------------------------------------------------------------

/**
 * Parse `gh pr list --head <head> --state all --json number,url`: a JSON
 * ARRAY of `{number, url?}` rows. A row without a numeric `number` makes
 * the whole payload untrustworthy (thrown, not skipped); a missing or
 * non-string `url` is simply absent from the result.
 */
export function parsePrList(text: string): Array<{ number: number; url?: string }> {
  const payload = parseGhJson<unknown>(text, 'gh pr list');
  if (!Array.isArray(payload)) {
    throw new Error('gh pr list returned a non-array payload — payload untrustworthy');
  }
  return payload.map((row) => {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof (row as { number?: unknown }).number !== 'number'
    ) {
      throw new Error('gh pr list returned a row without a numeric number — payload untrustworthy');
    }
    const numbered = row as { number: number; url?: unknown };
    const url = typeof numbered.url === 'string' && numbered.url !== '' ? numbered.url : undefined;
    return url === undefined ? { number: numbered.number } : { number: numbered.number, url };
  });
}

/**
 * Parse `gh pr create`'s stdout: gh prints the new PR's URL, and the PR
 * number is its `pull/<n>` tail. Anything else (a message without a URL —
 * which also covers gh's "already exists" refusal, which exits nonzero and
 * faults before this parse) is a fault, never a fabricated number.
 */
export function parseCreatedPr(text: string): { number: number; url: string } {
  const match = /https:\/\/[^\s]+\/pull\/(\d+)/.exec(text);
  if (match === null || match[1] === undefined) {
    throw new Error(
      'gh pr create printed no PR URL — could not read the new PR number from its output',
    );
  }
  return { number: Number.parseInt(match[1], 10), url: match[0] };
}

/** PASS-class conclusions: done green, or conclusively not required. */
const PASS_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
/** FAIL-class conclusions: the run concluded against the PR. */
const FAIL_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
/** FAIL-class StatusContext states. */
const FAIL_STATES = new Set(['FAILURE', 'ERROR']);

/** One rollup entry → pass/fail/pending. An UNRECOGNIZED shape is pending: never a fabricated pass, never a fabricated fail. */
function checkEntryVerdict(entry: unknown): 'pass' | 'fail' | 'pending' {
  if (entry === null || typeof entry !== 'object') return 'pending';
  const record = entry as Record<string, unknown>;
  // CheckRun shape: status/conclusion (conclusion null while queued/running).
  if (typeof record.conclusion === 'string') {
    if (PASS_CONCLUSIONS.has(record.conclusion)) return 'pass';
    if (FAIL_CONCLUSIONS.has(record.conclusion)) return 'fail';
    return 'pending';
  }
  // StatusContext shape: a single state.
  if (typeof record.state === 'string') {
    if (record.state === 'SUCCESS') return 'pass';
    if (FAIL_STATES.has(record.state)) return 'fail';
    return 'pending';
  }
  return 'pending';
}

/** The display name of one rollup entry (CheckRun `name` or StatusContext `context`). */
function checkNameOf(entry: unknown): string {
  if (entry !== null && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    if (typeof record.name === 'string' && record.name !== '') return record.name;
    if (typeof record.context === 'string' && record.context !== '') return record.context;
  }
  return 'unrecognized check entry';
}

/**
 * Fold `statusCheckRollup` into the seam's {@link PrChecks}: empty/absent
 * rollup → `none`; any FAIL-class entry → `fail` naming every failed
 * check; any still-pending entry → `pending`; all-green → `pass`.
 */
export function checksOfRollup(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return { state: 'none' };
  const failing: string[] = [];
  let pending = false;
  for (const entry of rollup) {
    const verdict = checkEntryVerdict(entry);
    if (verdict === 'fail') failing.push(checkNameOf(entry));
    else if (verdict === 'pending') pending = true;
  }
  if (failing.length > 0) return { state: 'fail', failing };
  if (pending) return { state: 'pending' };
  return { state: 'pass' };
}

/**
 * Map gh's `reviewDecision` onto the seam's {@link PrReviewState}:
 * APPROVED → approved; CHANGES_REQUESTED → changes-requested;
 * REVIEW_REQUIRED and explicit null → none; ANYTHING else (an unrecognized
 * word, a missing key) → unknown — never a fabricated verdict.
 */
export function reviewStateOfDecision(decision: unknown): PrReviewState {
  if (decision === 'APPROVED') return { state: 'approved' };
  if (decision === 'CHANGES_REQUESTED') return { state: 'changes-requested' };
  if (decision === 'REVIEW_REQUIRED' || decision === null) return { state: 'none' };
  return { state: 'unknown' };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The shipped effects adapter (the registry importer's binding): one bound
 * `repoRoot`, every effect a fresh lazy gh call. Argv shapes:
 *   - searchPrByHead:    gh pr list --head <head> --state all --json number,url
 *   - createPr:          gh pr create --head … --base … --title … [--body-file -] [--draft]
 *                        (the body, when present, travels over stdin)
 *   - editPrBody:        gh pr edit <n> --body-file -   (body over stdin)
 *   - comment:           gh pr comment <n> --body-file - (body over stdin)
 *   - getPrChecks:       gh pr view <n> --json statusCheckRollup
 *   - getPrReviewState:  gh pr view <n> --json reviewDecision
 * The seam carries NO merge effect — the fleet run report is a
 * merge-readiness artifact; merging stays the merge family's guarded
 * business.
 */
export function makeSubprocessPrEffects(
  repoRoot: string,
  timeouts?: SubprocessPrEffectsOptions,
): PrEffects {
  const timeoutMs = timeouts?.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  return {
    searchPrByHead: async (head) => {
      const matches = parsePrList(
        await runGh(
          ['pr', 'list', '--head', head, '--state', 'all', '--json', 'number,url'],
          repoRoot,
          timeoutMs,
        ),
      );
      const first = matches[0];
      if (first === undefined) return null;
      return first;
    },
    createPr: async (request) => {
      const args = [
        'pr',
        'create',
        '--head',
        request.head,
        '--base',
        request.base,
        '--title',
        request.title,
      ];
      // The body travels over STDIN (`--body-file -`), never argv — the
      // same transport discipline as editPrBody/comment, so no markdown
      // body is ever a process argument.
      let body: string | undefined;
      if (request.body !== undefined) {
        args.push('--body-file', '-');
        body = request.body;
      }
      if (request.draft) args.push('--draft');
      return parseCreatedPr(await runGh(args, repoRoot, timeoutMs, body));
    },
    editPrBody: async (number, body) => {
      await runGh(['pr', 'edit', String(number), '--body-file', '-'], repoRoot, timeoutMs, body);
    },
    comment: async (number, body) => {
      await runGh(['pr', 'comment', String(number), '--body-file', '-'], repoRoot, timeoutMs, body);
    },
    getPrChecks: async (number) =>
      checksOfRollup(
        parseGhJson<{ statusCheckRollup?: unknown }>(
          await runGh(
            ['pr', 'view', String(number), '--json', 'statusCheckRollup'],
            repoRoot,
            timeoutMs,
          ),
          'gh pr view',
        ).statusCheckRollup,
      ),
    getPrReviewState: async (number) =>
      reviewStateOfDecision(
        parseGhJson<{ reviewDecision?: unknown }>(
          await runGh(
            ['pr', 'view', String(number), '--json', 'reviewDecision'],
            repoRoot,
            timeoutMs,
          ),
          'gh pr view',
        ).reviewDecision,
      ),
  };
}
