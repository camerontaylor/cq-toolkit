/**
 * Executor effect differential against the real Python preparation oracle.
 *
 * Every case replays the production Python `prepare_current_job` order and
 * partial-failure behaviour recorded in
 * `apps/crq-python/fixtures/crq-repair-prepare-execution/cases.json`. The
 * TypeScript side runs the real `prepareRepairGates` producer inside the
 * executor's caller-supplied `tick.lock` scope, then executes through memory
 * seams for the job/queue writes, the existing `FindingInbox.handoff` and a
 * real `Outbox` over a memory outbox store. No real root, lock file, Git,
 * network or provider is involved.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  executeRepairPreparation,
  type RepairPreparationEffects,
  type RepairPreparationExecutionResult,
} from '../../../src/ops/crq/internal/repairPrepareExecution.js';
import {
  prepareRepairGates,
  type PrepareRepairGatesInput,
  type PrepareRepairGatesResult,
  type RepairGateGit,
  type RepairPreparationState,
  type RepairScan,
  type RepairScanReport,
  type RepairScanResult,
  type VerifiedRepairPreparation,
} from '../../../src/ops/crq/internal/repairPrepareGates.js';
import {
  FindingInbox,
  type FindingInboxFiles,
} from '../../../src/ops/review/internal/crq/findingInbox.js';
import {
  Outbox,
  type ArtifactVerifier,
  type OutboxFiles,
} from '../../../src/ops/review/internal/crq/outbox.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { atomicJsonText, sha256Hex } from '../../../src/policy/crq/pythonJson.js';

const FIXTURE = new URL(
  '../../../apps/crq-python/fixtures/crq-repair-prepare-execution/cases.json',
  import.meta.url,
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CALLER_GATES = ['dispatch-request-construction', 'enqueue-dispatch', 'harvest-disposition'];
const ALL_GATES = ['state-write-execution', 'canonical-handoff-execution', ...CALLER_GATES];

const fixture = asObject(parseJsonValue(readFileSync(FIXTURE, 'utf8')));

type TraceEntry = Record<string, unknown>;

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

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function required(value: JsonValue | undefined): JsonValue {
  if (value === undefined) throw new Error('expected a JSON value');
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

/** One ordered effect log; the same shape the Python oracle records. */
class MemoryEffects {
  readonly entries: TraceEntry[] = [];
  private readonly stack: string[] = [];

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.stack.includes(name)) throw new Error(`re-entrant ${name}`);
    this.stack.push(name);
    this.entries.push({ kind: 'lock', phase: 'enter', target: name });
    try {
      return await fn();
    } finally {
      this.stack.pop();
      this.entries.push({ kind: 'lock', phase: 'exit', target: name });
    }
  }

  holds(name: string): boolean {
    return this.stack.includes(name);
  }

  write(target: string, text: string, id?: string): void {
    const entry: TraceEntry = {
      kind: 'write',
      target,
      sha256: sha256Hex(encoder.encode(text)),
      canonical: text,
    };
    if (id !== undefined) entry['id'] = id;
    this.entries.push(entry);
  }

  writeFailure(target: string): void {
    this.entries.push({ kind: 'write', target, outcome: 'error' });
  }

  handoffEnter(findingId: string, preparedJobId: string): void {
    this.entries.push({
      kind: 'handoff',
      phase: 'enter',
      finding_id: findingId,
      prepared_job_id: preparedJobId,
    });
  }

  handoffExit(outcome: 'ok' | 'error'): void {
    this.entries.push({ kind: 'handoff', phase: 'exit', outcome });
  }

  assertBalanced(): void {
    if (this.stack.length !== 0) throw new Error(`unclosed locks: ${this.stack.join(',')}`);
  }
}

interface Stores {
  readonly jobs: Map<string, string>;
  queue: string;
  readonly triage: Map<string, string>;
  readonly retained: Map<string, string>;
}

