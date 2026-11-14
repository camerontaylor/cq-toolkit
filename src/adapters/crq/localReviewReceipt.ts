import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '../../policy/crq/jsonValue.js';
import { receiptJsonBytes, sha256Hex } from '../../policy/crq/pythonJson.js';
import { fsyncDir } from './atomic.js';

/** Content-addressed create-only receipt publication, compatible with Python's write_receipt. */
export async function writeLocalReviewReceipt(root: string, document: JsonObject): Promise<string> {
  const data = receiptJsonBytes(document);
  const id = sha256Hex(data);
  await mkdir(root, { recursive: true });
  const temporary = join(root, `.receipt-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, join(root, `${id}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(join(root, `${id}.json`));
      if (!existing.equals(Buffer.from(data)))
        throw new Error('receipt identity collision or tampering');
    }
    await fsyncDir(root);
  } finally {
    await unlink(temporary);
  }
  return id;
}
