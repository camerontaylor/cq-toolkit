import { describe, expect, test } from 'vitest';
import { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import {
  BackfillRouteError,
  rolloutSettings,
  runBackfillInventory,
  type BackfillArtifactStore,
  type BackfillInventoryEffects,
} from '../../../src/ops/crq/backfillInventory.js';
import { captureFixtureManifest, loadFamily, valueAt } from '../../policy/crq/backfillFixtures.js';

const INVENTORY = loadFamily('backfill-inventory');

function firstInputs(): JsonObject {
  const vector = INVENTORY[0];
  if (vector === undefined) throw new Error('inventory vectors are empty');
  return valueAt(vector.input, 'inputs') as JsonObject;
}

const ROLLOUT = {
  enabled: true,
  operational_ruling: 'owner ruling: replay only',
  no_live_run_verification: 'verified',
  owner_branch_ruleset_evidence: 'evidence',
  durable_artifact_root: 'state/artifacts',
  runner_identity: 'crq-runner-app',
  publisher_spool: { ssh_alias: 'publisher@spool.example', ssh_key: '~/.ssh/spool' },
};

interface Recorder {
  readonly writes: Map<string, string>;
  readonly effects: BackfillInventoryEffects;
}

/**
 * The route's effects over an in-memory state root.
 *
 * `artifacts` serves the capture's snapshot payloads out of the vector, so a
 * successful run is the same replay the policy suite proves against the oracle.
 */
function memoryEffects(options: {
  readonly rollout?: unknown;
  readonly queue?: unknown;
  readonly baseline?: string | null;
  readonly triage?: ReadonlyArray<{ readonly file: string; readonly value: unknown }>;
}): Recorder {
  const writes = new Map<string, string>();
  const inputs = firstInputs();
  const store: BackfillArtifactStore = {
    async verify(reference) {
      if (typeof reference.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reference.sha256)) {
        throw new BackfillRouteError('invalid', 'artifact reference is malformed');
      }
    },
    async read(reference) {
      const key = reference.location.slice('fixture/'.length);
      const value = inputs.get(key);
      if (value === undefined) throw new Error(`missing snapshot ${key}`);
      return value;
    },
  };
  const queue =
    options.queue === undefined
      ? { backfill_last_manifest: captureFixtureManifest(inputs) }
      : options.queue;
  const effects: BackfillInventoryEffects = {
    readQueue: async () => JSON.stringify(queue),
    readRollout: async () =>
      options.rollout === undefined ? null : JSON.stringify(options.rollout),
    readBaseline: async () => options.baseline ?? null,
    readTriage: async () =>
      (options.triage ?? []).map((row) => ({
        file: row.file,
        bytes: new TextEncoder().encode(JSON.stringify(row.value)),
      })),
    artifacts: () => store,
    writeRanked: async (bytes) => {
      writes.set('latest-ranked.json', Buffer.from(bytes).toString('utf8'));
    },
    writeReport: async (bytes) => {
      writes.set('latest-report.json', Buffer.from(bytes).toString('utf8'));
    },
  };
  return { writes, effects };
}

