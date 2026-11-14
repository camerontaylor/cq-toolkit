import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeLocalReviewReceipt } from '../../../src/adapters/crq/localReviewReceipt.js';
import { JsonObject, JsonNumber } from '../../../src/policy/crq/jsonValue.js';
import { receiptJsonBytes } from '../../../src/policy/crq/pythonJson.js';

describe('local review receipt storage', () => {
  it('publishes canonical bytes, reuses identical content and refuses tampering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crq-receipt-'));
    try {
      const value = new JsonObject([
        ['float', JsonNumber.float(1)],
        ['large', JsonNumber.int('12345678901234567890')],
      ]);
      const id = await writeLocalReviewReceipt(dir, value);
      expect(await readFile(join(dir, `${id}.json`))).toEqual(Buffer.from(receiptJsonBytes(value)));
      expect(await writeLocalReviewReceipt(dir, value)).toBe(id);
      await writeFile(join(dir, `${id}.json`), 'tampered');
      await expect(writeLocalReviewReceipt(dir, value)).rejects.toThrow('tampering');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
