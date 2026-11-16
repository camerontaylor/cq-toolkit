import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { BackfillRunArtifacts } from '../../ops/crq/internal/backfillHarvest.js';

/** Reads existing run artifacts only. No network, liveness inference or mutation. */
export function backfillArtifactReader(
  stateRoot: string,
): (runId: string) => Promise<BackfillRunArtifacts> {
  const runs = join(stateRoot, 'runs');
  return async (runId) => {
    if (!runId || runId === '.' || runId === '..' || /[/\\\0]/.test(runId))
      throw new Error('invalid run id');
    const root = await realpath(runs);
    const dir = await realpath(join(root, runId));
    if (relative(root, dir) !== runId) throw new Error('run directory escapes its identity');
    const read = async (name: string): Promise<Uint8Array> => {
      const path = await realpath(join(dir, name));
      const rel = relative(dir, path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error('run artifact escapes runs directory');
      return readFile(path);
    };
    return {
      meta: await read('meta.json'),
      exit: await read('exit.json'),
      review: await read('review.ndjson'),
    };
  };
}