describe('backfill inventory route', () => {
  test('the report-only replay writes both derived artifacts', async () => {
    const recorder = memoryEffects({ rollout: ROLLOUT });
    const result = await runBackfillInventory(['--report-only'], recorder.effects);
    expect(result.exitCode).toBe(0);
    expect(result.artifact.status).toBe('ok');
    const report = result.artifact.status === 'ok' ? result.artifact.value : undefined;
    expect(report).toMatchObject({ construction_debt: [], finding_triage: { counts: {} } });
    expect([...recorder.writes.keys()].sort()).toEqual([
      'latest-ranked.json',
      'latest-report.json',
    ]);
    const ranked = JSON.parse(recorder.writes.get('latest-ranked.json') ?? '{}') as {
      candidates: unknown[];
      manifest_id: string;
    };
    expect(ranked.manifest_id).toBe((captureFixtureManifest(firstInputs()) as { id: string }).id);
    expect(Array.isArray(ranked.candidates)).toBe(true);
  });

  test('an absent rollout configuration is refused before any replay', async () => {
    const recorder = memoryEffects({});
    const result = await runBackfillInventory(['--report-only'], recorder.effects);
    expect(result.exitCode).toBe(3);
    expect(result.artifact).toEqual({
      status: 'failed',
      error: 'owner-provisioned rollout configuration is absent',
    });
    expect(recorder.writes.size).toBe(0);
  });

  test('an incomplete rollout configuration is refused, never guessed', async () => {
    const recorder = memoryEffects({ rollout: { ...ROLLOUT, runner_identity: 'someone-else' } });
    const result = await runBackfillInventory(['--report-only'], recorder.effects);
    expect(result.exitCode).toBe(3);
    expect(result.artifact).toMatchObject({
      status: 'failed',
      error: 'backfill rollout prerequisites incomplete',
    });
    expect(recorder.writes.size).toBe(0);
  });

  test('the enqueue mode is refused and names the implemented form', async () => {
    const recorder = memoryEffects({ rollout: ROLLOUT });
    const result = await runBackfillInventory([], recorder.effects);
    expect(result.exitCode).toBe(3);
    const error = result.artifact.status === 'failed' ? result.artifact.error : '';
    expect(error).toContain('capture and subject construction');
    expect(error).toContain('--report-only');
    expect(recorder.writes.size).toBe(0);
  });

  test('an inventory enqueue on a disabled rollout names the rollout, not the capture', async () => {
    const recorder = memoryEffects({ rollout: { ...ROLLOUT, enabled: false } });
    const result = await runBackfillInventory([], recorder.effects);
    expect(result.exitCode).toBe(3);
    expect(result.artifact).toEqual({
      status: 'failed',
      error: 'operator rollout must be enabled before inventory enqueue',
    });
  });

  test('a pinned T0 baseline is refused instead of reported as unreviewed debt', async () => {
    const recorder = memoryEffects({ rollout: ROLLOUT, baseline: '{"id":"pinned"}' });
    const result = await runBackfillInventory(['--report-only'], recorder.effects);
    expect(result.exitCode).toBe(3);
    const error = result.artifact.status === 'failed' ? result.artifact.error : '';
    expect(error).toContain('git lineage/carry seam');
    expect(recorder.writes.size).toBe(0);
  });

  test('a queue without a retained manifest cannot replay a capture that never ran', async () => {
    const recorder = memoryEffects({ rollout: ROLLOUT, queue: { items: [] } });
    const result = await runBackfillInventory(['--report-only'], recorder.effects);
    expect(result.exitCode).toBe(3);
    expect(result.artifact).toEqual({
      status: 'failed',
      error: 'no retained inventory manifest; inventory capture has not run',
    });
  });

  test('a malformed queue is a refusal, not an empty queue', async () => {
    const recorder = memoryEffects({ rollout: ROLLOUT, queue: [] });
    const result = await runBackfillInventory(['--report-only'], recorder.effects);
    expect(result.exitCode).toBe(3);
    expect(result.artifact).toMatchObject({
      status: 'failed',
      error: 'queue.json is not an object',
    });
  });

  test('arguments are a usage error, distinct from a refusal', async () => {
    const recorder = memoryEffects({ rollout: ROLLOUT });
    expect((await runBackfillInventory(['--enqueue'], recorder.effects)).exitCode).toBe(2);
    expect(
      (await runBackfillInventory(['--report-only', '--report-only'], recorder.effects)).exitCode,
    ).toBe(2);
    const usage = await runBackfillInventory(['--enqueue'], recorder.effects);
    expect(usage.artifact).toEqual({ status: 'failed', error: 'unknown argument: --enqueue' });
  });

  test('a triage row the policy cannot read fails the run, never half-counts it', async () => {
    const recorder = memoryEffects({
      rollout: ROLLOUT,
      triage: [{ file: 'f1.json', value: { status: 7 } }],
    });
    const result = await runBackfillInventory(['--report-only'], recorder.effects);
    expect(result.exitCode).toBe(3);
    expect(result.artifact.status).toBe('failed');
    expect(recorder.writes.size).toBe(0);
  });

  test('the report counts a readable triage row', async () => {
    const recorder = memoryEffects({
      rollout: ROLLOUT,
      triage: [
        {
          file: 'f1.json',
          value: {
            status: 'needs-human',
            canonical_id: 'c1',
            target: 't1',
            finding: { id: 'f1', title: 't', severity: 'major', path: 'src/a.py' },
            failure_class: 'owner-decision',
          },
        },
      ],
    });
    const result = await runBackfillInventory(['--report-only'], recorder.effects);
    expect(result.exitCode).toBe(0);
    const report = result.artifact.status === 'ok' ? result.artifact.value : undefined;
    expect(report).toMatchObject({
      finding_triage: { counts: { 'needs-human': 1 }, owner_decisions_count: 1 },
    });
  });
});

describe('rollout prerequisites', () => {
  test('the durable artifact root and enabled flag are reported', () => {
    expect(rolloutSettings(ROLLOUT)).toEqual({
      durableArtifactRoot: 'state/artifacts',
      enabled: true,
    });
    expect(rolloutSettings({ ...ROLLOUT, enabled: false }).enabled).toBe(false);
  });

  test('a spool that is not exactly ssh_alias plus key is refused', () => {
    expect(() => rolloutSettings({ ...ROLLOUT, publisher_spool: { ssh_alias: 'a@b' } })).toThrow(
      'publisher_spool incomplete or invalid',
    );
    expect(() =>
      rolloutSettings({
        ...ROLLOUT,
        publisher_spool: { ...ROLLOUT.publisher_spool, password: 'x' },
      }),
    ).toThrow('publisher_spool incomplete or invalid');
    expect(() =>
      rolloutSettings({ ...ROLLOUT, publisher_spool: { ssh_alias: 'bad alias', ssh_key: 'k' } }),
    ).toThrow('publisher_spool incomplete or invalid');
    expect(() =>
      rolloutSettings({ ...ROLLOUT, publisher_spool: { ssh_alias: 'a@b', ssh_key: 'k\nk' } }),
    ).toThrow('publisher_spool incomplete or invalid');
  });

  test('a rollout without an explicit enabled flag is not treated as enabled', () => {
    const { enabled, ...rest } = ROLLOUT;
    expect(enabled).toBe(true);
    expect(rolloutSettings(rest).enabled).toBe(false);
  });
});
