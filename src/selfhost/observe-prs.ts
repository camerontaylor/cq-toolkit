// Observation-only entry: independent of the disabled automated merger.
import { pathToFileURL } from 'node:url';
import { ghJson, ghNameOk, makeGhRunner, type GhFn } from '../adapters/forge-github/gh.js';
import { observeOpenPrs, type ObserveOpenPrsResult } from './merge-recheck.js';

export async function observeRepository(
  gh: GhFn,
  repository: string,
  nowMs: () => number = Date.now,
  observe: typeof observeOpenPrs = observeOpenPrs,
): Promise<ObserveOpenPrsResult> {
  const [owner = '', repo = '', ...extra] = repository.split('/');
  if (extra.length || !ghNameOk(owner) || !ghNameOk(repo)) throw new Error('invalid repository');
  // Read the FULL open set before invoking the writer: a partial listing
  // would prune other PRs' anchors. A listing fault must never write.
  const pages = await ghJson<unknown>(gh, [
    'api',
    `repos/${owner}/${repo}/pulls?state=open&base=merge-queue&per_page=100`,
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
    const result = await observeRepository(makeGhRunner(), process.env['GITHUB_REPOSITORY'] ?? '');
    console.log(JSON.stringify(result));
    // An observation failure must be visible even though no merge was attempted.
    if (result.write?.ok === false || result.skipped.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
