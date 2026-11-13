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
  type RepairScanResult,
} from '../../../src/ops/crq/internal/repairPrepareGates.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { atomicJsonText } from '../../../src/policy/crq/pythonJson.js';
import type { RepairRefusal } from '../../../src/policy/crq/repairBinding.js';

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

function fakeState(
  row: JsonObject,
  phase: 'first' | 'second',
  throwOn?: 'inbox' | 'prepared' | 'triage',
): FakeState {
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
      if (throwOn === 'inbox') throw new Error('synthetic inbox failure');
      const text = inboxJobs.get(jobId);
      return typeof text === 'string' ? text : undefined;
    },
    async readTriageRow(findingId: string): Promise<string | undefined> {
      triageReads.push(findingId);
      if (throwOn === 'triage') throw new Error('synthetic triage failure');
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
      if (throwOn === 'prepared') throw new Error('synthetic prepared failure');
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

function gateRow(name: string): JsonObject {
  const row = asArray(fixture.get('gate_cases'))
    .map(asObject)
    .find((entry) => entry.get('name') === name);
  if (row === undefined) throw new Error(`missing gate case ${name}`);
  return row;
}

function fixedScan(result: unknown): FakeScan {
  const calls: FakeScan['calls'] = [];
  return {
    calls,
    async scanDiff(request) {
      calls.push({
        patch: request.patch,
        name: request.name,
        base: request.base,
        head: request.head,
      });
      return result as RepairScanResult;
    },
  };
}

function preparedWith(
  row: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): string {
  const original = asObject(parseJsonValue(asString(row.get('prepared_job_bytes'))));
  const replacement = new Map(updates);
  return atomicJsonText(
    new JsonObject(original.entries.map(([key, value]) => [key, replacement.get(key) ?? value])),
  );
}

function preparedOverride(row: JsonObject, text: string): FakeState {
  const state = fakeState(row, 'second');
  return {
    ...state,
    async readPreparedJob(jobId: string): Promise<string | undefined> {
      state.preparedReads.push(jobId);
      return text;
    },
  };
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

describe('scanner result matrix fails closed', () => {
  const row = gateRow('scan-clean-source-only');
  const input = inputOf(row);
  const report = (overrides: Record<string, unknown> = {}): unknown => ({
    denylistRules: 0,
    denylistHits: 0,
    gitleaks: 'clean',
    gitleaksHits: 0,
    ...overrides,
  });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly result: unknown;
    readonly refusal: RepairRefusal | undefined;
  }> = [
    {
      name: 'positive gitleaks count with clean status',
      result: { clean: true, report: report({ gitleaksHits: 1 }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'positive gitleaks count with not-run status',
      result: { clean: true, report: report({ gitleaks: 'not-run', gitleaksHits: 1 }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'positive gitleaks count with clean=false and clean status',
      result: { clean: false, report: report({ gitleaksHits: 1 }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'hits status with zero count',
      result: { clean: false, report: report({ gitleaks: 'hits', gitleaksHits: 0 }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'denylist hit with zero rules',
      result: { clean: false, report: report({ denylistHits: 1 }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'clean true with a denylist hit',
      result: { clean: true, report: report({ denylistRules: 1, denylistHits: 1 }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'clean false with no hits',
      result: { clean: false, report: report() },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'negative gitleaks count',
      result: { clean: false, report: report({ gitleaksHits: -1 }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'non-integer gitleaks count',
      result: { clean: false, report: report({ gitleaksHits: 1.5 }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'string clean flag',
      result: { clean: 'true', report: report() },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'missing gitleaks count',
      result: {
        clean: false,
        report: { denylistRules: 0, denylistHits: 0, gitleaks: 'clean' },
      },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'non-object report',
      result: { clean: true, report: null },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'gitleaks error',
      result: { clean: false, report: report({ gitleaks: 'error' }) },
      refusal: 'secret-scan-unavailable',
    },
    {
      name: 'valid denylist dirty',
      result: { clean: false, report: report({ denylistRules: 1, denylistHits: 1 }) },
      refusal: 'source-secret-scan-failed',
    },
    {
      name: 'valid gitleaks dirty',
      result: { clean: false, report: report({ gitleaks: 'hits', gitleaksHits: 1 }) },
      refusal: 'source-secret-scan-failed',
    },
    {
      name: 'valid clean',
      result: { clean: true, report: report() },
      refusal: undefined,
    },
    {
      name: 'valid not-run skipped',
      result: { clean: true, report: report({ gitleaks: 'not-run' }) },
      refusal: undefined,
    },
  ];

  for (const entry of cases) {
    test(entry.name, async () => {
      const scan = fixedScan(entry.result);
      const result = await prepareRepairGates(input, {
        git: fakeGit(row),
        state: fakeState(row, 'first'),
        scan,
      });
      if (entry.refusal === undefined) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, refusal: entry.refusal });
      }
      expect(scan.calls).toHaveLength(1);
    });
  }
});

describe('state read failures become typed refusals', () => {
  const row = gateRow('canonical-handoff-old-owner');
  const input = inputOf(row);
  const canonical = asString(
    asObject(parseJsonValue(input.oldJobJson)).get('canonical_finding_id'),
  );
  const cleanResult = {
    clean: true,
    report: { denylistRules: 0, denylistHits: 0, gitleaks: 'clean', gitleaksHits: 0 },
  };

  async function firstPreparation(): Promise<{
    readonly jobId: string;
    readonly queueBytes: string;
  }> {
    const result = await prepareRepairGates(input, {
      git: fakeGit(row),
      state: fakeState(row, 'first'),
      scan: fakeScan(row),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('first preparation refused');
    const queueBytes = result.value.queue?.bytes;
    if (queueBytes === undefined) throw new Error('first preparation had no queue bytes');
    return { jobId: result.value.proposal.jobId, queueBytes };
  }

  test('readInboxJob rejection is round-history-unreadable', async () => {
    const state = fakeState(row, 'first', 'inbox');
    const scan = fixedScan(cleanResult);
    const result = await prepareRepairGates(input, { git: fakeGit(row), state, scan });
    expect(result).toEqual({ ok: false, refusal: 'round-history-unreadable' });
    expect(state.inboxReads).toEqual(['crq-previous-F1']);
    expect(scan.calls).toEqual([]);
  });

  test('readPreparedJob rejection is prepared-job-unreadable', async () => {
    const first = await firstPreparation();
    const state = fakeState(row, 'second', 'prepared');
    const result = await prepareRepairGates(
      { ...input, queueJson: first.queueBytes },
      { git: fakeGit(row), state, scan: fixedScan(cleanResult) },
    );
    expect(result).toEqual({ ok: false, refusal: 'prepared-job-unreadable' });
    expect(state.preparedReads).toEqual([first.jobId]);
    expect(state.triageReads).toEqual([]);
  });

  test('idempotent readTriageRow rejection is canonical-handoff-unavailable', async () => {
    const first = await firstPreparation();
    const state = fakeState(row, 'second', 'triage');
    const result = await prepareRepairGates(
      { ...input, queueJson: first.queueBytes },
      { git: fakeGit(row), state, scan: fixedScan(cleanResult) },
    );
    expect(result).toEqual({ ok: false, refusal: 'canonical-handoff-unavailable' });
    expect(state.preparedReads).toEqual([first.jobId]);
    expect(state.triageReads).toEqual([canonical]);
  });

  test('new-path readTriageRow rejection is canonical-handoff-unavailable', async () => {
    const state = fakeState(row, 'first', 'triage');
    const scan = fakeScan(row);
    const result = await prepareRepairGates(input, { git: fakeGit(row), state, scan });
    expect(result).toEqual({ ok: false, refusal: 'canonical-handoff-unavailable' });
    expect(state.inboxReads).toEqual(['crq-previous-F1']);
    expect(state.triageReads).toEqual([canonical]);
  });

  const mismatches: ReadonlyArray<{
    readonly name: string;
    readonly updates: ReadonlyArray<readonly [string, JsonValue]>;
  }> = [
    { name: 'prepared job id mismatch', updates: [['job', 'crq-foreign-F1']] },
    { name: 'prepared origin mismatch', updates: [['origin_job', 'crq-other-F1']] },
    {
      name: 'prepared canonical mismatch',
      updates: [['canonical_finding_id', 'e'.repeat(64)]],
    },
    {
      name: 'prepared source mismatch',
      updates: [
        ['source_sha', 'b'.repeat(40)],
        ['repair_base', 'b'.repeat(40)],
      ],
    },
  ];

  for (const mismatch of mismatches) {
    test(mismatch.name, async () => {
      const first = await firstPreparation();
      const state = preparedOverride(row, preparedWith(row, mismatch.updates));
      const result = await prepareRepairGates(
        { ...input, queueJson: first.queueBytes },
        { git: fakeGit(row), state, scan: fixedScan(cleanResult) },
      );
      expect(result).toEqual({ ok: false, refusal: 'canonical-handoff-mismatch' });
      expect(state.preparedReads).toEqual([first.jobId]);
      expect(state.triageReads).toEqual([canonical]);
    });
  }
});
