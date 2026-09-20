// PR lane (goal D3 follow-up, review-debt #171) — evidence for the
// tracker-body read-modify-write lock (makeTrackerBodyLock in
// src/ops/pr/assemblePrs.ts).
//
// The failure this pins: pr.assemblePrs (manifest section) and pr.runReport
// (readiness section) each read the tracker's CURRENT body, compose their own
// section, and issue a FULL-body edit. Interleaved, the later edit restores a
// stale copy of the other writer's section — the manifest or the readiness
// report is silently lost. Pinned here:
//   1. TWO CONCURRENT WRITERS COMPOSE: with the assembler parked INSIDE its
//      locked read-modify-write span, the run report does NOT read the body
//      until the assembler's edit lands; the final body carries BOTH fresh
//      sections and the caller's prose.
//   2. THE LOCK IS TRACKER-SCOPED: a writer for a DIFFERENT tracker never
//      waits on a parked holder.
//   3. THE LOCK RELEASES ON FAULT: an edit fault inside the span fails the op
//      and a subsequent writer on the same tracker proceeds.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  makeAssemblePrs,
  MANIFEST_SECTION_END_MARKER,
  MANIFEST_SECTION_MARKER,
  READINESS_SECTION_END_MARKER,
  READINESS_SECTION_MARKER,
  type AssemblePrsInput,
  type PrEffects,
} from '../../../src/ops/pr/assemblePrs.js';
import { makeRunReport, type RunReportInput } from '../../../src/ops/pr/runReport.js';

