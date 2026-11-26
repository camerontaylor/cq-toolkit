/**
 * The run-artifact half of `HarvestReviewEffects`, read straight from the
 * files a Python (or TS) review child leaves in `STATE/runs/<run_id>/`:
 * `review.pid` (liveness identity), `review.ndjson` (the event stream),
 * `exit.json` (`{exit, ended_at, timed_out}`, written last by the child) and
 * `meta.json`. Inactive: nothing imports this from a runtime entry point.
 *
 * This is how a tick harvests a review that a detached `python3 crq.py _review
 * <run_id>` started: it never talks to the child, it only reads what the child
 * wrote. Everything else `harvest_review` needs (findings.md, receipts, worktree
 * removal, repair enqueue, coverage) stays a caller-supplied effect, listed in
 * the tick gap inventory.
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { classify } from '../../policy/crq/classification.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJsonRetainingNumbers,
  JsonNumber,
} from '../../policy/crq/jsonValue.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import { atomicJsonText } from '../../policy/crq/pythonJson.js';
import { parseIso } from '../../policy/crq/utc.js';
import type { Classification, HarvestReviewEffects } from '../../queue-runner/harvestReview.js';
import { runLiveness } from '../process/liveness.js';
import { atomicWrite } from './atomic.js';

export type HarvestRunReads = Pick<
  HarvestReviewEffects,
  | 'exitFileExists'
  | 'runLiveness'
  | 'readExitCode'
  | 'readEndedAtMs'
  | 'writeNext'
  | 'readMeta'
  | 'classify'
  | 'writeClassification'
  | 'runPath'
  | 'readReviewText'
>;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** `usage_slots.write_next`'s stamp: `%Y-%m-%dT%H:%M:%SZ`, whole seconds. */
const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

export function fileHarvestRunReads(options: {
  readonly stateRoot: string;
  readonly nowMs: () => number;
}): HarvestRunReads {
  const runDir = (runId: string): string => {
    if (!runId || runId === '.' || runId === '..' || /[/\\\0]/.test(runId))
      throw new Error('invalid run id');
    return join(options.stateRoot, 'runs', runId);
  };
  const readObject = async (path: string): Promise<JsonObject> => {
    const value = parseJsonValue(decoder.decode(await readFile(path)));
    if (!(value instanceof JsonObject)) throw new Error('expected JSON object');
    return value;
  };
  const exitExists = async (runId: string): Promise<boolean> => {
    // Python `Path.exists()`: an inaccessible path is "not there".
    try {
      await stat(join(runDir(runId), 'exit.json'));
      return true;
    } catch {
      return false;
    }
  };
  return {
    exitFileExists: exitExists,
    async runLiveness(runId, item, run, hasExit) {
      return runLiveness(runDir(runId), run as unknown as Record<string, unknown>, hasExit);
    },
    async readExitCode(runId) {
      const exit = (await readObject(join(runDir(runId), 'exit.json'))).get('exit');
      if (exit === undefined) throw new Error('KeyError: exit');
      if (exit === null) return null;
      if (exit instanceof JsonNumber && exit.integer !== null) return Number(exit.integer);
      throw new TypeError('exit is not an integer');
    },
    async readEndedAtMs(runId) {
      try {
        const ended = (await readObject(join(runDir(runId), 'exit.json'))).get('ended_at');
        return parseIso(ended ?? null)?.epochMillis() ?? null;
      } catch {
        return null; // OSError/ValueError/TypeError: the caller falls back to now()
      }
    },
    async writeNext() {
      await mkdir(options.stateRoot, { recursive: true });
      await atomicWrite(join(options.stateRoot, 'next-review-at'), `${stamp(options.nowMs())}\n`);
    },
    async readMeta(runId) {
      return toPlainJsonRetainingNumbers(
        await readObject(join(runDir(runId), 'meta.json')),
      ) as Record<string, unknown>;
    },
    async classify(runId, exitCode) {
      let bytes: Uint8Array | null = null;
      try {
        bytes = await readFile(join(runDir(runId), 'review.ndjson'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return toPlainJsonRetainingNumbers(classify(bytes, exitCode)) as Classification;
    },
    async writeClassification(runId, cls) {
      await atomicWrite(
        join(runDir(runId), 'classification.json'),
        atomicJsonText(fromPlainJson(cls)),
      );
    },
    runPath: (runId, name) => join(runDir(runId), name),
    readReviewText: async (runId) =>
      new TextDecoder('utf-8', { fatal: false }).decode(
        await readFile(join(runDir(runId), 'review.ndjson')),
      ),
  };
}
