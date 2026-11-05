// Shared fixtures for the split of test/ops/review/address-attempt-journal.test.ts
// (round-2 pure-move split): the T14 attempt-journal cases now live in the
// `address-attempt-journal.*.test.ts` subject files beside this module.
//
// ADR-0008 T14: `attempt-finished` emission at review.address fixer dispatch
// boundaries (src/ops/review/addressWorker.ts::makeAddressWorker).
//
// Local, fake-driver fixtures only: no provider, no network, no credentials.
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpInvocation } from '../../../src/driver/types.js';
import { openObservationWriter } from '../../../src/kernel/observation.js';
import type { ObservationWriter } from '../../../src/kernel/observation.js';
import type { AttemptFinishedJournalEvent } from '../../../src/kernel/types.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { AddressFix } from '../../../src/ops/review/addressWorker.js';

export async function headerWriter(): Promise<{ writer: ObservationWriter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cq-address-attempt-journal-'));
  const workId = randomUUID();
  const writer = await openObservationWriter({
    journalDir: root,
    workId,
    compositionRunId: `comp-${Date.now()}`,
  });
  await writer.append({
    type: 'composition-started',
    runId: writer.compositionRunId,
    at: new Date().toISOString(),
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: {
      journalVersion: 3,
      provenance: {
        cqVersion: 'test',
        producerVersion: 'test',
        repoId: null,
        cqJsonHash: `sha256:${'0'.repeat(64)}`,
        baseSha: 'a'.repeat(40),
        runPrefix: 'cq-address/test',
        startedAt: new Date().toISOString(),
        endedAt: null,
        journalLink: 'runs/x.ndjson',
        reportLink: 'reports/x.json',
        witnesses: {
          base: 'a'.repeat(40),
          admitted: null,
          execution: null,
          reviewed: null,
          accepted: null,
        },
      },
      correlation: {
        workId,
        parentWorkId: null,
        branch: 'cq-address/test',
        commitSha: null,
        sessionId: null,
        agentId: null,
      },
    },
  });
  return { writer, root };
}

export const attemptEvents = (writer: ObservationWriter): AttemptFinishedJournalEvent[] =>
  writer.events().filter((e): e is AttemptFinishedJournalEvent => e.type === 'attempt-finished');

/** The verdict an observation failure must never move. */
export const verdictOf = (fix: AddressFix) => ({
  status: fix.finding.status,
  reason: fix.finding.reason,
  committed: fix.commit !== undefined,
});

/** A slow default handler so wallMs is a measured, non-zero wall. */
export const slowHandler = async (input: OpInvocation): Promise<unknown> => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (input.outputSchema?.name === 'review.address.closure/v1')
    return { closed: true, reason: 'candidate fixed' };
  if (input.prompt.includes('initial finding'))
    await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
  return { disposition: 'fixed', reason: 'fixed', evidence: [] };
};

/** No rescue lane: a failing worker attempt is the finding's last attempt. */
export const noRescue = (config: CqConfig): void => {
  if (config.roles) delete config.roles.rescue;
};
