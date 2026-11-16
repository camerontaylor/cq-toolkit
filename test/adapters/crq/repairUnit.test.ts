import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fileRepairUnit,
  REPAIR_UNIT_MISSING_EFFECTS,
} from '../../../src/adapters/crq/repairUnit.js';

async function unit(marker: boolean, narrated: string[] = []) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'repair-unit-'));
  if (marker) await writeFile(join(stateRoot, 'runner-disabled'), '');
  return {
    stateRoot,
    unit: fileRepairUnit({
      stateRoot,
      clone: join(stateRoot, 'clone'),
      narrate: (m) => narrated.push(m),
      entries: async () => [{ name: 'review.fixFinding' } as never],
    }),
  };
}

describe('fileRepairUnit', () => {
  it('reads the runner-disabled marker for run admission and gates alike', async () => {
    const off = await unit(false);
    expect(await off.unit.run.runnerDisabled()).toBe(false);
    expect(await off.unit.gates.runnerDisabled()).toBe(false);
    const on = await unit(true);
    expect(await on.unit.run.runnerDisabled()).toBe(true);
    expect(await on.unit.gates.runnerDisabled()).toBe(true);
  });

  it('re-reads the marker on every call, never caching it', async () => {
    const { stateRoot, unit: u } = await unit(false);
    expect(await u.run.runnerDisabled()).toBe(false);
    await writeFile(join(stateRoot, 'runner-disabled'), '');
    expect(await u.run.runnerDisabled()).toBe(true);
  });

  it('propagates a non-ENOENT marker error instead of treating it as enabled', async () => {
    const { stateRoot, unit: u } = await unit(false);
    // A file where the state dir's child path needs a directory: ENOTDIR.
    await writeFile(join(stateRoot, 'blocker'), '');
    const bad = fileRepairUnit({
      stateRoot: join(stateRoot, 'blocker'),
      clone: stateRoot,
      narrate: () => undefined,
    });
    await expect(bad.run.runnerDisabled()).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(u).toBeDefined();
  });

  it('shares one dispatch git/job seam between dispatch and run', async () => {
    const { unit: u } = await unit(false);
    expect(u.run.git).toBe(u.dispatch.git);
    expect(u.run.readPreparedJob).toBe(u.dispatch.readPreparedJob);
  });

  it('reads the prepared job from state/repair/inbox and rejects a bad id', async () => {
    const { stateRoot, unit: u } = await unit(false);
    await mkdir(join(stateRoot, 'repair', 'inbox'), { recursive: true });
    await writeFile(join(stateRoot, 'repair', 'inbox', 'crq-job-1.json'), '{"a":1}');
    expect(await u.dispatch.readPreparedJob('crq-job-1')).toBe('{"a":1}');
    await expect(u.dispatch.readPreparedJob('../x')).rejects.toThrow('invalid repair job id');
  });

  it('carries resume into the registry view', async () => {
    const { unit: u } = await unit(false);
    const fresh = await u.runOptions(false);
    expect(fresh.resume).toBe(false);
    expect(fresh.registry.get('review.fixFinding')?.name).toBe('review.fixFinding');
    expect((await u.runOptions(true)).resume).toBe(true);
  });

  it('forwards narration to the injected sink', async () => {
    const lines: string[] = [];
    const { unit: u } = await unit(false, lines);
    u.gates.narrate('hello');
    expect(lines).toEqual(['hello']);
  });

  it.each([true, false])('passes the plan resume=%s into the run options', async (resume) => {
    const { unit: u } = await unit(false);
    let reachedJobs = false;
    // The resume cross-check precedes any read of `plan.jobs`; reaching it means the
    // options built by `runJob` agreed with the plan.
    const plan = {
      resume,
      plan: {
        get jobs() {
          reachedJobs = true;
          return [];
        },
      },
    } as never;
    expect(await u.runJob(plan)).toEqual({ ok: false, refusal: 'attempt-inconsistent' });
    expect(reachedJobs).toBe(true);
  });

  it('lists the unbound drain effects', () => {
    expect(REPAIR_UNIT_MISSING_EFFECTS.map((e) => e.name)).toEqual([
      'DrainPassEffects.fetchClone',
      'DrainPassEffects.triage',
      'DrainPassEffects.items',
      'DrainPassEffects.halted',
      'DrainPassEffects.drainItem',
    ]);
  });
});
