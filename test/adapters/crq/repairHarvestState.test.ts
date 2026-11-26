// The state bindings of the repair harvest: queue bytes equal Python's `atomic` output (the
// same Python process writes the reference file), the canonical-delivery root is the state
// directory's parent, and the replay budget carries Python's defaults.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repairHarvestState } from '../../../src/adapters/crq/repairHarvestState.js';
import { JsonNumber } from '../../../src/policy/crq/jsonValue.js';
import { oraclePython } from '../../helpers/oraclePython.js';

const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));
let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'crq-harvest-state-'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('repairHarvestState', () => {
  it('writes the queue with the bytes Python atomic writes, keeping a stamped float', async () => {
    const state = join(base, 'a', 'state');
    await mkdir(state, { recursive: true });
    const effects = repairHarvestState({ stateRoot: state });
    await effects.saveQueue({
      items: [{ id: 'x', replay_attempted: JsonNumber.float(1700000000), note: 'é☃' }],
      n: 3,
    });
    const reference = join(base, 'ref.json');
    execFileSync(
      oraclePython(),
      [
        '-I',
        '-c',
        'import sys; sys.path.insert(0, sys.argv[1]); from crq_repair import atomic; ' +
          'from pathlib import Path; ' +
          "atomic(Path(sys.argv[2]), {'items': [{'id': 'x', 'replay_attempted': 1700000000.0, 'note': 'é☃'}], 'n': 3})",
        APPS,
        reference,
      ],
      { encoding: 'utf8' },
    );
    const written = await readFile(join(state, 'queue.json'), 'utf8');
    expect(written).toBe(await readFile(reference, 'utf8'));
    expect(written).toContain('1700000000.0');
  });

  it('reads the canonical delivery row under the parent of the state directory', async () => {
    const state = join(base, 'b', 'state');
    const fid = 'b'.repeat(64);
    const triage = join(base, 'b', 'state', 'backfill', 'findings', 'triage');
    await mkdir(triage, { recursive: true });
    await writeFile(
      join(triage, `${fid}.json`),
      JSON.stringify({ status: 'delivered', receipt: { repair_task: 'crq-j' } }),
    );
    const effects = repairHarvestState({ stateRoot: state });
    await expect(
      effects.requireCanonicalDelivery({ job: 'crq-j', canonical_finding_id: fid }),
    ).resolves.toBeUndefined();
    await expect(
      effects.requireCanonicalDelivery({ job: 'crq-other', canonical_finding_id: fid }),
    ).rejects.toThrow('canonical finding is not delivered to this repair task');
  });

  it('binds a fresh budget per call with Python defaults (25 runs, 900 s retry)', () => {
    const first = repairHarvestState({ stateRoot: join(base, 'c', 'state') }).replayBudget;
    const second = repairHarvestState({ stateRoot: join(base, 'c', 'state') }).replayBudget;
    expect(first).not.toBe(second);
    let taken = 0;
    while (first?.take({})) taken += 1;
    expect(taken).toBe(25);
    expect(first?.announce()).toBe(
      'repair replay budget spent (25 runs / 240s): remaining failed runs resume next tick',
    );
    const record: Record<string, unknown> = {};
    expect(second?.take(record)).toBe(true);
    expect(second?.take(record)).toBe(false);
  });

  it('one effects object owns one budget: spent runs do not come back, a new object is a new tick', () => {
    const tick = repairHarvestState({ stateRoot: join(base, 'd', 'state') });
    while (tick.replayBudget?.take({})) {
      // spend the whole budget
    }
    expect(tick.replayBudget?.take({})).toBe(false);
    expect(repairHarvestState({ stateRoot: join(base, 'd', 'state') }).replayBudget?.take({})).toBe(
      true,
    );
  });
});
