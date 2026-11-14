// Observation-only entry: independent of the disabled automated merger.
import { enterWithEntryEnv } from '../config/entry.js';
import { pathToFileURL } from 'node:url';
import { ghJson, ghNameOk, makeGhRunner, type GhFn } from '../adapters/forge-github/gh.js';
import { observeOpenPrs, type ObserveOpenPrsResult } from './merge-recheck.js';

/** An argv/config fault: the I1 usage class (exit 2), not a runtime throw (exit 1). */
class UsageError extends Error {
  override name = 'UsageError';
}

export async function observeRepository(
  gh: GhFn,
  repository: string,
  nowMs: () => number = Date.now,
  observe: typeof observeOpenPrs = observeOpenPrs,
): Promise<ObserveOpenPrsResult> {
  const [owner = '', repo = '', ...extra] = repository.split('/');
  if (extra.length || !ghNameOk(owner) || !ghNameOk(repo)) {
    throw new UsageError('invalid repository');
  }
  // Read the FULL open set before invoking the writer: a partial listing
  // would prune other PRs' anchors. A listing fault must never write.
  const pages = await ghJson<unknown>(gh, [
    'api',
    `repos/${owner}/${repo}/pulls?state=open&base=main&per_page=100`,
    '--paginate',
    '--slurp',
  ]);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('invalid PR pages');
  const prs = pages.flat().map((row: unknown) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('number' in row) ||
      typeof row.number !== 'number' ||
      !Number.isSafeInteger(row.number) ||
      row.number <= 0
    ) {
      throw new Error('invalid PR number');
    }
    return row.number;
  });
  return observe({ gh, owner, repo, nowMs }, [...new Set(prs)]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // The environment is read once; an invalid value exits 2 first. Foreign
    // names (GITHUB_REPOSITORY) come from that same entry record.
    const entry = enterWithEntryEnv();
    if (entry === undefined) {
      process.exitCode = 2;
    } else {
      const result = await observeRepository(
        makeGhRunner({ cqEnv: entry.cqEnv }),
        entry.env['GITHUB_REPOSITORY'] ?? '',
      );
      console.log(JSON.stringify(result));
      // An observation failure must be visible even though no merge was attempted.
      if (result.write?.ok === false || result.skipped.length > 0) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // I1: a bad repository argument is a usage error (2); anything else is a throw (1).
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
