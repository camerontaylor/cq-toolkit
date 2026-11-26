import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileRepairHarvestEffects,
  findingLedgerRoots,
} from '../../../src/adapters/crq/repairHarvestSource.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harvest-source-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('fileRepairHarvestEffects', () => {
  it('places the ledgers under STATE/backfill', () => {
    expect(findingLedgerRoots('/s')).toEqual({
      findings: '/s/backfill/findings',
      publication: '/s/backfill/publication',
    });
  });

  it('reads and writes triage rows under the findings root', async () => {
    const { files } = fileRepairHarvestEffects(root);
    const id = 'c'.repeat(64);
    expect(await files.readTriage(id)).toBeNull();
    await files.withLock(async () => files.writeTriage(id, new TextEncoder().encode('{}')));
    expect(await files.readTriage(id)).not.toBeNull();
  });

  it('fails closed when the rollout file is absent or invalid', async () => {
    const { publication } = fileRepairHarvestEffects(root);
    const message = 'backfill repair write-back requires existing ledger configuration';
    const valueError = new PyError('ValueError', message);
    await expect(publication.retained()).rejects.toEqual(valueError);
    await writeFile(join(root, 'backfill-rollout.json'), '{nope');
    await expect(publication.spool({} as never)).rejects.toMatchObject({ kind: 'ValueError' });
    await writeFile(
      join(root, 'backfill-rollout.json'),
      JSON.stringify({ durable_artifact_root: join(root, 'artifacts') }),
    );
    await expect(publication.retained()).rejects.toMatchObject({ kind: 'ValueError' });
  });

  it('binds the publication outbox once the rollout names an artifact root', async () => {
    await writeFile(
      join(root, 'backfill-rollout.json'),
      JSON.stringify({
        operational_ruling: 'r',
        no_live_run_verification: 'v',
        owner_branch_ruleset_evidence: 'e',
        durable_artifact_root: join(root, 'artifacts'),
        runner_identity: 'crq-runner-app',
        publisher_spool: { ssh_alias: 'p@h', ssh_key: 'k' },
      }),
    );
    expect(await fileRepairHarvestEffects(root).publication.retained()).toEqual([]);
  });

  it('propagates a non-ENOENT rollout read error', async () => {
    await mkdir(join(root, 'backfill-rollout.json'));
    await expect(fileRepairHarvestEffects(root).publication.retained()).rejects.toThrow();
  });
});