class MemoryInboxFiles implements FindingInboxFiles {
  writeFailures = 0;

  constructor(
    private readonly effects: MemoryEffects,
    private readonly stores: Stores,
  ) {}

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.effects.withLock('findings.lock', fn);
  }

  async readTriage(findingId: string): Promise<Uint8Array | null> {
    if (!this.effects.holds('findings.lock')) throw new Error('readTriage outside findings.lock');
    const text = this.stores.triage.get(findingId);
    return text === undefined ? null : encoder.encode(text);
  }

  async writeTriage(findingId: string, bytes: Uint8Array): Promise<void> {
    if (!this.effects.holds('findings.lock')) throw new Error('writeTriage outside findings.lock');
    if (this.writeFailures > 0) {
      this.writeFailures -= 1;
      this.effects.writeFailure('triage');
      throw new Error('synthetic triage write failure');
    }
    const text = decoder.decode(bytes);
    this.stores.triage.set(findingId, text);
    this.effects.write('triage', text);
  }
}

class MemoryOutboxFiles implements OutboxFiles {
  writeFailures = 0;

  constructor(
    private readonly effects: MemoryEffects,
    private readonly stores: Stores,
  ) {}

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.effects.withLock('outbox.lock', fn);
  }

  async listPending(): Promise<readonly string[]> {
    return [...this.stores.retained.keys()].sort();
  }

  async readPending(id: string): Promise<Uint8Array | null> {
    const text = this.stores.retained.get(id);
    return text === undefined ? null : encoder.encode(text);
  }

  async writePending(id: string, bytes: Uint8Array): Promise<void> {
    if (!this.effects.holds('outbox.lock')) throw new Error('writePending outside outbox.lock');
    if (this.writeFailures > 0) {
      this.writeFailures -= 1;
      this.effects.writeFailure('outbox');
      throw new Error('synthetic outbox write failure');
    }
    const text = decoder.decode(bytes);
    this.stores.retained.set(id, text);
    this.effects.write('outbox', text);
  }

  async hasAck(): Promise<boolean> {
    return false;
  }

  async writeAck(): Promise<void> {
    throw new Error('the preparation executor never acknowledges');
  }
}

class NoArtifacts implements ArtifactVerifier {
  async verify(): Promise<void> {}
}

interface AttemptEffects {
  readonly effects: RepairPreparationEffects;
  readonly trace: MemoryEffects;
}

/** The case-level failure the first attempt injects, if any. */
type InjectedFailure = 'job' | 'queue' | 'triage' | 'outbox' | undefined;

const PORT_FAILURE: Record<string, Exclude<InjectedFailure, undefined>> = {
  'fail-job-write': 'job',
  'fail-queue-write': 'queue',
  'fail-row-write': 'triage',
  'fail-outbox-write': 'outbox',
};

function rowWithOwner(owner: string): string {
  return atomicJsonText(new JsonObject([['receipt', new JsonObject([['repair_task', owner]])]]));
}

/** Re-own the seeded full triage row while preserving its other fields. */
function rowReowned(canonical: string, owner: string): string {
  const row = asObject(parseJsonValue(canonical));
  const receipt = asObject(row.get('receipt'));
  const reownedReceipt = new JsonObject(
    receipt.entries.map(([key, value]) => [key, key === 'repair_task' ? owner : value]),
  );
  return atomicJsonText(
    new JsonObject(
      row.entries.map(([key, value]) => [key, key === 'receipt' ? reownedReceipt : value]),
    ),
  );
}

function ownerId(row: JsonObject, owner: string): string {
  const input = asObject(row.get('input'));
  if (owner === 'old') return asString(input.get('old_job_id'));
  if (owner === 'prepared') return asString(row.get('job_id'));
  return 'crq-foreign-F1';
}

