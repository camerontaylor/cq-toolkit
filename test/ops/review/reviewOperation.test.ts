import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  ReviewOperationSchema,
  canonicalReview,
  reviewDigest,
} from '../../../src/ops/review/internal/reviewOperation.js';
const vectors = JSON.parse(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/review-operation/vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  name: string;
  type: string;
  value: unknown;
  valid: boolean;
  canonical?: string;
  sha256?: string;
}[];
for (const row of vectors)
  test(row.name, () => {
    expect(ReviewOperationSchema.safeParse({ type: row.type, value: row.value }).success).toBe(
      row.valid,
    );
    if (row.canonical !== undefined) expect(canonicalReview(row.value)).toBe(row.canonical);
    if (row.sha256 !== undefined) expect(reviewDigest(row.value)).toBe(row.sha256);
  });
