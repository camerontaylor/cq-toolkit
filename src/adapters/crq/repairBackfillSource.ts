/**
 * File-backed effects for the repair enqueue, backfill and archive passes
 * (repair_tick.py:175-272, 848-892). Inactive: nothing imports this outside
 * tests. The review.ndjson parser, git and the repair config stay injected:
 * `crq_repair.findings` has no TS port and git is not owned here.
 */
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parseJsonValue, toPlainJson } from '../../policy/crq/jsonValue.js';
import { atomicJsonText } from '../../policy/crq/pythonJson.js';
import type {
  RepairArchiveEffects,
  RepairBackfillEffects,
  SourcedFinding,
} from '../../queue-runner/repairBackfill.js';
import { atomicWrite } from './atomic.js';

export interface FileRepairBackfillInput {
  /** `c.STATE`. */
  readonly stateRoot: string;
  /** `c.RUNS`. */
  readonly runsRoot: string;
  /** `c.LEDGER`. */
  readonly ledgerRoot: string;
  readonly primaryRepo: string;
  readonly defaultRef: string;
  readonly mergedCurrentEnabled: boolean;
  readonly maxRoundsPerPin: number;
  readonly git: (...args: string[]) => Promise<string>;
  readonly findings: (run: string, provenance: boolean) => Promise<SourcedFinding[]>;
  readonly iso: () => string;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

async function readJson(path: string): Promise<unknown> {
  // Python's strict utf-8 decode raises; so does a fatal decoder.
  return toPlainJson(parseJsonValue(decoder.decode(await readFile(path))), { bigints: true });
}

export function fileRepairBackfillEffects(
  input: FileRepairBackfillInput,
): RepairBackfillEffects & RepairArchiveEffects {
  const inbox = (jobId: string): string =>
    join(input.stateRoot, 'repair', 'inbox', `${jobId}.json`);
  return {
    primaryRepo: input.primaryRepo,
    defaultRef: input.defaultRef,
    mergedCurrentEnabled: input.mergedCurrentEnabled,
    maxRoundsPerPin: input.maxRoundsPerPin,
    git: input.git,
    findings: input.findings,
    iso: input.iso,
    async readReceipt(receiptId) {
      return (await readJson(join(input.stateRoot, 'receipts', `${receiptId}.json`))) as Record<
        string,
        unknown
      >;
    },
    async readInbox(jobId) {
      const path = inbox(jobId);
      if (!(await exists(path))) return null;
      return (await readJson(path)) as Record<string, unknown>;
    },
    async writeInbox(jobId, doc) {
      const path = inbox(jobId);
      await mkdir(join(input.stateRoot, 'repair', 'inbox'), { recursive: true });
      await atomicWrite(path, atomicJsonText(doc));
    },
    async resultExists(jobId) {
      // Only a proven absence (ENOENT) reads as `false`; any other stat fault
      // propagates so the caller can retry without rebinding the inbox job.
      try {
        await stat(join(input.stateRoot, 'repair', jobId, 'result.json'));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async hasRunEvidence(run) {
      const dir = join(input.runsRoot, run);
      return (await exists(join(dir, 'meta.json'))) && (await exists(join(dir, 'review.ndjson')));
    },
    readMeta: (run) => readJson(join(input.runsRoot, run, 'meta.json')),
    async archiveLedger() {
      const archive = join(input.ledgerRoot, 'archive');
      await mkdir(archive, { recursive: true });
      for (const name of await readdir(input.ledgerRoot)) {
        if (name.endsWith('-findings.md')) {
          await rename(join(input.ledgerRoot, name), join(archive, name));
        }
      }
    },
  };
}
