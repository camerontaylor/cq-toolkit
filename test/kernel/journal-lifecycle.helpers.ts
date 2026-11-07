// W2.4: no wave outlives its lease, and an emit failure stops dispatch.
//
// Split provenance: test/kernel/journal-lifecycle.test.ts was split into
// journal-lifecycle.{append-failure,body-entry,fixture-cleanup,ladder,lock-publication,quarantine}.test.ts
// plus this shared fixture module (pure move).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { z } from 'zod';
import { openRunLog } from '../../src/kernel/journal.js';
import { runPlan as kernelRunPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type { JournalEvent, Op, OpRegistryEntry, OpResult, Plan } from '../../src/kernel/types.js';

/**
 * Per-file mock bindings. `vi.hoisted` + `vi.mock` factories cannot reference
 * imported bindings, so each test file declares its own `hooks` and hands it
 * here for the per-file afterEach reset.
 */
export interface JournalHooks {
  before: ((event: JournalEvent) => Promise<void>) | undefined;
  after: ((event: JournalEvent) => Promise<void>) | undefined;
  beforePublication: (() => Promise<void>) | undefined;
}

// Mirrors journal.ts private PUBLICATION_STARTUP_MS; update if that bound changes.
// First acquisition: boot lookup 10s + guard/record I/O 10s (the retired flock
// helper's slot, kept until re-measured) + startup/I/O margin 5s. Later
// acquisitions reuse the successful boot identity: guard/record I/O 10s + 5s.
export const ACQUISITION_STEP_MS = 2 * 10_000 + 5_000;
export function journalEnclosure(steps: number): number {
  return ACQUISITION_STEP_MS + (steps - 1) * 15_000 + 5_000;
}
const pendingRuns = new Map<Promise<unknown>, AbortController>();
export const cleanupActions = new Set<() => void>();
export function runPlan(
  ...args: Parameters<typeof kernelRunPlan>
): ReturnType<typeof kernelRunPlan> {
  const abort = new AbortController();
  const governance = args[3];
  const running = kernelRunPlan(
    args[0],
    args[1],
    args[2],
    governance === undefined
      ? undefined
      : {
          ...governance,
          signal:
            governance.signal === undefined
              ? abort.signal
              : AbortSignal.any([abort.signal, governance.signal]),
        },
  );
  pendingRuns.set(running, abort);
  // Observe outcomes immediately, keeping the original rejecting promise for assertions.
  void running.then(
    () => pendingRuns.delete(running),
    () => pendingRuns.delete(running),
  );
  return running;
}
export async function settleFixtureWork(): Promise<void> {
  for (const abort of pendingRuns.values()) abort.abort();
  for (const action of cleanupActions) action();
  cleanupActions.clear();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcomes = await Promise.race([
      Promise.allSettled([...pendingRuns.keys()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('fixture cleanup: work did not settle; journal retained')),
          ACQUISITION_STEP_MS,
        );
      }),
    ]);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejection?.status === 'rejected') throw rejection.reason;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const directories: string[] = [];
export function registerJournalFixtureCleanup(hooks: JournalHooks): void {
  afterEach(async () => {
    // Reset the per-file hooks even when settling fails: a leaked `before` that
    // throws `injected` would fail unrelated tests. A failed settle propagates
    // after the resets, so the directories stay in place for a live writer
    // (and the error's "journal retained" text stays true).
    try {
      await settleFixtureWork();
    } finally {
      hooks.before = undefined;
      hooks.after = undefined;
      hooks.beforePublication = undefined;
    }
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }, ACQUISITION_STEP_MS + 5_000);
}
export async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-j-lifecycle-'));
  directories.push(dir);
  return dir;
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  cleanupActions.add(resolve);
  return { promise, resolve };
}
// Report setup/infrastructure failure directly instead of waiting forever for
// a stage that the failed run can never reach. A stage still must win before
// the fixture proceeds; an unexpectedly successful early run is also a failure.
export async function awaitStage(
  stage: Promise<void>,
  running: Promise<unknown>,
  name: string,
): Promise<void> {
  await Promise.race([
    stage,
    running.then((result) => {
      if (result instanceof Error) throw result;
      throw new Error(`fixture: run settled before ${name}`);
    }),
  ]);
}
export const plan: Plan = {
  id: 'journal-stop',
  jobs: ['a', 'b', 'c'].map((id) => ({ id, op: 'work', input: { id } })),
};
export function registry(op: (id: string) => Promise<OpResult<unknown>>): OpRegistryView {
  const candidate: OpRegistryEntry<never, never> = {
    name: 'work',
    inputSchema: z.object({ id: z.string() }) as unknown as z.ZodType<never>,
    importer: () =>
      Promise.resolve(((raw: { id: string }) => op(raw.id)) as unknown as Op<never, never>),
  };
  return { get: () => candidate };
}
export async function events(dir: string): Promise<JournalEvent[]> {
  const log = openRunLog(dir);
  return (await Promise.all((await log.runs()).map((id) => log.read(id)))).flat();
}
