/**
 * Injected executor tests for the crq repair harvest outcome.
 *
 * The merged bridge hands over a `RepairArtifactRead` for one exact run; the
 * executor must map its typed contract disposition, recover the retained
 * chain, and write one canonical event/row through the existing inbox and
 * publication seams. No filesystem root, real lock, outbox or model is bound:
 * both seams are in-memory. The oracle parity of the canonical bytes lives in
 * `test/policy/crq/repairHarvest.test.ts`.
 */
import { describe, expect, test } from 'vitest';
import {
  executeRepairHarvest,
  repairHarvestVerdictOf,
} from '../../../src/ops/crq/internal/repairHarvestExecution.js';
import type { RepairArtifactRead } from '../../../src/ops/crq/internal/repairDispatch.js';
import type { RepairSourceReobservation } from '../../../src/ops/crq/internal/repairPrepare.js';
import { ledgerCanonicalBytes, ledgerLoads } from '../../../src/policy/crq/ledger.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import type {
  FindingInboxFiles,
  FindingPublication,
} from '../../../src/ops/review/internal/crq/findingInbox.js';

const FINDING = 'a'.repeat(64);
const REVIEW = 'b'.repeat(64);
const JOB = 'crq-repair-F1';
const BASE = 'c'.repeat(40);
const COMMIT = 'd'.repeat(40);
const AT = '2026-11-12T00:00:00Z';
const MAX_RETRIES = 2;

const SOURCE: RepairSourceReobservation = {
  observed: true,
  currentTip: BASE,
  blobOid: 'e'.repeat(40),
  atTip: true,
  blobMatches: true,
};

function json(value: unknown): JsonValue {
  return parseJsonValue(JSON.stringify(value));
}

function object(value: unknown): JsonObject {
  const parsed = json(value);
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

function row(overrides: Record<string, unknown> = {}): JsonObject {
  return object({
    review_id: REVIEW,
    finding: { id: FINDING },
    canonical_id: FINDING,
    previous_event_id: null,
    status: 'delivered',
    receipt: { repair_task: JOB },
    ...overrides,
  });
}

class MemoryFiles implements FindingInboxFiles {
  readonly rows = new Map<string, Uint8Array>();
  locks = 0;
  writes = 0;
  constructor(initial?: JsonObject) {
    if (initial !== undefined) this.rows.set(FINDING, ledgerCanonicalBytes(initial));
  }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.locks += 1;
    return fn();
  }
  async readTriage(findingId: string): Promise<Uint8Array | null> {
    return this.rows.get(findingId) ?? null;
  }
  async writeTriage(findingId: string, bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    this.rows.set(findingId, bytes);
  }
  current(findingId = FINDING): JsonObject {
    const bytes = this.rows.get(findingId);
    if (bytes === undefined) throw new Error('row missing');
    const value = ledgerLoads(bytes);
    if (!(value instanceof JsonObject)) throw new Error('row is not an object');
    return value;
  }
}

class MemoryPublication implements FindingPublication {
  readonly events: JsonValue[] = [];
  async retained(): Promise<JsonValue[]> {
    return [...this.events];
  }
  async spool(value: JsonValue): Promise<string> {
    this.events.push(value);
    if (!(value instanceof JsonObject)) throw new Error('event is not an object');
    const id = value.get('id');
    if (typeof id !== 'string') throw new Error('event id missing');
    return id;
  }
}

function okRead(value: unknown, binding: 'verified' | 'not-ok' = 'verified'): RepairArtifactRead {
  return {
    selectedJobId: JOB,
    artifactJson: JSON.stringify(value),
    artifact: object({ status: 'ok', value }),
    harvest: { status: 'ok', value: json(value) },
    binding,
    source: SOURCE,
  };
}

function contract(overrides: Record<string, unknown>): RepairArtifactRead {
  return okRead({
    kind: 'outcome',
    disposition: 'fixed',
    evidenceMissing: false,
    summary: 'summary',
    commits: [],
    evidence: [],
    binding: {},
    denials: [],
    ...overrides,
  });
}

function failedRead(
  status: 'failed' | 'needs-human' | 'budget-exhausted' | 'indeterminate',
  failureClass: 'transient' | 'exhausted' | 'evidence',
): RepairArtifactRead {
  const report = { failureClass };
  const artifact =
    status === 'failed'
      ? { status, error: 'worker failed', report }
      : status === 'needs-human'
        ? { status, reason: 'unknown provider handle', report }
        : status === 'budget-exhausted'
          ? { status, report }
          : { status, detail: 'worker lost', report };
  const harvest =
    status === 'failed'
      ? { status, failureClass, error: 'worker failed', report }
      : status === 'needs-human'
        ? { status, failureClass, reason: 'unknown provider handle', report }
        : status === 'budget-exhausted'
          ? { status, failureClass, report }
          : { status, failureClass, detail: 'worker lost', report };
  return {
    selectedJobId: JOB,
    artifactJson: JSON.stringify(artifact),
    artifact: object(artifact),
    harvest: harvest as RepairArtifactRead['harvest'],
    binding: 'not-ok',
    source: SOURCE,
  };
}

