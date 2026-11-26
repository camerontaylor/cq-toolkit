import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  backfillInventoryMode,
  readBackfillRollout,
} from '../../../src/adapters/crq/backfillRollout.js';

const complete = {
  operational_ruling: true,
  no_live_run_verification: true,
  owner_branch_ruleset_evidence: true,
  durable_artifact_root: '/artifacts',
  runner_identity: 'crq-runner-app',
  publisher_spool: { ssh_alias: 'runner@example.com', key: '/key' },
};

async function rootWith(config: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'backfill-rollout-'));
  if (config !== undefined)
    await writeFile(join(root, 'backfill-rollout.json'), JSON.stringify(config));
  return root;
}

describe('backfill rollout settings', () => {
  it('is null when no rollout is provisioned', async () => {
    const root = await rootWith(undefined);
    expect(await readBackfillRollout(root)).toBeNull();
    expect(await backfillInventoryMode(root)).toBeNull();
  });
  it('returns the inventory mode, or null when it is absent or not a string', async () => {
    expect(
      await backfillInventoryMode(await rootWith({ ...complete, inventory_mode: 'integrated' })),
    ).toBe('integrated');
    expect(await backfillInventoryMode(await rootWith(complete))).toBeNull();
    expect(
      await backfillInventoryMode(await rootWith({ ...complete, inventory_mode: 1 })),
    ).toBeNull();
  });
  it.each([
    ['a missing prerequisite', { ...complete, operational_ruling: false }],
    ['a wrong runner identity', { ...complete, runner_identity: 'someone-else' }],
    ['a non-object rollout', []],
  ])('refuses %s as incomplete, which the tick records as a halt', async (_name, config) => {
    await expect(backfillInventoryMode(await rootWith(config))).rejects.toThrow(
      'backfill rollout prerequisites incomplete',
    );
  });
  it('validates the publisher spool', async () => {
    await expect(
      readBackfillRollout(await rootWith({ ...complete, publisher_spool: { ssh_alias: 'x' } })),
    ).rejects.toThrow();
  });
});