const REPO_ROOT = mkdtempSync(join(tmpdir(), 'pr-tracker-body-lock-'));
afterAll(() => {
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

const TRACKER = 1;
const OTHER = 2;
const TRACKER_BRANCH = 'cq/09-16a/tracker';

const SEED_BODY = [
  'User prose above.',
  '',
  MANIFEST_SECTION_MARKER,
  'OLD MANIFEST',
  MANIFEST_SECTION_END_MARKER,
  '',
  READINESS_SECTION_MARKER,
  'OLD READINESS',
  READINESS_SECTION_END_MARKER,
  '',
  'User prose below.',
].join('\n');

interface SharedForge {
  effects: PrEffects;
  bodies: Map<number, string>;
  calls: string[];
  /** Park the next `getPrBody(TRACKER)` until released (simulates a slow holder). */
  armGate(): void;
  releaseGate(): void;
  /** Fail the next tracker `editPrBody` once (the release-on-fault pin). */
  failNextTrackerEdit(): void;
}

function sharedForge(): SharedForge {
  const bodies = new Map<number, string>([
    [TRACKER, SEED_BODY],
    [OTHER, SEED_BODY],
  ]);
  const calls: string[] = [];
  let armed = false;
  let release: (() => void) | undefined;
  let failEdit = false;
  const effects: PrEffects = {
    searchPrByHead: async (head, base) => {
      calls.push(`search:${head}->${base}`);
      if (head === TRACKER_BRANCH) {
        return { number: TRACKER, state: 'open', isCrossRepository: false };
      }
      return null;
    },
    createPr: async (request) => {
      calls.push(`create:${request.head}`);
      const number = 100 + bodies.size;
      bodies.set(number, request.body ?? '');
      return { number };
    },
    editPrBody: async (number, body) => {
      calls.push(`edit:${number}`);
      if (number === TRACKER && failEdit) {
        failEdit = false;
        throw new Error('simulated tracker edit fault');
      }
      bodies.set(number, body);
    },
    getPrBody: async (number) => {
      calls.push(`get:${number}`);
      if (armed && number === TRACKER) {
        armed = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return bodies.get(number) ?? '';
    },
    comment: async () => {},
    getPrReadiness: async (number) => {
      calls.push(`readiness:${number}`);
      return {
        checks: { state: 'pass' },
        review: { state: 'none' },
        meta: { isDraft: false, state: 'open', mergeable: 'mergeable', mergeStateStatus: 'clean' },
      };
    },
  };
  return {
    effects,
    bodies,
    calls,
    armGate: () => {
      armed = true;
    },
    releaseGate: () => {
      release?.();
    },
    failNextTrackerEdit: () => {
      failEdit = true;
    },
  };
}

const assembleInput = (): AssemblePrsInput => ({
  repoRoot: REPO_ROOT,
  runPrefix: 'cq/09-16a',
  base: 'origin/merge-queue',
  tracker: { title: 'Fleet run cq/09-16a', branch: TRACKER_BRANCH },
  packages: [{ name: 'core', branch: 'cq/09-16a/fix/core', title: 'core fixes' }],
});

const reportInput = (tracker: number = TRACKER): RunReportInput => ({
  repoRoot: REPO_ROOT,
  runPrefix: 'cq/09-16a',
  tracker: { number: tracker },
  packages: [{ name: 'core', number: 11 }],
});

/** Poll until `predicate` holds (bounded), yielding to the event loop. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('tracker-body read-modify-write lock (review-debt #171)', () => {
  test('two concurrent writers on the SAME tracker compose both sections', async () => {
    const forge = sharedForge();
    forge.armGate();
    const assemble = makeAssemblePrs(forge.effects);
    const report = makeRunReport(forge.effects);

    const assembling = assemble(assembleInput());
    // The assembler is parked INSIDE its locked span (holding the lock).
    await waitFor(() => forge.calls.includes(`get:${TRACKER}`));
    expect(forge.calls).not.toContain(`edit:${TRACKER}`);

    // Start the report; the lock must keep it out of the body read.
    const reporting = report(reportInput());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(forge.calls.filter((call) => call === `get:${TRACKER}`)).toHaveLength(1);

    forge.releaseGate();
    const [assembled, reported] = await Promise.all([assembling, reporting]);
    expect(assembled.status).toBe('ok');
    expect(reported.status).toBe('ok');

    const body = forge.bodies.get(TRACKER) ?? '';
    // Both fresh sections landed; neither writer's section was lost.
    expect(body).toContain(MANIFEST_SECTION_MARKER);
    expect(body).toContain(MANIFEST_SECTION_END_MARKER);
    expect(body).toContain(READINESS_SECTION_MARKER);
    expect(body).toContain(READINESS_SECTION_END_MARKER);
    expect(body).toContain('`core`'); // the manifest row
    expect(body).toContain('#11'); // the readiness row
    expect(body).not.toContain('OLD MANIFEST');
    expect(body).not.toContain('OLD READINESS');
    // The caller's prose outside both managed spans survives.
    expect(body).toContain('User prose above.');
    expect(body).toContain('User prose below.');

    // The report's body read happened AFTER the assembler's edit: the spans
    // were serialized, not interleaved.
    const editIndex = forge.calls.indexOf(`edit:${TRACKER}`);
    const lastGetIndex = forge.calls.lastIndexOf(`get:${TRACKER}`);
    expect(editIndex).toBeGreaterThan(-1);
    expect(lastGetIndex).toBeGreaterThan(editIndex);
  });

  test('the lock is tracker-scoped: a different tracker never waits on a parked holder', async () => {
    const forge = sharedForge();
    forge.armGate();
    const assemble = makeAssemblePrs(forge.effects);
    const report = makeRunReport(forge.effects);

    const assembling = assemble(assembleInput());
    await waitFor(() => forge.calls.includes(`get:${TRACKER}`));

    // The OTHER tracker's writer completes while TRACKER's lock is held.
    const otherResult = await report(reportInput(OTHER));
    expect(otherResult.status).toBe('ok');
    expect(forge.bodies.get(OTHER)).toContain('#11');

    forge.releaseGate();
    await assembling;
  });

  test('a fault inside the locked span releases the lock for the next writer', async () => {
    const forge = sharedForge();
    forge.failNextTrackerEdit();
    const assemble = makeAssemblePrs(forge.effects);
    const failed = await assemble(assembleInput());
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') {
      expect(failed.error).toMatch(/could not update tracker PR/);
    }

    // The lock was released: the report on the SAME tracker proceeds.
    const report = makeRunReport(forge.effects);
    const reported = await report(reportInput());
    expect(reported.status).toBe('ok');
    expect(forge.bodies.get(TRACKER)).toContain('#11');
  });
});