function attemptEffects(
  effectsTrace: MemoryEffects,
  stores: Stores,
  failure: InjectedFailure,
  handoffAt: string,
): AttemptEffects {
  const inboxFiles = new MemoryInboxFiles(effectsTrace, stores);
  const outboxFiles = new MemoryOutboxFiles(effectsTrace, stores);
  const inbox = new FindingInbox(inboxFiles);
  const outbox = new Outbox(outboxFiles, new NoArtifacts());
  if (failure === 'triage') inboxFiles.writeFailures = 1;
  if (failure === 'outbox') outboxFiles.writeFailures = 1;

  const effects: RepairPreparationEffects = {
    async withTickLock<T>(fn: () => Promise<T>): Promise<T> {
      return effectsTrace.withLock('tick.lock', fn);
    },
    async persistJob(jobId: string, bytes: string): Promise<void> {
      if (failure === 'job') {
        effectsTrace.writeFailure('job');
        throw new Error('synthetic job write failure');
      }
      stores.jobs.set(jobId, bytes);
      effectsTrace.write('job', bytes, jobId);
    },
    async persistQueue(bytes: string): Promise<void> {
      if (failure === 'queue') {
        effectsTrace.writeFailure('queue');
        throw new Error('synthetic queue write failure');
      }
      stores.queue = bytes;
      effectsTrace.write('queue', bytes);
    },
    inbox: {
      async handoff(publication, request) {
        effectsTrace.handoffEnter(request.findingId, request.preparedJobId);
        try {
          const result = await inbox.handoff(publication, request);
          effectsTrace.handoffExit(result.kind === 'refused' ? 'error' : 'ok');
          return result;
        } catch (error) {
          effectsTrace.handoffExit('error');
          throw error;
        }
      },
    },
    publication: outbox,
    now: () => handoffAt,
  };
  return { effects, trace: effectsTrace };
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

function gateScan(attempt: JsonObject): RepairScan {
  const results = asArray(attempt.get('scan_results')).map(asObject);
  let index = 0;
  return {
    async scanDiff(): Promise<RepairScanResult> {
      const result = results[index];
      index += 1;
      if (result === undefined) throw new Error('unexpected scan call');
      return {
        clean: asBoolean(result.get('clean')),
        report: scanReport(asObject(result.get('report'))),
      };
    },
  };
}

function gateGit(row: JsonObject): RepairGateGit {
  const gateEffects = asObject(row.get('gate_effects'));
  return {
    async currentTip(): Promise<string> {
      return asString(gateEffects.get('current_tip'));
    },
    async blobOid(): Promise<string> {
      return asString(gateEffects.get('blob_oid'));
    },
    async showFile(): Promise<string> {
      return asString(gateEffects.get('source_text'));
    },
  };
}

function gateState(row: JsonObject, stores: Stores): RepairPreparationState {
  const race = optionalString(row.get('race_row_owner'));
  return {
    async readInboxJob(jobId: string): Promise<string | undefined> {
      return stores.jobs.get(jobId);
    },
    async readTriageRow(findingId: string): Promise<string | undefined> {
      if (race !== undefined) return rowWithOwner(ownerId(row, race));
      return stores.triage.get(findingId);
    },
    async readPreparedJob(jobId: string): Promise<string | undefined> {
      return stores.jobs.get(jobId);
    },
  };
}

function gatesInput(row: JsonObject, stores: Stores): PrepareRepairGatesInput {
  const input = asObject(row.get('input'));
  return {
    oldJobJson: asString(input.get('old_job_json')),
    oldJobId: asString(input.get('old_job_id')),
    queueJson: stores.queue,
    sourceSha: asString(input.get('source_sha')),
    evidenceJson: asString(input.get('evidence_json')),
    maxRoundsPerPin: asNumber(input.get('max_rounds_per_pin')),
    ...(asBoolean(input.get('preserve_worktree')) ? { preserveWorktree: true } : {}),
  };
}

function fixtureCases(): JsonObject[] {
  return asArray(fixture.get('execution_cases')).map(asObject);
}

function caseNamed(name: string): JsonObject {
  const row = fixtureCases().find((entry) => entry.get('name') === name);
  if (row === undefined) throw new Error(`missing case ${name}`);
  return row;
}

function storesFor(row: JsonObject): Stores {
  const setup = asObject(row.get('setup'));
  const jobs = new Map<string, string>();
  for (const job of asArray(setup.get('jobs')).map(asObject)) {
    jobs.set(asString(job.get('id')), asString(job.get('canonical')));
  }
  const triage = new Map<string, string>();
  for (const entry of asArray(setup.get('triage')).map(asObject)) {
    triage.set(asString(entry.get('id')), asString(entry.get('canonical')));
  }
  const retained = new Map<string, string>();
  for (const entry of asArray(setup.get('retained')).map(asObject)) {
    retained.set(asString(entry.get('id')), asString(entry.get('canonical')));
  }
  return { jobs, queue: asString(setup.get('queue')), triage, retained };
}

function stateSnapshot(stores: Stores): unknown {
  const rows = (values: Map<string, string>): unknown[] =>
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, canonical]) => ({ id, canonical }));
  return {
    jobs: rows(stores.jobs),
    queue: stores.queue,
    triage: rows(stores.triage),
    retained: rows(stores.retained),
  };
}

