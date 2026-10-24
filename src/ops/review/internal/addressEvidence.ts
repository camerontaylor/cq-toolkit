import {
  commitFailedAttempt,
  type FailedAttempt,
  type FailedAttemptInput,
  type FailedAttemptGate,
} from '../../sweep/taskLoop.js';
import type { ModelSpec } from '../../../driver/types.js';
import { SWEEP_DIFF_FLAGS } from '../../../shared/gitDiffFlags.js';

export interface AddressFailedAttempt extends FailedAttempt {
  finding: string;
  unit: string;
  outcome: 'unfixed' | 'escalated-to-human';
  model: ModelSpec;
  file: string;
  parent: string;
  executionHead: string;
  ordinal: number;
  tier: 'worker' | 'rescue';
  gate: FailedAttemptGate;
  reason: string;
}

/** Reuse the settled commit convention only against an isolated owned index. */
export async function pinAddressFailure(
  git: (args: string[]) => Promise<string>,
  input: FailedAttemptInput,
): Promise<FailedAttempt> {
  let creations = 0;
  return commitFailedAttempt(async (args) => {
    // The general helper retries occupied ordinals; S6 bounds that work even
    // when cleanup is running after cancellation or budget exhaustion.
    if (creations >= 32) throw new Error('failed-attempt branch collision limit exhausted');
    if (args[0] === 'update-ref') creations++;
    return git(args);
  }, input).catch((error: unknown) => {
    if (creations >= 32)
      throw new Error('failed-attempt branch collision limit exhausted', { cause: error });
    throw error;
  });
}

/** Reconstruct feedback from immutable engine-owned coordinates, never a ref tip. */
export async function addressFailureFeedback(
  git: (args: string[]) => Promise<string>,
  prior: AddressFailedAttempt,
): Promise<{ patch: string; contents: Array<{ text: string; path: string }> }> {
  if ((await git(['rev-parse', '--verify', `refs/heads/${prior.branch}`])) !== prior.sha)
    throw new Error('prior failed-attempt branch no longer matches its recorded ordinal');
  if (
    (await git(['rev-list', '--parents', '-n', '1', prior.sha])) !== `${prior.sha} ${prior.parent}`
  )
    throw new Error('prior failed-attempt parentage changed');
  const paths = (
    await git(['diff', ...SWEEP_DIFF_FLAGS, '--name-only', '-z', prior.parent, prior.sha, '--'])
  )
    .split('\0')
    .filter(Boolean);
  if (paths.some((path) => path !== prior.file))
    throw new Error('prior failed-attempt contains an unowned path');
  const contents: Array<{ text: string; path: string }> = [];
  for (const revision of [prior.parent, prior.sha]) {
    const object = `${revision}:${prior.file}`;
    const size = await git(['cat-file', '-s', object]);
    if (!/^\d+$/.test(size) || Number(size) > 4 * 1024 * 1024)
      throw new Error('prior failed-attempt file exceeds feedback cap');
    const text = await git(['show', object]);
    if (text.includes('\0') || text.includes('\uFFFD') || Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw new Error('prior failed-attempt file is not safely scannable text');
    contents.push({ text, path: prior.file });
  }
  const message = await git(['show', '-s', '--format=%B', prior.sha]);
  if (Buffer.byteLength(message) > 4 * 1024 * 1024)
    throw new Error('prior failed-attempt provenance exceeds feedback cap');
  contents.push({ text: message, path: '.git/cq-failed-commit-message' });
  contents.push({ text: JSON.stringify(prior), path: 'cq-failed-attempt.json' });
  const patch = await git([
    'diff',
    ...SWEEP_DIFF_FLAGS,
    '--binary',
    '--full-index',
    prior.parent,
    prior.sha,
    '--',
  ]);
  if (Buffer.byteLength(patch) > 32 * 1024 * 1024)
    throw new Error('prior failed-attempt patch exceeds feedback cap');
  return { patch, contents };
}
