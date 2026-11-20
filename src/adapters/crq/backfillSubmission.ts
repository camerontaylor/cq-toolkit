/**
 * The backfill submission proof the detached `_review` child writes before it
 * runs the reviewer (`crq.cmd_review_child`): the CLI version and its known
 * output format, the pinned head/base/attempt identity and the head-side
 * hunks actually submitted. Completion later re-derives the same scope from
 * git and refuses any drift, so a proof is only issued for a clean worktree
 * sitting exactly on the pinned head.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { submittedScope, type BackfillRepo } from '../../policy/crq/backfillCompletion.js';
import { REVIEWER_FORMATS } from '../../policy/crq/backfillVendorOutput.js';
import { toPlainJson } from '../../policy/crq/jsonValue.js';
import { GitAccountingRepository } from './backfillAccounting.js';
import type { RunGit } from './ledgerGit.js';
import { runGitIn } from './publishSource.js';

const exec = promisify(execFile);

/** A refusal Python raised as ValueError/RuntimeError/OSError/SubprocessError. */
export class BackfillSubmissionRefused extends Error {
  override readonly name = 'BackfillSubmissionRefused';
}

export interface BackfillSubmissionInput {
  readonly runId: string;
  readonly worktree: string;
  readonly cmd: readonly string[];
  readonly head: string;
  readonly base: string;
  readonly attemptId: string;
  readonly env: NodeJS.ProcessEnv;
  /** Test seam; the default runs hardened git in the worktree. */
  readonly runGit?: RunGit;
  /** Test seam; the default executes `<cmd[0]> --version`. */
  readonly version?: () => Promise<string>;
}

async function cliVersion(input: BackfillSubmissionInput): Promise<string> {
  const executable = input.cmd[0];
  if (executable === undefined) throw new BackfillSubmissionRefused('backfill command is empty');
  try {
    const { stdout } = await exec(executable, ['--version'], {
      timeout: 30_000,
      env: input.env,
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (error) {
    throw new BackfillSubmissionRefused(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/** `check=True` git read; a non-zero exit refuses like `CalledProcessError`. */
async function gitText(runGit: RunGit, args: readonly string[]): Promise<string> {
  const call = await runGit(args);
  if (call.code !== 0)
    throw new BackfillSubmissionRefused(`git ${args.join(' ')} exited ${String(call.code)}`);
  return new TextDecoder().decode(call.stdout);
}

/** Build the proof document, or throw {@link BackfillSubmissionRefused}. */
export async function backfillSubmissionProof(
  input: BackfillSubmissionInput,
): Promise<Record<string, unknown>> {
  const version = await (input.version ?? (() => cliVersion(input)))();
  const format = REVIEWER_FORMATS.get(version);
  if (format === undefined)
    throw new BackfillSubmissionRefused(
      'backfill scope adapter refuses unknown CodeRabbit version',
    );
  const runGit = input.runGit ?? runGitIn(input.worktree);
  const head = (await gitText(runGit, ['rev-parse', 'HEAD^{commit}'])).trim();
  const status = (await gitText(runGit, ['status', '--porcelain'])).trim();
  if (head !== input.head || status !== '')
    throw new BackfillSubmissionRefused('backfill submission must match clean pinned head');
  const accounting = new GitAccountingRepository({ repo: input.worktree, runGit });
  // `submittedScope` is synchronous; the two facts it reads are fetched first.
  const entries = await accounting.entries(input.head);
  const intervals = await accounting.changedIntervals(input.base, input.head);
  const repo: Pick<BackfillRepo, 'entries' | 'changedIntervals'> = {
    entries: () => entries,
    changedIntervals: () => intervals,
  };
  const scope = submittedScope(repo as BackfillRepo, input.base, input.head);
  return {
    cli_version: version,
    format,
    run_id: input.runId,
    head: input.head,
    base: input.base,
    attempt_id: input.attemptId,
    submitted_scope: scope.map((row) => toPlainJson(row)),
  };
}