function effects(files: MemoryFiles, publication: MemoryPublication) {
  return { files, publication };
}

describe('repair harvest verdict mapping', () => {
  test('typed contract dispositions, never the summary prose', () => {
    const fixed = repairHarvestVerdictOf(contract({ disposition: 'fixed', commits: [COMMIT] }));
    expect(fixed).toMatchObject({ kind: 'verdict', verdict: { verdict: 'fixed' } });
    const owner = repairHarvestVerdictOf(contract({ disposition: 'needs_human' }));
    expect(owner).toMatchObject({
      kind: 'verdict',
      verdict: { verdict: 'failed', failureClass: 'owner-decision' },
    });
    const noOutcome = repairHarvestVerdictOf(contract({ disposition: 'no_outcome' }));
    expect(noOutcome).toMatchObject({
      kind: 'verdict',
      verdict: { verdict: 'failed', failureClass: 'exhausted' },
    });
    const missing = repairHarvestVerdictOf(
      contract({ disposition: 'unchanged_with_reason', evidenceMissing: true, evidence: [] }),
    );
    expect(missing).toMatchObject({
      kind: 'verdict',
      verdict: { verdict: 'failed', failureClass: 'exhausted' },
    });
    const cited = repairHarvestVerdictOf(
      contract({
        disposition: 'unchanged_with_reason',
        evidenceMissing: false,
        evidence: [{ path: 'src/a.ts', line: 2 }],
      }),
    );
    expect(cited).toMatchObject({
      kind: 'verdict',
      verdict: { verdict: 'not-fixed', evidence: [{ path: 'src/a.ts', line: 2 }] },
    });
  });

  test('non-ok artifacts are dispatch failures, never owner decisions', () => {
    for (const status of ['failed', 'needs-human', 'budget-exhausted', 'indeterminate'] as const) {
      const mapped = repairHarvestVerdictOf(failedRead(status, 'transient'));
      expect(mapped).toMatchObject({
        kind: 'verdict',
        verdict: { verdict: 'failed', failureClass: 'transient' },
      });
    }
  });
});