function canonicalFindingId(row: JsonObject): string {
  const input = asObject(row.get('input'));
  const oldJob = asObject(parseJsonValue(asString(input.get('old_job_json'))));
  return asString(oldJob.get('canonical_finding_id'));
}

function traceOf(row: JsonObject): unknown[] {
  return asArray(row.get('trace')).map((entry) => toPlainJson(entry));
}

function outcomeOf(attempt: JsonObject): JsonObject {
  return asObject(attempt.get('outcome'));
}

function expectation(
  name: string,
  attemptIndex: number,
  row: JsonObject,
): 'ok' | 'refused' | 'failed' {
  if (attemptIndex === 0 && optionalString(row.get('ts_refusal')) !== undefined) return 'refused';
  if (attemptIndex === 0 && PORT_FAILURE[name] !== undefined) return 'failed';
  if (attemptIndex === 0 && name === 'fail-handoff-owner-mismatch') return 'failed';
  return 'ok';
}

const STEP_FOR: Record<string, 'write-job' | 'handoff' | 'write-queue'> = {
  'fail-job-write': 'write-job',
  'fail-handoff-owner-mismatch': 'handoff',
  'fail-outbox-write': 'handoff',
  'fail-row-write': 'handoff',
  'fail-queue-write': 'write-queue',
};

function stepFor(name: string): string {
  return STEP_FOR[name] ?? 'write-job';
}

function expectSuccess(
  result: RepairPreparationExecutionResult,
  attempt: JsonObject,
  plan: VerifiedRepairPreparation,
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const value = result.value;
  expect(value.status).toBe('preparation-executed');
  expect(value.jobId).toBe(asString(outcomeOf(attempt).get('job_id')));
  expect(value.idempotent).toBe(plan.idempotent);
  expect(value.remainingGates).toEqual(CALLER_GATES);
  const writes = asArray(attempt.get('trace'))
    .map(asObject)
    .filter((entry) => entry.get('kind') === 'write')
    .map((entry) => asString(entry.get('target')));
  const handoffCalls = asArray(attempt.get('trace'))
    .map(asObject)
    .filter((entry) => entry.get('kind') === 'handoff' && entry.get('phase') === 'enter');
  const expectedKinds = [
    ...(writes.includes('job') ? ['write-job'] : []),
    ...(handoffCalls.length > 0 ? ['handoff'] : []),
    ...(writes.includes('queue') ? ['write-queue'] : []),
  ];
  expect(value.effects.map((effect) => effect.kind)).toEqual(expectedKinds);
  if (value.handoff !== undefined) {
    expect(value.handoff.result).toBe(writes.includes('outbox') ? 'written' : 'already-handed-off');
  }
}

