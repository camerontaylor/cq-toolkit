/**
 * Offline integration tests for the crq repair-prepare ops helper.
 *
 * Every case runs against the oracle fixture generated from the PRODUCTION
 * Python `bounded.py` and `prepare_current_job` with faked effects. The only
 * external seam is a recording fake `RepairGit`; no process, filesystem
 * write, clock or network participates. The tests pin the exact git read
 * order, the proposed job/run-record bytes, the prepared-id idempotence path
 * (including that it precedes the round ceiling), the typed refusal codes,
 * the pending effect gates, and both harvest checks.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  reobservePreparedSource,
  verifyPreparedHarvest,
  verifyPreparedRepair,
  type PendingPreparationGate,
  type RepairGit,
} from '../../../src/ops/crq/internal/repairPrepare.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import type { RepairRefusal } from '../../../src/policy/crq/repairBinding.js';
import { atomicJsonText } from '../../../src/policy/crq/pythonJson.js';
import type { FixFindingBinding } from '../../../src/ops/review/fixFinding.js';

const SOURCE = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
const BLOB = 'c'.repeat(40);

const FIXTURE_URL = new URL(
  '../../../apps/crq-python/fixtures/repair-prepare/cases.json',
  import.meta.url,
);
const fixture = asObject(parseJsonValue(readFileSync(FIXTURE_URL, 'utf8')));

function asObject(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('expected a JSON object');
  return value;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new Error('expected a JSON array');
  return value;
}

function asString(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error('expected a JSON string');
  return value;
}

function asBoolean(value: JsonValue | undefined): boolean {
  if (typeof value !== 'boolean') throw new Error('expected a JSON boolean');
  return value;
}

function asNumber(value: JsonValue | undefined): number {
  if (!(value instanceof JsonNumber)) throw new Error('expected a JSON number');
  if (value.kind === 'int') {
    if (value.integer === null) throw new Error('integer value missing');
    return Number(value.integer);
  }
  if (value.float === null) throw new Error('float value missing');
  return value.float;
}

function callList(value: JsonValue | undefined): string[][] {
  return asArray(value).map((call) => asArray(call).map(asString));
}

function prepareCase(name: string): JsonObject {
  const found = asArray(fixture.get('prepare_cases')).find(
    (candidate) => asObject(candidate).get('name') === name,
  );
  return asObject(found);
}

function harvestCase(name: string): JsonObject {
  const found = asArray(fixture.get('harvest_cases')).find(
    (candidate) => asObject(candidate).get('name') === name,
  );
  return asObject(found);
}

type GitFailure = 'tip' | 'blob';

function fakeGit(input: {
  readonly tip: string;
  readonly blob: string;
  readonly fail?: GitFailure;
}): RepairGit & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async currentTip(): Promise<string> {
      calls.push(['rev-parse', 'origin/main']);
      if (input.fail === 'tip') throw new Error('synthetic tip failure');
      return input.tip;
    },
    async blobOid(sourceSha: string, path: string): Promise<string> {
      calls.push(['rev-parse', `${sourceSha}:${path}`]);
      if (input.fail === 'blob') throw new Error('synthetic blob failure');
      return input.blob;
    },
  };
}

function verifyInput(row: JsonObject): Parameters<typeof verifyPreparedRepair>[0] {
  const input = asObject(row.get('input'));
  const round = asObject(input.get('round_count'));
  const basis = asString(round.get('basis'));
  if (basis !== 'canonical-finding' && basis !== 'pr-pin') {
    throw new Error('fixture round basis is invalid');
  }
  return {
    oldJobJson: asString(input.get('old_job_json')),
    oldJobId: asString(input.get('old_job_id')),
    queueItemJson: asString(input.get('queue_item_json')),
    sourceSha: asString(input.get('source_sha')),
    evidenceJson: asString(input.get('evidence_json')),
    roundCount: { basis, count: asNumber(round.get('count')) },
    maxRoundsPerPin: asNumber(input.get('max_rounds_per_pin')),
    ...(asBoolean(input.get('preserve_worktree')) ? { preserveWorktree: true } : {}),
  };
}

function fixtureGit(
  row: JsonObject,
  fail?: GitFailure,
): RepairGit & { readonly calls: string[][] } {
  const input = asObject(row.get('input'));
  return fakeGit({
    tip: asString(input.get('current_tip')),
    blob: asString(input.get('blob_oid')),
    ...(fail === undefined ? {} : { fail }),
  });
}

const EXPECTED_REFUSAL: Record<string, RepairRefusal> = {
  'refuse-old-job-identity': 'old-job-identity-mismatch',
  'refuse-source-sha-invalid': 'source-sha-invalid',
  'refuse-source-not-tip': 'source-not-current-tip',
  'refuse-legacy-minor': 'severity-not-repairable',
  'refuse-path-absolute': 'finding-path-invalid',
  'refuse-blob-mismatch': 'source-blob-mismatch',
  'refuse-blob-unreadable': 'source-blob-unreadable',
  'refuse-finding-digest': 'finding-digest-mismatch',
  'refuse-verdict': 'verdict-not-still-valid',
  'refuse-reviewer-empty': 'evidence-text-invalid',
  'refuse-reason-too-long': 'evidence-text-invalid',
  'refuse-instructions-empty': 'instructions-invalid',
  'refuse-instructions-too-long': 'instructions-invalid',
  'refuse-instructions-nul': 'instructions-invalid',
  'refuse-round-ceiling': 'round-ceiling',
  'refuse-lineage-missing': 'old-job-not-tick-owned',
};

const EXPECTED_GATES: Record<string, readonly PendingPreparationGate[]> = {
  'major-no-instructions': ['full-source-secret-scan', 'atomic-state-writes'],
  'major-with-instructions': [
    'full-source-secret-scan',
    'fix-instructions-secret-scan',
    'instruction-utf16-dispatch-check',
    'atomic-state-writes',
  ],
  'preserve-worktree': [
    'full-source-secret-scan',
    'old-record-stale-marking',
    'atomic-state-writes',
  ],
  'canonical-minor-round-one': [
    'full-source-secret-scan',
    'canonical-delivery-handoff',
    'old-record-stale-marking',
    'atomic-state-writes',
  ],
  'lossless-extras': ['full-source-secret-scan', 'atomic-state-writes'],
  'non-bmp-reviewer-and-instructions': [
    'full-source-secret-scan',
    'fix-instructions-secret-scan',
    'instruction-utf16-dispatch-check',
    'atomic-state-writes',
  ],
};

describe('verifyPreparedRepair against the Python oracle', () => {
  for (const row of asArray(fixture.get('prepare_cases')).map(asObject)) {
    const name = asString(row.get('name'));
    test(name, async () => {
      const input = verifyInput(row);
      const git = fixtureGit(row, name === 'refuse-blob-unreadable' ? 'blob' : undefined);
      const result = await verifyPreparedRepair(input, git);
      const expectedCalls = callList(row.get('git_calls'));

      if (!asBoolean(row.get('ok'))) {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const expected = EXPECTED_REFUSAL[name];
        if (expected === undefined) throw new Error(`no refusal expectation for ${name}`);
        expect(result.refusal).toBe(expected);
        expect(git.calls).toEqual(expectedCalls);
        // Refusals never mutate the historical job.
        expect(asBoolean(row.get('old_job_bytes_unchanged'))).toBe(true);
        return;
      }

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(git.calls).toEqual(expectedCalls);
      expect(result.value.status).toBe('binding-verified');
      expect(result.value.idempotent).toBe(false);
      expect(result.value.jobId).toBe(asString(row.get('job_id')));
      expect(result.value.run).toBe(asString(row.get('run')));
      expect(result.value.findingSha256).toBe(asString(row.get('finding_sha256')));
      expect(result.value.revalidationSha256).toBe(asString(row.get('revalidation_sha256')));
      expect(result.value.pendingGates).toEqual(EXPECTED_GATES[name]);

      const evidence = asObject(parseJsonValue(input.evidenceJson));
      expect(result.value.binding).toEqual({
        job: asString(row.get('job_id')),
        sourceSha: input.sourceSha,
        sourceBlobSha: asString(evidence.get('source_blob_sha')),
        findingSha256: asString(row.get('finding_sha256')),
        repairBase: input.sourceSha,
      });

      const job = result.value.job;
      const record = result.value.record;
      if (job === undefined || record === undefined) throw new Error('proposal missing');
      expect(atomicJsonText(job)).toBe(asString(row.get('job_bytes')));
      expect(atomicJsonText(record)).toBe(asString(row.get('record_bytes')));
      if (name === 'preserve-worktree') {
        expect(job.get('recovery_worktree')).toBe(true);
      }
      if (name === 'canonical-minor-round-one') {
        expect(record.get('canonical_finding_id')).toBe('f'.repeat(64));
        expect(job.get('canonical_finding_id')).toBe('f'.repeat(64));
      }

      // Prepared-id idempotence precedes the round ceiling: pass a count at
      // the ceiling and still get the existing prepared id back.
      const queueItem = asObject(parseJsonValue(input.queueItemJson));
      const runs = asObject(queueItem.get('repair_runs'));
      const updated = new JsonObject(
        queueItem.entries.map(([key, value]) => [
          key,
          key === 'repair_runs'
            ? new JsonObject([...runs.entries, [result.value.run, record]])
            : value,
        ]),
      );
      const secondGit = fixtureGit(row);
      const second = await verifyPreparedRepair(
        {
          ...input,
          queueItemJson: atomicJsonText(updated),
          roundCount: { basis: input.roundCount.basis, count: input.maxRoundsPerPin },
        },
        secondGit,
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.idempotent).toBe(true);
      expect(second.value.job).toBeUndefined();
      expect(second.value.jobId).toBe(asString(row.get('second_job_id')));
      expect(secondGit.calls).toEqual(callList(row.get('idempotent_git_calls')));
      const secondRecord = second.value.record;
      if (secondRecord === undefined) throw new Error('idempotent record missing');
      expect(atomicJsonText(secondRecord)).toBe(asString(row.get('record_bytes')));
    });
  }
});

describe('malformed inputs refuse before or without a git read', () => {
  const row = prepareCase('major-no-instructions');
  const input = verifyInput(row);

  test('old job text must be an object', async () => {
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(await verifyPreparedRepair({ ...input, oldJobJson: '[]' }, git)).toEqual({
      ok: false,
      refusal: 'old-job-unreadable',
    });
    expect(git.calls).toEqual([]);
  });

  test('queue item text must be an object', async () => {
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(await verifyPreparedRepair({ ...input, queueItemJson: '[]' }, git)).toEqual({
      ok: false,
      refusal: 'queue-item-unreadable',
    });
    expect(git.calls).toEqual([]);
  });

  test('evidence text must be an object', async () => {
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(await verifyPreparedRepair({ ...input, evidenceJson: '[]' }, git)).toEqual({
      ok: false,
      refusal: 'evidence-unreadable',
    });
    expect(git.calls).toEqual([]);
  });

  test('historical source must be an object when present', async () => {
    const old = asObject(parseJsonValue(input.oldJobJson));
    const changed = new JsonObject(
      old.entries.map(([key, value]) => [key, key === 'source' ? 'not-an-object' : value]),
    );
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await verifyPreparedRepair({ ...input, oldJobJson: atomicJsonText(changed) }, git),
    ).toEqual({ ok: false, refusal: 'old-job-unreadable' });
    expect(git.calls).toEqual([
      ['rev-parse', 'origin/main'],
      ['rev-parse', `${SOURCE}:src/lock.ts`],
    ]);
  });

  test('historical run identity is required for lineage', async () => {
    const old = asObject(parseJsonValue(input.oldJobJson));
    const changed = new JsonObject(old.entries.filter(([key]) => key !== 'run'));
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await verifyPreparedRepair({ ...input, oldJobJson: atomicJsonText(changed) }, git),
    ).toEqual({ ok: false, refusal: 'old-job-unreadable' });
    expect(git.calls).toHaveLength(2);
  });

  test('repair_runs must be an object', async () => {
    const item = asObject(parseJsonValue(input.queueItemJson));
    const changed = new JsonObject(
      item.entries.map(([key, value]) => [key, key === 'repair_runs' ? [] : value]),
    );
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await verifyPreparedRepair({ ...input, queueItemJson: atomicJsonText(changed) }, git),
    ).toEqual({ ok: false, refusal: 'queue-item-unreadable' });
    expect(git.calls).toHaveLength(2);
  });

  test('tick-owned jobs must be an array containing the historical id', async () => {
    const item = asObject(parseJsonValue(input.queueItemJson));
    const runs = asObject(item.get('repair_runs'));
    const oldRun = asObject(runs.get('old-run'));
    const changedRun = new JsonObject(
      oldRun.entries.map(([key, value]) => [key, key === 'jobs' ? 'crq-historical-F1' : value]),
    );
    const changed = new JsonObject(
      item.entries.map(([key, value]) => [
        key,
        key === 'repair_runs' ? new JsonObject([['old-run', changedRun]]) : value,
      ]),
    );
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await verifyPreparedRepair({ ...input, queueItemJson: atomicJsonText(changed) }, git),
    ).toEqual({ ok: false, refusal: 'old-job-not-tick-owned' });
  });

  test('the queue item id must match the historical item', async () => {
    const item = asObject(parseJsonValue(input.queueItemJson));
    const changed = new JsonObject(
      item.entries.map(([key, value]) => [key, key === 'id' ? 'other-item' : value]),
    );
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await verifyPreparedRepair({ ...input, queueItemJson: atomicJsonText(changed) }, git),
    ).toEqual({ ok: false, refusal: 'old-job-item-missing' });
  });
});

describe('round-count evidence', () => {
  const row = prepareCase('major-no-instructions');
  const input = verifyInput(row);

  test('rejects an invalid count, basis or ceiling', async () => {
    const cases: Array<[typeof input.roundCount, number, RepairRefusal]> = [
      [{ basis: 'canonical-finding', count: 0 }, 2, 'round-count-invalid'],
      [{ basis: 'pr-pin', count: -1 }, 2, 'round-count-invalid'],
      [{ basis: 'pr-pin', count: 0.5 }, 2, 'round-count-invalid'],
      [{ basis: 'pr-pin', count: 0 }, -1, 'round-count-invalid'],
      [{ basis: 'pr-pin', count: 0 }, Number.NaN, 'round-count-invalid'],
      [{ basis: 'pr-pin', count: 1 }, 1, 'round-ceiling'],
    ];
    for (const [roundCount, maxRoundsPerPin, refusal] of cases) {
      const git = fakeGit({ tip: SOURCE, blob: BLOB });
      const result = await verifyPreparedRepair({ ...input, roundCount, maxRoundsPerPin }, git);
      expect(result).toEqual({ ok: false, refusal });
      expect(git.calls).toHaveLength(2);
    }
  });

  test('canonical findings require the canonical basis and vice versa', async () => {
    const canonicalRow = prepareCase('canonical-minor-round-one');
    const canonicalInput = verifyInput(canonicalRow);
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await verifyPreparedRepair(
        { ...canonicalInput, roundCount: { basis: 'pr-pin', count: 0 } },
        git,
      ),
    ).toEqual({ ok: false, refusal: 'round-count-invalid' });
  });
});

describe('harvest checks against the Python oracle', () => {
  for (const row of asArray(fixture.get('harvest_cases')).map(asObject)) {
    const name = asString(row.get('name'));
    test(name, async () => {
      const prepared = asObject(parseJsonValue(asString(row.get('prepared_json'))));
      const preparedSource = prepared.get('source_sha');
      const expected = asObject(row.get('expect'));
      const git = fakeGit({ tip: SOURCE, blob: BLOB });
      const result = await verifyPreparedHarvest(
        {
          format: 'legacy-python',
          preparedJson: asString(row.get('prepared_json')),
          artifactJson: asString(row.get('result_json')),
          allowMissingPreparedSourceSha: asBoolean(row.get('allow_missing_prepared_source_sha')),
        },
        git,
      );
      if (asBoolean(expected.get('accepted'))) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.binding).toBe('verified');
        if (typeof preparedSource !== 'string') {
          expect(result.value.source).toEqual({ observed: false });
          expect(git.calls).toEqual([]);
        } else {
          expect(result.value.source).toEqual({
            observed: true,
            currentTip: SOURCE,
            blobOid: BLOB,
            atTip: true,
            blobMatches: true,
          });
          expect(git.calls).toEqual([
            ['rev-parse', 'origin/main'],
            ['rev-parse', `${SOURCE}:src/lock.ts`],
          ]);
        }
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.refusal).toBe(
          name === 'legacy-result-job-mismatch'
            ? 'result-identity-mismatch'
            : 'result-binding-mismatch',
        );
        // Binding refusal happens before any current-state reobservation.
        expect(git.calls).toEqual([]);
      }
    });
  }

  test('legacy missing source sha requires the explicit opt-in', async () => {
    const row = harvestCase('legacy-missing-prepared-source-sha');
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await verifyPreparedHarvest(
        {
          format: 'legacy-python',
          preparedJson: asString(row.get('prepared_json')),
          artifactJson: asString(row.get('result_json')),
          allowMissingPreparedSourceSha: false,
        },
        git,
      ),
    ).toEqual({ ok: false, refusal: 'legacy-source-sha-missing' });
    expect(git.calls).toEqual([]);
  });
});

describe('typed fixFinding harvest', () => {
  const prepared: FixFindingBinding = {
    job: 'crq-revalidated-x-F1',
    sourceSha: SOURCE,
    sourceBlobSha: BLOB,
    findingSha256: 'f'.repeat(64),
    repairBase: SOURCE,
  };
  const echo = new JsonObject([
    ['job', prepared.job],
    ['sourceSha', prepared.sourceSha],
    ['sourceBlobSha', prepared.sourceBlobSha],
    ['findingSha256', prepared.findingSha256],
    ['repairBase', prepared.repairBase],
  ]);
  const artifact = atomicJsonText(new JsonObject([['binding', echo]]));
  const input = {
    format: 'fixFinding' as const,
    prepared,
    artifactJson: artifact,
    path: 'src/lock.ts',
  };

  test('verifies a complete echo and reobserves current state', async () => {
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    const result = await verifyPreparedHarvest(input, git);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.binding).toBe('verified');
    expect(result.value.source).toEqual({
      observed: true,
      currentTip: SOURCE,
      blobOid: BLOB,
      atTip: true,
      blobMatches: true,
    });
    expect(git.calls).toEqual([
      ['rev-parse', 'origin/main'],
      ['rev-parse', `${SOURCE}:src/lock.ts`],
    ]);
  });

  test('reports a moved tip and a changed blob without rewriting either', async () => {
    const moved = await verifyPreparedHarvest(input, fakeGit({ tip: OTHER, blob: BLOB }));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.source).toMatchObject({ atTip: false, blobMatches: true });

    const changed = await verifyPreparedHarvest(input, fakeGit({ tip: SOURCE, blob: OTHER }));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.source).toMatchObject({ atTip: true, blobMatches: false });
  });

  test('a failed observation is reported, not fabricated', async () => {
    const failed = await verifyPreparedHarvest(
      input,
      fakeGit({ tip: SOURCE, blob: BLOB, fail: 'tip' }),
    );
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.source).toEqual({ observed: false });
  });

  test('without a path only the tip is observed', async () => {
    const withoutPath = {
      format: input.format,
      prepared: input.prepared,
      artifactJson: input.artifactJson,
    };
    const result = await verifyPreparedHarvest(withoutPath, fakeGit({ tip: SOURCE, blob: BLOB }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toEqual({
      observed: true,
      currentTip: SOURCE,
      blobOid: null,
      atTip: true,
      blobMatches: false,
    });
  });

  test('missing or mismatched echoes refuse before reobservation', async () => {
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(await verifyPreparedHarvest({ ...input, artifactJson: '{"status":"ok"}' }, git)).toEqual(
      { ok: false, refusal: 'fixfinding-result-binding-missing' },
    );
    const missingField = new JsonObject(echo.entries.filter(([key]) => key !== 'repairBase'));
    expect(
      await verifyPreparedHarvest(
        {
          ...input,
          artifactJson: atomicJsonText(new JsonObject([['binding', missingField]])),
        },
        git,
      ),
    ).toEqual({ ok: false, refusal: 'fixfinding-result-binding-missing' });
    const wrong = new JsonObject(
      echo.entries.map(([key, value]) => [key, key === 'repairBase' ? OTHER : value]),
    );
    expect(
      await verifyPreparedHarvest(
        {
          ...input,
          artifactJson: atomicJsonText(new JsonObject([['binding', wrong]])),
        },
        git,
      ),
    ).toEqual({ ok: false, refusal: 'fixfinding-result-binding-mismatch' });
    expect(git.calls).toEqual([]);
  });
});

describe('reobservePreparedSource', () => {
  test('an invalid path or a failed tip read is unobserved', async () => {
    const invalid = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await reobservePreparedSource(
        { sourceSha: SOURCE, sourceBlobSha: BLOB, path: '../escape' },
        invalid,
      ),
    ).toEqual({ observed: false });
    expect(invalid.calls).toEqual([]);

    const failed = fakeGit({ tip: SOURCE, blob: BLOB, fail: 'tip' });
    expect(
      await reobservePreparedSource(
        { sourceSha: SOURCE, sourceBlobSha: BLOB, path: 'src/lock.ts' },
        failed,
      ),
    ).toEqual({ observed: false });
  });

  test('an invalid source sha observes the tip but no blob', async () => {
    const git = fakeGit({ tip: SOURCE, blob: BLOB });
    expect(
      await reobservePreparedSource(
        { sourceSha: 'not-a-sha', sourceBlobSha: BLOB, path: 'src/lock.ts' },
        git,
      ),
    ).toEqual({
      observed: true,
      currentTip: SOURCE,
      blobOid: null,
      atTip: false,
      blobMatches: false,
    });
    expect(git.calls).toEqual([['rev-parse', 'origin/main']]);
  });
});
