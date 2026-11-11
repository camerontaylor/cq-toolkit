/**
 * Read-gate orchestration tests against the Python oracle fixture.
 *
 * Every case runs the production Python `prepare_current_job` with a fake
 * scanner, fake git and a fake canonical inbox. The TypeScript side performs
 * the same read gates through injected effects and returns the mutations as
 * data. No write, enqueue, handoff, dispatch or remote scan occurs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  prepareRepairGates,
  type PrepareRepairGatesInput,
  type RepairGateGit,
  type RepairPreparationState,
  type RepairScan,
  type RepairScanEvidence,
  type RepairScanReport,
} from '../../../src/ops/crq/internal/repairPrepareGates.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { atomicJsonText } from '../../../src/policy/crq/pythonJson.js';

const OLD_RUN = 'old-run';
const REMAINING = [
  'state-write-execution',
  'canonical-handoff-execution',
  'dispatch-request-construction',
  'enqueue-dispatch',
  'harvest-disposition',
];

const fixture = asObject(
  parseJsonValue(
    readFileSync(
      new URL('../../../apps/crq-python/fixtures/repair-prepare/cases.json', import.meta.url),
      'utf8',
    ),
  ),
);

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

function stringList(value: JsonValue | undefined): string[] {
  return asArray(value).map(asString);
}

function scanCalls(row: JsonObject): JsonObject[] {
  return asArray(row.get('scan_calls')).map(asObject);
}

function inputOf(row: JsonObject): PrepareRepairGatesInput {
  const input = asObject(row.get('input'));
  return {
    oldJobJson: asString(input.get('old_job_json')),
    oldJobId: asString(input.get('old_job_id')),
    queueJson: asString(input.get('queue_json')),
    sourceSha: asString(input.get('source_sha')),
    evidenceJson: asString(input.get('evidence_json')),
    maxRoundsPerPin: asNumber(input.get('max_rounds_per_pin')),
    ...(asBoolean(input.get('preserve_worktree')) ? { preserveWorktree: true } : {}),
  };
}

function scanReport(object: JsonObject): RepairScanReport {
  const gitleaks = asString(object.get('gitleaks'));
  if (
    gitleaks !== 'clean' &&
    gitleaks !== 'hits' &&
    gitleaks !== 'not-run' &&
    gitleaks !== 'error'
  ) {
    throw new Error('invalid gitleaks status');
  }
  return {
    denylistRules: asNumber(object.get('denylist_rules')),
    denylistHits: asNumber(object.get('denylist_hits')),
    gitleaks,
    gitleaksHits: asNumber(object.get('gitleaks_hits')),
  };
}

function scanEvidence(row: JsonObject): RepairScanEvidence {
  const kind = asString(row.get('kind'));
  const verdict = asString(row.get('verdict'));
  if (kind !== 'full-source' && kind !== 'fix-instructions') {
    throw new Error('invalid scan kind');
  }
  if (verdict !== 'clean' && verdict !== 'dirty' && verdict !== 'skipped' && verdict !== 'error') {
    throw new Error('invalid scan verdict');
  }
  return {
    kind,
    name: asString(row.get('name')),
    patchSha256: asString(row.get('patch_sha256')),
    patchLength: asNumber(row.get('patch_length')),
    clean: asBoolean(row.get('clean')),
    verdict,
    report: scanReport(asObject(row.get('report'))),
  };
}

interface FakeGit extends RepairGateGit {
  readonly calls: string[][];
  readonly showCalls: string[][];
}

function fakeGit(row: JsonObject): FakeGit {
  const input = asObject(row.get('input'));
  const calls: string[][] = [];
  const showCalls: string[][] = [];
  return {
    calls,
    showCalls,
    async currentTip(): Promise<string> {
      calls.push(['rev-parse', 'origin/main']);
      return asString(input.get('current_tip'));
    },
    async blobOid(sourceSha: string, path: string): Promise<string> {
      calls.push(['rev-parse', `${sourceSha}:${path}`]);
      return asString(input.get('blob_oid'));
    },
    async showFile(sourceSha: string, path: string): Promise<string> {
      showCalls.push([sourceSha, path]);
      if (asBoolean(input.get('show_error'))) throw new Error('synthetic show failure');
      return asString(input.get('source_text'));
    },
  };
}

interface FakeState extends RepairPreparationState {
  readonly inboxReads: string[];
  readonly triageReads: string[];
  readonly preparedReads: string[];
}

function triageRow(repairTask: string): string {
  return atomicJsonText(
    new JsonObject([['receipt', new JsonObject([['repair_task', repairTask]])]]),
  );
}

function fakeState(row: JsonObject, phase: 'first' | 'second'): FakeState {
  const input = asObject(row.get('input'));
  const inboxJobs = asObject(row.get('inbox_jobs'));
  const tsRefusal = row.get('ts_refusal');
  const owner = row.get('handoff_owner');
  const inboxReads: string[] = [];
  const triageReads: string[] = [];
  const preparedReads: string[] = [];
  return {
    inboxReads,
    triageReads,
    preparedReads,
    async readInboxJob(jobId: string): Promise<string | undefined> {
      inboxReads.push(jobId);
      const text = inboxJobs.get(jobId);
      return typeof text === 'string' ? text : undefined;
    },
    async readTriageRow(findingId: string): Promise<string | undefined> {
      triageReads.push(findingId);
      if (phase === 'first') {
        if (tsRefusal === 'canonical-handoff-unavailable') return '{';
        if (tsRefusal === 'canonical-handoff-mismatch') return triageRow('crq-other-F1');
        return triageRow(asString(input.get('old_job_id')));
      }
      return owner === 'prepared'
        ? triageRow(asString(row.get('job_id')))
        : triageRow(asString(input.get('old_job_id')));
    },
    async readPreparedJob(jobId: string): Promise<string | undefined> {
      preparedReads.push(jobId);
      if (phase !== 'second') return undefined;
      const bytes = row.get('prepared_job_bytes');
      return typeof bytes === 'string' ? bytes : undefined;
    },
  };
}

interface FakeScan extends RepairScan {
  readonly calls: Array<{
    readonly patch: string;
    readonly name: string;
    readonly base: string | null;
    readonly head: string;
  }>;
}

function fakeScan(row: JsonObject): FakeScan {
  const results = asArray(row.get('scan_results')).map(asObject);
  const calls: FakeScan['calls'] = [];
  let index = 0;
  return {
    calls,
    async scanDiff(request) {
      calls.push({
        patch: request.patch,
        name: request.name,
        base: request.base,
        head: request.head,
      });
      const result = results[index];
      index += 1;
      if (result === undefined) throw new Error('unexpected scan call');
      if (result.get('error') === true) throw new Error('synthetic scan failure');
      return {
        clean: asBoolean(result.get('clean')),
        report: scanReport(asObject(result.get('report'))),
      };
    },
  };
}

function oldRecord(queueBytes: string): JsonObject {
  const queue = asObject(parseJsonValue(queueBytes));
  const item = asObject(asArray(queue.get('items'))[0]);
  return asObject(asObject(item.get('repair_runs')).get(OLD_RUN));
}

describe('prepareRepairGates against the Python oracle', () => {
  for (const row of asArray(fixture.get('gate_cases')).map(asObject)) {
    const name = asString(row.get('name'));
    test(name, async () => {
      const input = inputOf(row);
      const git = fakeGit(row);
      const state = fakeState(row, 'first');
      const scan = fakeScan(row);
      const result = await prepareRepairGates(input, { git, state, scan });

      expect(git.calls).toEqual(callList(row.get('git_calls')));
      expect(git.showCalls).toEqual(callList(row.get('show_calls')));
      expect(scan.calls.map((call) => call.patch)).toEqual(
        scanCalls(row).map((call) => asString(call.get('patch'))),
      );
      expect(scan.calls.map((call) => call.name)).toEqual(
        scanCalls(row).map((call) => asString(call.get('path'))),
      );
      expect(scan.calls.every((call) => call.base === null)).toBe(true);
      expect(scan.calls.every((call) => call.head === input.sourceSha)).toBe(true);
      expect(state.inboxReads).toEqual(stringList(row.get('inbox_reads')));

      const tsRefusal = row.get('ts_refusal');
      if (tsRefusal !== undefined) {
        expect(result).toEqual({ ok: false, refusal: asString(tsRefusal) });
        return;
      }

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value;
      const jobId = asString(row.get('job_id'));
      const jobBytes = asString(row.get('job_bytes'));
      const queueBytes = asString(row.get('queue_bytes'));
      const oldJob = asObject(parseJsonValue(input.oldJobJson));
      const canonical = oldJob.get('canonical_finding_id');

      expect(value.status).toBe('read-gates-verified');
      expect(value.idempotent).toBe(false);
      expect(value.proposal.jobId).toBe(jobId);
      expect(value.proposal.run).toBe(asString(row.get('run')));
      expect(value.proposal.job).toBeDefined();
      expect(value.proposal.record).toBeDefined();
      if (value.proposal.job === undefined || value.proposal.record === undefined) return;
      expect(atomicJsonText(value.proposal.job)).toBe(jobBytes);
      expect(atomicJsonText(value.proposal.record)).toBe(asString(row.get('record_bytes')));
      expect(value.roundCount).toEqual({
        basis: asString(asObject(row.get('round_count')).get('basis')),
        count: asNumber(asObject(row.get('round_count')).get('count')),
      });
      expect(value.scans).toEqual(
        asArray(row.get('scan_evidence')).map(asObject).map(scanEvidence),
      );
      expect(value.remainingGates).toEqual(REMAINING);
      expect(value.preparedJob).toBeUndefined();
      expect(state.preparedReads).toEqual([]);

      expect(value.queue).toBeDefined();
      if (value.queue === undefined) return;
      expect(value.queue.bytes).toBe(queueBytes);
      const stale = asString(row.get('old_record_state')) === 'stale';
      if (stale) {
        expect(value.queue.stale).toEqual({
          state: 'stale',
          error: asString(row.get('old_record_error')),
        });
      } else {
        expect(value.queue.stale).toBeUndefined();
      }
      const record = oldRecord(queueBytes);
      expect(record.get('state')).toBe(asString(row.get('old_record_state')));
      expect(record.get('error')).toBe(
        typeof row.get('old_record_error') === 'string' ? row.get('old_record_error') : undefined,
      );

      if (canonical !== undefined) {
        expect(value.handoff).toEqual({
          findingId: canonical,
          previousTask: input.oldJobId,
          preparedJobId: jobId,
          alreadyHandedOff: false,
        });
        expect(state.triageReads).toEqual([canonical]);
      } else {
        expect(value.handoff).toBeUndefined();
        expect(state.triageReads).toEqual([]);
      }

      const expectedMutations = [
        { kind: 'write-job', jobId, bytes: jobBytes },
        ...(canonical === undefined
          ? []
          : [
              {
                kind: 'handoff',
                findingId: canonical,
                previousTask: input.oldJobId,
                preparedJobId: jobId,
              },
            ]),
        { kind: 'write-queue', bytes: queueBytes },
      ];
      expect(value.mutations).toEqual(expectedMutations);

      const secondGit = fakeGit(row);
      const secondState = fakeState(row, 'second');
      const secondScan = fakeScan(row);
      const secondInput: PrepareRepairGatesInput = { ...input, queueJson: queueBytes };
      const second = await prepareRepairGates(secondInput, {
        git: secondGit,
        state: secondState,
        scan: secondScan,
      });
      expect(secondGit.calls).toEqual(callList(row.get('git_calls')));
      expect(secondGit.showCalls).toEqual([]);
      expect(secondScan.calls).toEqual([]);
      expect(secondState.inboxReads).toEqual([]);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.idempotent).toBe(true);
      expect(second.value.proposal.jobId).toBe(asString(row.get('second_job_id')));
      expect(second.value.proposal.job).toBeUndefined();
      expect(second.value.proposal.record).toBeDefined();
      if (second.value.proposal.record !== undefined) {
        expect(atomicJsonText(second.value.proposal.record)).toBe(
          asString(row.get('record_bytes')),
        );
      }
      expect(second.value.scans).toEqual([]);
      expect(second.value.queue).toBeUndefined();
      if (canonical === undefined) {
        expect(second.value.preparedJob).toBeUndefined();
        expect(second.value.handoff).toBeUndefined();
        expect(second.value.mutations).toEqual([]);
        expect(secondState.preparedReads).toEqual([]);
        expect(secondState.triageReads).toEqual([]);
        return;
      }
      expect(second.value.preparedJob).toBeDefined();
      if (second.value.preparedJob === undefined) return;
      expect(atomicJsonText(second.value.preparedJob)).toBe(
        asString(row.get('prepared_job_bytes')),
      );
      const already = row.get('handoff_owner') === 'prepared';
      expect(second.value.handoff).toEqual({
        findingId: canonical,
        previousTask: input.oldJobId,
        preparedJobId: jobId,
        alreadyHandedOff: already,
      });
      expect(second.value.mutations).toEqual(
        already
          ? []
          : [
              {
                kind: 'handoff',
                findingId: canonical,
                previousTask: input.oldJobId,
                preparedJobId: jobId,
              },
            ],
      );
      expect(secondState.preparedReads).toEqual([jobId]);
      expect(secondState.triageReads).toEqual([canonical]);
    });
  }
});