describe('executeRepairPreparation against the Python oracle', () => {
  for (const row of fixtureCases()) {
    const name = asString(row.get('name'));
    test(name, async () => {
      const handoffAt = asString(row.get('handoff_at'));
      const stores = storesFor(row);
      const attempts = asArray(row.get('attempts')).map(asObject);
      const captured: { plan: VerifiedRepairPreparation | undefined } = { plan: undefined };
      for (const [index, attempt] of attempts.entries()) {
        if (index > 0 && optionalString(row.get('retry_row_owner')) === 'old') {
          const input = asObject(row.get('input'));
          const findingId = canonicalFindingId(row);
          const seeded = stores.triage.get(findingId);
          if (seeded === undefined) throw new Error('retry row missing');
          stores.triage.set(findingId, rowReowned(seeded, asString(input.get('old_job_id'))));
        }
        const trace = new MemoryEffects();
        const failure = index === 0 ? PORT_FAILURE[name] : undefined;
        const seams = attemptEffects(trace, stores, failure, handoffAt);
        captured.plan = undefined;
        const produce = async (): Promise<PrepareRepairGatesResult> => {
          const produced = await prepareRepairGates(gatesInput(row, stores), {
            git: gateGit(row),
            state: gateState(row, stores),
            scan: gateScan(attempt),
          });
          if (produced.ok) captured.plan = produced.value;
          return produced;
        };
        const result = await executeRepairPreparation(produce, seams.effects);
        trace.assertBalanced();
        expect(trace.entries).toEqual(traceOf(attempt));
        expect(stateSnapshot(stores)).toEqual(toPlainJson(required(attempt.get('state'))));

        switch (expectation(name, index, row)) {
          case 'refused': {
            expect(result).toMatchObject({
              ok: false,
              kind: 'refused',
              refusal: optionalString(row.get('ts_refusal')),
              readGates: 'attempted-under-tick-lock',
              effects: [],
            });
            break;
          }
          case 'failed': {
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.kind).toBe('effect-failed');
            if (result.kind !== 'effect-failed') return;
            expect(result.step).toBe(stepFor(name));
            expect(result.recovery).toBe('re-run-preparation');
            expect(result.remainingGates).toEqual(ALL_GATES);
            expect(result.readGates).toBe('attempted-under-tick-lock');
            const failing = result.steps[result.steps.length - 1];
            expect(failing?.step).toBe(stepFor(name));
            expect(failing?.outcome).toBe(
              name === 'fail-handoff-owner-mismatch' ? 'refused' : 'unconfirmed',
            );
            if (name === 'fail-handoff-owner-mismatch') {
              expect(result.refusal).toBe('canonical-handoff-mismatch');
            }
            break;
          }
          case 'ok': {
            expect(captured.plan).toBeDefined();
            if (captured.plan === undefined) return;
            expectSuccess(result, attempt, captured.plan);
            break;
          }
        }
      }
    });
  }
});

