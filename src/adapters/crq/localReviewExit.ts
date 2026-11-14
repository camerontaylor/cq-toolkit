import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { classify } from '../../policy/crq/classification.js';
import { atomicJsonText, pythonJsonText } from '../../policy/crq/pythonJson.js';
import type { LocalExitHarvestEffects } from '../../ops/crq/internal/localReviewExit.js';
import {
  completeLocalReview,
  type LocalHarvestEffects,
} from '../../ops/crq/internal/localReviewHarvest.js';
import { runLiveness } from '../process/liveness.js';
import { atomicWrite } from './atomic.js';
import { containedLocalRunArtifact } from './localReviewHarvest.js';

/** Bind local files, liveness, canonical classification and receipt completion. The caller supplies safe cleanup. */
export function fileLocalExitHarvestEffects(options: {
  stateRoot: string;
  harvest: LocalHarvestEffects;
  cleanup: LocalExitHarvestEffects['cleanup'];
  now?: () => Date;
}): LocalExitHarvestEffects {
  const root = options.stateRoot;
  const now = options.now ?? (() => new Date());
  const runDir = (id: string): string => {
    if (!id || id === '.' || id === '..' || /[/\\\0]/.test(id)) throw new Error('invalid run id');
    return join(root, 'runs', id);
  };
  async function readObject(path: string): Promise<JsonObject> {
    const bytes = await readFile(path);
    const value = parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!(value instanceof JsonObject)) throw new Error('expected JSON object');
    return value;
  }
  return {
    async liveness(id, run) {
      const dir = runDir(id);
      let exists = false;
      try {
        await stat(join(dir, 'exit.json'));
        exists = true;
      } catch {
        /* Python exists() returns false for inaccessible paths. */
      }
      return runLiveness(dir, run, exists);
    },
    readExit: async (id) => readObject(await containedLocalRunArtifact(root, id, 'exit.json')),
    async writeNext(stamp) {
      await mkdir(root, { recursive: true });
      await atomicWrite(join(root, 'next-review-at'), `${stamp}\n`);
    },
    readMeta: async (id) => readObject(await containedLocalRunArtifact(root, id, 'meta.json')),
    async readStream(id) {
      try {
        return await readFile(await containedLocalRunArtifact(root, id, 'review.ndjson'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    classify,
    async writeClassification(id, cls) {
      await writeFile(join(runDir(id), 'classification.json'), atomicJsonText(cls));
    },
    async writeFindings(id, text) {
      await writeFile(join(runDir(id), 'findings.md'), text, 'utf8');
    },
    async event(kind, data) {
      await mkdir(root, { recursive: true });
      const value = new JsonObject([
        ['at', `${now().toISOString().slice(0, 19)}Z`],
        ['event', kind],
        ...data.entries,
      ]);
      await appendFile(
        join(root, 'events.jsonl'),
        pythonJsonText(value, {
          asciiOnly: true,
          sortKeys: false,
          keyOrder: 'insertion',
          indent: null,
          spacedSeparators: true,
        }) + '\n',
      );
    },
    complete: async (queue, item, runId, cls, endedAt, exitCode, stream) => {
      if (stream === null) throw new Error('missing classified artifact');
      return (
        await completeLocalReview(
          queue,
          item,
          runId,
          cls,
          endedAt,
          exitCode,
          options.harvest,
          stream,
        )
      ).queue;
    },
    cleanup: options.cleanup,
    nowIso: () => `${now().toISOString().slice(0, 19)}Z`,
  };
}
