import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StatusInputSchema } from './internal/reviewOperation.js';
import { QueueUnsupported } from './internal/queueClient.js';
import { evidenceRequestPath, reviewOp, withoutHistoryCue } from './internal/localReview.js';
import type { QueueTransport } from './internal/queueProtocol.js';

/**
 * The advisory cue is emitted once per material change. The per-request
 * evidence file is a local cache only: a missing or unwritable cache still
 * returns the projection, and exact reuse never depends on it.
 */
type HistoryCue = { digest: string; cue?: string | undefined };

async function cueOnce<T extends object>(cwd: string, requestId: string, response: T) {
  const history = (response as { history?: HistoryCue | undefined }).history;
  if (!history) return response;
  const path = await evidenceRequestPath(cwd, requestId);
  let record: Record<string, unknown> = {};
  if (path) {
    try {
      record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    } catch {
      record = {};
    }
    if (record.history_digest === history.digest)
      return { ...response, history: withoutHistoryCue(history) };
  }
  if (path) {
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = path + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, JSON.stringify({ ...record, history_digest: history.digest }), {
        mode: 0o600,
      });
      await rename(tmp, path);
    } catch {
      // A status poll must succeed without its presentation cache.
    }
  }
  return response;
}

export const makeStatus = (transport?: QueueTransport) =>
  reviewOp(
    StatusInputSchema,
    async (i, getClient) => {
      const client = getClient();
      const capabilities = await client.capabilities();
      if (i.notify !== undefined && !capabilities.operations.includes('notify-update'))
        throw new QueueUnsupported('notify-update capability unavailable');
      const response = await client.request(
        i.notify === undefined
          ? { v: 1, op: 'status', request_id: i.requestId }
          : { v: 1, op: 'notify-update', request_id: i.requestId, notify: i.notify },
      );
      return cueOnce(i.cwd, i.requestId, response);
    },
    transport,
  );