describe('repair harvest execution', () => {
  test('an owner-decision contract writes needs-human with the owner class', async () => {
    const files = new MemoryFiles(row());
    const publication = new MemoryPublication();
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: contract({ disposition: 'needs_human', summary: 'architectural choice' }),
        at: AT,
        maxFindingRetries: MAX_RETRIES,
        repairBase: BASE,
      },
      effects(files, publication),
    );
    expect(result.kind).toBe('written');
    if (result.kind === 'written') expect(result.action).toBe('needs-human');
    expect(publication.events).toHaveLength(1);
    const event = publication.events[0] as JsonObject;
    const payload = event.get('payload') as JsonObject;
    expect(toPlainJson(payload.get('evidence') ?? null)).toMatchObject({
      failure_class: 'owner-decision',
      repair_task: JOB,
      repair_base: BASE,
      fix_pr: null,
    });
    expect(files.current().get('status')).toBe('needs-human');
    expect(files.current().get('failure_class')).toBe('owner-decision');
  });

  test('a retriable failure writes needs-retriage with its typed class', async () => {
    const files = new MemoryFiles(row());
    const publication = new MemoryPublication();
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: failedRead('failed', 'transient'),
        at: AT,
        maxFindingRetries: MAX_RETRIES,
        repairBase: BASE,
      },
      effects(files, publication),
    );
    expect(result.kind).toBe('written');
    if (result.kind === 'written') expect(result.action).toBe('needs-retriage');
    expect(files.current().get('failure_class')).toBe('transient');
  });

  test('evidence-bearing unchanged_with_reason dismisses with source evidence', async () => {
    const files = new MemoryFiles(row());
    const publication = new MemoryPublication();
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: contract({
          disposition: 'unchanged_with_reason',
          summary: 'already fixed upstream',
          evidenceMissing: false,
          evidence: [{ path: 'src/a.ts', line: 2 }],
        }),
        at: AT,
        maxFindingRetries: MAX_RETRIES,
        repairBase: BASE,
      },
      effects(files, publication),
    );
    expect(result.kind).toBe('written');
    if (result.kind === 'written') expect(result.action).toBe('dismissed');
    const event = publication.events[0] as JsonObject;
    const payload = event.get('payload') as JsonObject;
    expect(
      toPlainJson((payload.get('evidence') as JsonObject).get('source_evidence') ?? null),
    ).toEqual([{ path: 'src/a.ts', line: 2 }]);
  });

  test('a pre-merge FIXED outcome writes nothing and touches no row', async () => {
    const files = new MemoryFiles(row());
    const publication = new MemoryPublication();
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: contract({ disposition: 'fixed', commits: [COMMIT] }),
        at: AT,
        maxFindingRetries: MAX_RETRIES,
        repairBase: BASE,
      },
      effects(files, publication),
    );
    expect(result).toMatchObject({ kind: 'none', reason: 'fixed-requires-merge' });
    expect(publication.events).toEqual([]);
    expect(files.writes).toBe(0);
    expect(files.locks).toBe(0);
  });

  test('a FIXED outcome requires the verified exact-run binding', async () => {
    const files = new MemoryFiles(row());
    const publication = new MemoryPublication();
    const read = contract({ disposition: 'fixed', commits: [COMMIT] });
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: { ...read, binding: 'not-ok' },
        at: AT,
        maxFindingRetries: MAX_RETRIES,
        repairBase: BASE,
        mergedCommit: COMMIT,
        fixPr: 7,
      },
      effects(files, publication),
    );
    expect(result).toEqual({ kind: 'refused', refusal: 'fixed-binding-unverified' });
    expect(publication.events).toEqual([]);
  });

  test('a merged FIXED outcome writes fixed with commit and verification', async () => {
    const files = new MemoryFiles(row());
    const publication = new MemoryPublication();
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: contract({ disposition: 'fixed', commits: [COMMIT], summary: 'verified merge' }),
        at: AT,
        maxFindingRetries: MAX_RETRIES,
        repairBase: BASE,
        mergedCommit: COMMIT,
        fixPr: 7,
      },
      effects(files, publication),
    );
    expect(result.kind).toBe('written');
    if (result.kind === 'written') expect(result.action).toBe('fixed');
    const event = publication.events[0] as JsonObject;
    const payload = event.get('payload') as JsonObject;
    expect(toPlainJson(payload.get('evidence') ?? null)).toMatchObject({
      fixing_commit: COMMIT,
      verification: 'verified merge',
      fix_pr: 7,
    });
  });

  test('a guard-refused bridge read has no worker verdict to record', async () => {
    const files = new MemoryFiles(row());
    const publication = new MemoryPublication();
    const read = contract({});
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: { ...read, harvest: { status: 'guard-refused', refusal: 'attempt-inconsistent' } },
        at: AT,
        maxFindingRetries: MAX_RETRIES,
      },
      effects(files, publication),
    );
    expect(result).toEqual({ kind: 'refused', refusal: 'harvest-invocation-refused' });
    expect(publication.events).toEqual([]);
    expect(files.writes).toBe(0);
  });

  test('a missing triage row is a typed refusal', async () => {
    const files = new MemoryFiles();
    const publication = new MemoryPublication();
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: failedRead('failed', 'exhausted'),
        at: AT,
        maxFindingRetries: MAX_RETRIES,
      },
      effects(files, publication),
    );
    expect(result).toEqual({ kind: 'refused', refusal: 'finding-row-missing' });
  });

  test('replay after spool recovers the same canonical outcome once', async () => {
    const files = new MemoryFiles(row());
    const publication = new MemoryPublication();
    const input = {
      findingId: FINDING,
      read: failedRead('failed', 'exhausted'),
      at: AT,
      maxFindingRetries: MAX_RETRIES,
      repairBase: BASE,
    };
    const first = await executeRepairHarvest(input, effects(files, publication));
    expect(first.kind).toBe('written');
    expect(publication.events).toHaveLength(1);
    const written = files.current();
    // Simulate a caller crash between spool and row write.
    files.rows.set(FINDING, ledgerCanonicalBytes(row()));
    const second = await executeRepairHarvest(input, effects(files, publication));
    expect(second.kind === 'none' || second.kind === 'already-recorded').toBe(true);
    expect(publication.events).toHaveLength(1);
    expect(toPlainJson(files.current())).toEqual(toPlainJson(written));
  });

  test('a newer generated job is preserved', async () => {
    const files = new MemoryFiles(row({ receipt: { repair_task: 'crq-newer-F2' } }));
    const publication = new MemoryPublication();
    const result = await executeRepairHarvest(
      {
        findingId: FINDING,
        read: failedRead('failed', 'exhausted'),
        at: AT,
        maxFindingRetries: MAX_RETRIES,
      },
      effects(files, publication),
    );
    expect(result).toMatchObject({ kind: 'none', reason: 'preserved-newer-generation' });
    expect(publication.events).toEqual([]);
    expect(files.writes).toBe(0);
  });
});
