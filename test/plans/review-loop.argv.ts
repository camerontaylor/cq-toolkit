// Split provenance: test/plans/review-loop.helpers.ts was split by subject;
// this module carries the shared gh argv helpers used by the fakes and the
// call-log assertions.
import type { GhResult } from '../../src/adapters/forge-github/gh.js';

export const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });

/** Value of a `name=…` argv entry the gh -f/-F flags carry. */
export const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};
