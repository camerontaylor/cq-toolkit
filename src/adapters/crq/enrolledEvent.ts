/** Inactive binding of the enrollment `event(id, reason)` seam: Python's
 * `event("enrolled", item=..., reason=...)`, one `json.dumps` line appended to
 * `events.jsonl` as `{"at", "event", "item", "reason"}` with a whole-second UTC stamp.
 * It appends only; the caller decides when (the enrollment body skips it on a dry run).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { pythonJsonText } from '../../policy/crq/pythonJson.js';

export function fileEnrolledEvent(options: {
  readonly stateRoot: string;
  readonly now?: () => Date;
}): (id: string, reason: string) => Promise<void> {
  const now = options.now ?? (() => new Date());
  return async (id, reason) => {
    await mkdir(options.stateRoot, { recursive: true });
    const line = pythonJsonText(
      new JsonObject([
        ['at', `${now().toISOString().slice(0, 19)}Z`],
        ['event', 'enrolled'],
        ['item', id],
        ['reason', reason],
      ]),
      {
        asciiOnly: true,
        sortKeys: false,
        keyOrder: 'insertion',
        indent: null,
        spacedSeparators: true,
      },
    );
    await appendFile(join(options.stateRoot, 'events.jsonl'), `${line}\n`);
  };
}
