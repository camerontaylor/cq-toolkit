import type { BackfillRepo, BackfillStore } from '../../policy/crq/backfillCompletion.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { LedgerIntegrityError } from '../../policy/crq/ledger.js';
import { AccountingGitError } from './backfillAccounting.js';
import type { ArtifactStore } from './findingStore.js';
import type { RunGit } from './ledgerGit.js';

/** The async git facts the prepared repository reads once, up front. */
export interface BackfillAsyncGit {
  entries(rev: string): Promise<ReadonlyMap<string, { readonly blob: string }>>;
  changedIntervals(base: string, head: string): Promise<ReadonlyMap<string, ReadonlySet<number>>>;
  changedPaths(base: string, head: string): Promise<readonly string[]>;
  retain(
    store: ArtifactStore,
    revs: readonly string[],
  ): Promise<{ readonly sha256: string; readonly location: string; readonly kind: string }>;
  verifyReview(event: JsonObject): Promise<unknown>;
}

/** `git diff --name-only --no-renames -z base head` decoded as strict UTF-8. */
export function gitChangedPaths(runGit: RunGit): BackfillAsyncGit['changedPaths'] {
  return async (base, head) => {
    const args = ['diff', '--name-only', '--no-renames', '-z', base, head];
    const call = await runGit(args);
    if (call.code !== 0) throw new AccountingGitError(args, call.code, call.stderr);
    return new TextDecoder('utf-8', { fatal: true })
      .decode(call.stdout)
      .split('\0')
      .filter(Boolean);
  };
}

/**
 * `completionEvent` is synchronous and git is not, so the facts it reads are
 * fetched first (`prepare`), and the one check that needs the finished event
 * (`verifyReview`) is recorded and run by `verifyRecorded` before anything is
 * written. A rev that was not prepared is a refusal, never a silent miss.
 */
export function preparedBackfillRepo(git: BackfillAsyncGit): {
  repo: BackfillRepo;
  prepare(
    revs: { base: string; head: string; target: string },
    store: ArtifactStore,
  ): Promise<void>;
  verifyRecorded(): Promise<void>;
} {
  const entries = new Map<string, ReadonlyMap<string, { readonly blob: string }>>();
  const intervals = new Map<string, ReadonlyMap<string, ReadonlySet<number>>>();
  const paths = new Map<string, readonly string[]>();
  const bundles = new Map<string, JsonValue>();
  let recorded: JsonObject[] = [];
  const key = (...parts: readonly string[]) => parts.join('\0');
  const missing = (what: string): never => {
    throw new LedgerIntegrityError(`git ${what} was not prepared`);
  };
  const repo: BackfillRepo = {
    entries: (rev) => entries.get(rev) ?? missing(`entries for ${rev}`),
    changedIntervals: (base, head) =>
      intervals.get(key(base, head)) ?? missing(`diff ${base}..${head}`),
    changedPaths: (base, head) => paths.get(key(base, head)) ?? missing(`paths ${base}..${head}`),
    retain: (_store: BackfillStore, revs) =>
      bundles.get(key(...[...new Set(revs)].sort())) ?? missing('evidence bundle'),
    verifyReview: (event) => {
      recorded.push(event);
    },
  };
  return {
    repo,
    async prepare({ base, head, target }, store) {
      entries.set(head, await git.entries(head));
      entries.set(target, await git.entries(target));
      intervals.set(key(base, head), await git.changedIntervals(base, head));
      paths.set(key(base, head), await git.changedPaths(base, head));
      const bundle = await git.retain(store, [base, head, target]);
      bundles.set(
        key(...[...new Set([base, head, target])].sort()),
        new JsonObject([
          ['sha256', bundle.sha256],
          ['location', bundle.location],
          ['kind', bundle.kind],
        ]),
      );
    },
    async verifyRecorded() {
      const events = recorded;
      recorded = [];
      for (const event of events) await git.verifyReview(event);
    },
  };
}
