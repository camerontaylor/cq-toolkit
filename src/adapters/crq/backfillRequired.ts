import { execFile } from 'node:child_process';
import { pythonInt } from '../../policy/crq/backfillInventory.js';
import { LedgerIntegrityError, ledgerLoads } from '../../policy/crq/ledger.js';
import { isJsonRecord, pyTruthy, recordGet } from '../../policy/crq/queueDoc.js';
import { AccountingGitError, type GitAccountingRepository } from './backfillAccounting.js';
import type { ArtifactStore } from './findingStore.js';
import type { RunGit } from './ledgerGit.js';

/** Raw forge bytes are retained before parsing or validation. */
export type FetchRequiredPr = (pr: number) => Promise<Uint8Array>;

/** A forge subprocess that started but failed, analogous to CalledProcessError. */
export class RequiredForgeError extends Error {
  override readonly name = 'RequiredForgeError';
}

/** Live, argv-only acquisition of the canonical repository's PR response. */
export const fetchRequiredPr: FetchRequiredPr = async (pr) => {
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new LedgerIntegrityError('invalid required PR');
  return await new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', `repos/camerontaylor/cq-toolkit/pulls/${pr}`],
      {
        encoding: 'buffer',
        timeout: 60_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error)
          reject(
            typeof error.code === 'string'
              ? error
              : new RequiredForgeError(error.message, { cause: error }),
          );
        else resolve(new Uint8Array(stdout));
      },
    );
  });
};

export interface CollectRequiredOptions {
  readonly repo: GitAccountingRepository;
  /** Hardened runner bound to the same clone as repo. */
  readonly runGit: RunGit;
  readonly target: string;
  readonly required: unknown;
  readonly artifacts: Pick<ArtifactStore, 'put'>;
  readonly fetchPr: FetchRequiredPr;
}

/** Python collect_required without its optional disposable cache. */
export async function collectRequired(options: CollectRequiredOptions): Promise<{
  readonly requiredPaths: Record<string, unknown[]>;
  readonly members: Record<string, unknown>;
}> {
  const { repo, runGit, target, required, artifacts, fetchPr } = options;
  if (!isJsonRecord(required) || !Array.isArray(recordGet(required, 'rows'))) {
    throw new LedgerIntegrityError('invalid required PR rows');
  }
  const requiredPaths: Record<string, unknown[]> = {};
  const members: Record<string, unknown> = {};
  for (const row of recordGet(required, 'rows') as unknown[]) {
    if (!isJsonRecord(row)) throw new LedgerIntegrityError('invalid required PR row');
    const pr = pythonInt(recordGet(row, 'pr'), 'required PR');
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new LedgerIntegrityError('invalid required PR');
    const raw = await fetchPr(pr);
    const reference = await artifacts.put(raw);
    const value = ledgerLoads(raw);
    if (
      !isJsonRecord(value) ||
      pythonInt(recordGet(value, 'number'), 'PR number') !== pr ||
      !pyTruthy(recordGet(value, 'merged'))
    ) {
      throw new LedgerIntegrityError('required PR identity/merge mismatch');
    }
    const mergeSha = recordGet(value, 'merge_commit_sha');
    if (typeof mergeSha !== 'string') throw new LedgerIntegrityError('invalid required PR merge');
    const merge = await repo.resolve(mergeSha);
    const parentCall = await runGit(['rev-parse', `${merge}^1`]);
    if (parentCall.code !== 0)
      throw new AccountingGitError(['rev-parse'], parentCall.code, parentCall.stderr);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parent = decoder.decode(parentCall.stdout).trim();
    const args = ['diff', '--name-only', '--no-renames', '-z', parent, merge];
    const diff = await runGit(args);
    if (diff.code !== 0) throw new AccountingGitError(args, diff.code, diff.stderr);
    const names = decoder.decode(diff.stdout).split('\0').filter(Boolean);
    const sourcePaths: unknown[] = [];
    const memberPaths: unknown[] = [];
    for (const name of names) {
      const mapped = await repo.lineage(merge, target, name);
      if (mapped) {
        sourcePaths.push({ path: mapped, source_path: name, source_evidence: reference });
        memberPaths.push({ path: mapped, source_path: name, lineage_verified: true });
      } else if (
        (await repo.provenDeleted(merge, target, name)) ||
        (!(await repo.entries(merge)).has(name) && (await repo.provenDeleted(parent, target, name)))
      ) {
        sourcePaths.push({
          path: name,
          disposition: 'deleted',
          deletion_evidence: { target, merge, source: reference },
        });
      } else {
        sourcePaths.push({ path: name, disposition: 'ambiguous', source_evidence: reference });
      }
    }
    requiredPaths[String(pr)] = sourcePaths;
    members[String(pr)] = {
      merge,
      paths: memberPaths,
      pr,
      context: {
        trust: 'untrusted-data-only',
        title: recordGet(value, 'title') === undefined ? '' : recordGet(value, 'title'),
        body: pyTruthy(recordGet(value, 'body')) ? recordGet(value, 'body') : '',
      },
    };
  }
  return { requiredPaths, members };
}
