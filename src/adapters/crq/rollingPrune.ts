/** Best-effort rolling wrapper retention, called only under the tick lock. */
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import {
  checkpointDigest,
  reconcileWrapperKey,
  RECONCILE_METHOD_CLOSED_UPDATED,
} from '../../policy/crq/reconcileCheckpoint.js';

/** Decide deletion only on positive proof of an enrolled, old rolling wrapper. */
export function mayPruneRollingWrapper(
  text: string,
  key: string,
  repo: string,
  watermark: string,
  cutoff: string,
  keep: ReadonlySet<string>,
): boolean {
  if (keep.has(key)) return false;
  try {
    const wrapper = parseJsonValue(text, { duplicates: 'last' });
    if (!(wrapper instanceof JsonObject)) return false;
    const keys = wrapper.entries.map(([name]) => name);
    if (
      keys.length !== 3 ||
      !['source', 'checkpoint', 'digest'].every((name) => keys.includes(name))
    )
      return false;
    const source = wrapper.get('source');
    const checkpoint = wrapper.get('checkpoint');
    if (!(source instanceof JsonObject) || !(checkpoint instanceof JsonObject)) return false;
    const after = checkpoint.get('after');
    const before = checkpoint.get('before');
    return (
      source.get('method') === RECONCILE_METHOD_CLOSED_UPDATED &&
      wrapper.get('digest') === checkpointDigest(wrapper) &&
      checkpoint.get('complete') === true &&
      checkpoint.get('dry_run') === false &&
      typeof after === 'string' &&
      typeof before === 'string' &&
      key === reconcileWrapperKey(repo, { after, before }, RECONCILE_METHOD_CLOSED_UPDATED) &&
      before <= watermark &&
      before < cutoff
    );
  } catch {
    return false;
  }
}

/**
 * Python's best-effort cleanup. The caller must hold the shared tick.lock and
 * must have durably saved enrollment and watermark first. A failed read or
 * unlink retains that wrapper and does not abort discovery.
 */
export async function pruneRollingWrappers(
  stateRoot: string,
  repo: string,
  queue: JsonObject,
  cutoff: string,
): Promise<number> {
  const watermark = queue.get('merged_watermark');
  if (typeof watermark !== 'string') return 0;
  const keep = new Set<string>();
  const active = queue.get('merged_discovery');
  if (active instanceof JsonObject) {
    const after = active.get('after');
    const before = active.get('before');
    if (typeof after === 'string' && typeof before === 'string') {
      keep.add(reconcileWrapperKey(repo, { after, before }, RECONCILE_METHOD_CLOSED_UPDATED));
    }
  }
  const reconcile = queue.get('merged_reconcile');
  if (reconcile instanceof JsonObject && typeof reconcile.get('checkpoint_key') === 'string') {
    keep.add(reconcile.get('checkpoint_key') as string);
  }
  const dir = join(stateRoot, 'reconcile');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const bytes = await readFile(path);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (mayPruneRollingWrapper(text, name.slice(0, -5), repo, watermark, cutoff, keep)) {
        await unlink(path);
        removed++;
      }
    } catch {
      // Corrupt, unreadable and concurrently removed files are retained/ignored.
    }
  }
  return removed;
}
