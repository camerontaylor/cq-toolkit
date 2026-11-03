import { createHash } from 'node:crypto';

/** Preserve ordinary paths; shortened keys use a namespace URI encoding cannot emit. */
export function reviewBranchKey(branch: string): string {
  const encoded = encodeURIComponent(branch);
  if (encoded.length <= 255) return encoded;
  const digest = createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, 16);
  const prefix = encoded.slice(0, 180).replace(/%[0-9A-F]?$/, '');
  // encodeURIComponent always follows '%' with two hex digits, never '_'.
  return `%_${prefix}-${digest}`;
}