describe('executeRepairPreparation internal diagnostics', () => {
  const handoffAt = '2026-11-11T00:00:00Z';

  async function planFor(name: string): Promise<VerifiedRepairPreparation> {
    const row = caseNamed(name);
    const stores = storesFor(row);
    const attempt = asObject(asArray(row.get('attempts'))[0]);
    const produced = await prepareRepairGates(gatesInput(row, stores), {
      git: gateGit(row),
      state: gateState(row, stores),
      scan: gateScan(attempt),
    });
    if (!produced.ok) throw new Error(`gate refusal for ${name}: ${produced.refusal}`);
    return produced.value;
  }

  function noEffects(): MemoryEffects {
    return new MemoryEffects();
  }

  test('a plan with out-of-order mutations is refused before any write', async () => {
    const plan = await planFor('new-canonical-old-owner');
    const trace = noEffects();
    const stores = storesFor(caseNamed('new-canonical-old-owner'));
    const seams = attemptEffects(trace, stores, undefined, handoffAt);
    const tampered: VerifiedRepairPreparation = {
      ...plan,
      mutations: [...plan.mutations].reverse(),
    };
    const result = await executeRepairPreparation(
      async () => ({ ok: true, value: tampered }),
      seams.effects,
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'plan-inconsistent',
      detail: 'mutation-order',
      steps: [],
      remainingGates: ALL_GATES,
    });
    expect(trace.entries).toEqual([
      { kind: 'lock', phase: 'enter', target: 'tick.lock' },
      { kind: 'lock', phase: 'exit', target: 'tick.lock' },
    ]);
  });

  test('a job write whose bytes are not the handed-off job is refused', async () => {
    const plan = await planFor('new-canonical-old-owner');
    const stores = storesFor(caseNamed('new-canonical-old-owner'));
    const seams = attemptEffects(new MemoryEffects(), stores, undefined, handoffAt);
    const tampered: VerifiedRepairPreparation = {
      ...plan,
      mutations: plan.mutations.map((mutation) =>
        mutation.kind === 'write-job' ? { ...mutation, bytes: '{}\n' } : mutation,
      ),
    };
    const result = await executeRepairPreparation(
      async () => ({ ok: true, value: tampered }),
      seams.effects,
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'plan-inconsistent',
      detail: 'write-job-bytes',
    });
  });

  test('an idempotent plan carrying a write is refused', async () => {
    const plan = await planFor('idempotent-canonical');
    const stores = storesFor(caseNamed('idempotent-canonical'));
    const seams = attemptEffects(new MemoryEffects(), stores, undefined, handoffAt);
    const tampered: VerifiedRepairPreparation = {
      ...plan,
      mutations: [
        {
          kind: 'write-queue',
          bytes: stores.queue,
        },
      ],
    };
    const result = await executeRepairPreparation(
      async () => ({ ok: true, value: tampered }),
      seams.effects,
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'plan-inconsistent',
      detail: 'idempotent-with-write',
    });
  });

  test('a non-idempotent plan that omits its queue write is refused', async () => {
    const plan = await planFor('new-canonical-old-owner');
    const stores = storesFor(caseNamed('new-canonical-old-owner'));
    const seams = attemptEffects(new MemoryEffects(), stores, undefined, handoffAt);
    const tampered: VerifiedRepairPreparation = {
      ...plan,
      mutations: plan.mutations.filter((mutation) => mutation.kind !== 'write-queue'),
    };
    const result = await executeRepairPreparation(
      async () => ({ ok: true, value: tampered }),
      seams.effects,
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'plan-inconsistent',
      detail: 'queue-without-write',
    });
  });

  test('a canonical plan without its prepared job is refused', async () => {
    const plan = await planFor('idempotent-canonical');
    const stores = storesFor(caseNamed('idempotent-canonical'));
    const seams = attemptEffects(new MemoryEffects(), stores, undefined, handoffAt);
    const { preparedJob: _preparedJob, ...rest } = plan;
    const result = await executeRepairPreparation(
      async () => ({ ok: true, value: rest }),
      seams.effects,
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'plan-inconsistent',
      detail: 'handoff-without-job',
    });
  });

  test('a throwing gate producer is reported without effects', async () => {
    const stores = storesFor(caseNamed('new-canonical-old-owner'));
    const trace = new MemoryEffects();
    const seams = attemptEffects(trace, stores, undefined, handoffAt);
    const result = await executeRepairPreparation(async () => {
      throw new Error('synthetic read failure');
    }, seams.effects);
    expect(result).toMatchObject({
      ok: false,
      kind: 'plan-failed',
      diagnostic: { category: 'producer-exception', thrown: 'error', class: 'Error' },
      readGates: 'attempted-under-tick-lock',
      steps: [],
      remainingGates: ALL_GATES,
      recovery: 're-run-preparation',
    });
    expect(trace.entries).toEqual([
      { kind: 'lock', phase: 'enter', target: 'tick.lock' },
      { kind: 'lock', phase: 'exit', target: 'tick.lock' },
    ]);
  });

  describe('producer diagnostic', () => {
    const secret = 'sk-live-DO-NOT-ECHO-7f3a9c';

    async function failWith(value: unknown) {
      const seams = attemptEffects(
        new MemoryEffects(),
        storesFor(caseNamed('new-canonical-old-owner')),
        undefined,
        handoffAt,
      );
      return executeRepairPreparation(async () => {
        throw value;
      }, seams.effects);
    }

    test('carries a bounded class and never the message or stack', async () => {
      const result = await failWith(new TypeError(`decode failed for ${secret}`));
      expect(result).toMatchObject({
        kind: 'plan-failed',
        diagnostic: { category: 'producer-exception', thrown: 'error', class: 'TypeError' },
      });
      const text = JSON.stringify(result);
      expect(text).not.toContain(secret);
      expect(text).not.toContain('decode failed');
      expect(text).not.toMatch(/"(message|stack)"\s*:/);
    });

    test('classifies a whitelisted CRQ policy error by name only', async () => {
      const error = new RangeError('timestamp out of range');
      error.name = 'LedgerTimestampError';
      const result = await failWith(error);
      expect(result).toMatchObject({
        kind: 'plan-failed',
        diagnostic: { thrown: 'error', class: 'LedgerTimestampError' },
      });
    });

    test('collapses an unlisted constructor name to unknown', async () => {
      class Custom extends Error {
        override name = 'UserControlledName';
      }
      const result = await failWith(new Custom(secret));
      expect(result).toMatchObject({
        kind: 'plan-failed',
        diagnostic: { thrown: 'error', class: 'unknown' },
      });
      expect(JSON.stringify(result)).not.toContain('UserControlledName');
    });

    test('reports a non-error throw as non-error without inspecting it', async () => {
      const hostile = {
        get name(): string {
          throw new Error(`getter must not run: ${secret}`);
        },
        get message(): string {
          throw new Error(`getter must not run: ${secret}`);
        },
      };
      const result = await failWith(hostile);
      expect(result).toMatchObject({
        kind: 'plan-failed',
        diagnostic: { category: 'producer-exception', thrown: 'non-error', class: 'unknown' },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    });

    test('reports a thrown string as non-error', async () => {
      const result = await failWith(secret);
      expect(result).toMatchObject({
        kind: 'plan-failed',
        diagnostic: { thrown: 'non-error', class: 'unknown' },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  });

  test('a defect inside the lock scope propagates instead of a false lock result', async () => {
    const stores = storesFor(caseNamed('new-canonical-old-owner'));
    const seams = attemptEffects(new MemoryEffects(), stores, undefined, handoffAt);
    const broken = {
      get mutations(): never {
        throw new Error('internal defect');
      },
    } as unknown as VerifiedRepairPreparation;
    await expect(
      executeRepairPreparation(async () => ({ ok: true, value: broken }), seams.effects),
    ).rejects.toThrow('internal defect');
  });

  test('an unavailable tick lock reports no read and no write', async () => {
    const stores = storesFor(caseNamed('new-canonical-old-owner'));
    const trace = new MemoryEffects();
    const seams = attemptEffects(trace, stores, undefined, handoffAt);
    const effects: RepairPreparationEffects = {
      ...seams.effects,
      async withTickLock<T>(): Promise<T> {
        throw new Error('tick busy');
      },
    };
    let produced = false;
    const result = await executeRepairPreparation(async () => {
      produced = true;
      return { ok: false, refusal: 'old-job-unreadable' };
    }, effects);
    expect(produced).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      kind: 'lock-unavailable',
      readGates: 'not-attempted',
      steps: [],
      remainingGates: ALL_GATES,
    });
    expect(trace.entries).toEqual([]);
  });
});
