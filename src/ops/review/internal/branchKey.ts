import { createHash } from 'node:crypto';

/** Preserve ordinary record paths; bound long encoded refs to one filesystem component. */
export function reviewBranchKey(branch: string): string {
  const encoded = encodeURIComponent(branch);
  if (encoded.length <= 255) return encoded;
  const digest = createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, 16);
  return `${encoded.slice(0, 180)}-${digest}`;
}
