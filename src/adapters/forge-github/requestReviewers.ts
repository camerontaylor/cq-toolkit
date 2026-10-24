import { ghNameOk, type GhFn } from './gh.js';

/** One clean-run re-request, deduplicated by current reviewer login. */
export async function requestReviewers(input: {
  owner: string;
  repo: string;
  pr: number;
  reviewers: string[];
  run: GhFn;
}): Promise<void> {
  if (
    !ghNameOk(input.owner) ||
    !ghNameOk(input.repo) ||
    !Number.isSafeInteger(input.pr) ||
    input.pr < 1
  )
    throw new Error('invalid review request repository/PR');
  const reviewers = [...new Set(input.reviewers)];
  if (reviewers.some((login) => !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/.test(login)))
    throw new Error('invalid reviewer login');
  if (!reviewers.length) return;
  const result = await input.run([
    'api',
    '-X',
    'POST',
    `repos/${input.owner}/${input.repo}/pulls/${input.pr}/requested_reviewers`,
    ...reviewers.flatMap((login) => ['-f', `reviewers[]=${login}`]),
  ]);
  if (result.code !== 0) throw new Error(`review re-request failed (exit ${result.code})`);
}
