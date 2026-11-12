/**
 * Process tests for the offline C1 repair dispatch bridge.
 *
 * The prepared job is the exact Python producer artifact recorded in
 * `apps/crq-python/fixtures/crq-repair-prepare-execution/cases.json`
 * (`new-non-canonical`, the durable `write-job` bytes). The artifact comes
 * from the real `makeFixFinding` op over the shared scripted DriverFactory,
 * run through the real kernel `runPlan` and a temporary journal. No provider,
 * network, queue write, production root or hand-written result envelope.
 *
 * Covered: fresh plan/run, moved tip and scan refusals, selection failures,
 * resume retained-ok skip, resume non-ok re-dispatch, `resume: true` without a
 * matching retained artifact, unverified resumed scans, aborted/budget typed
 * harvest, negative binding echo, prepared-job change, the op-owned 32768
 * bound, and read-only journal/prepared-state probes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { WorkerResult } from '../../../src/driver/types.js';
import { openRunLog } from '../../../src/kernel/journal.js';
import { makeManifest } from '../../../src/kernel/manifest.js';
import type { JournalEvent } from '../../../src/kernel/types.js';
import type { Op, OpRegistryEntry } from '../../../src/kernel/types.js';
import type { OpRegistryView } from '../../../src/kernel/runner.js';
import {
  harvestRepairArtifact,
  harvestRepairDispatch,
  planRepairDispatch,
  readRetainedRepairArtifact,
  runRepairDispatch,
  type RepairDispatchCallerContext,
  type RepairDispatchEffects,
  type RepairGuidanceScanEvidence,
  type RepairHarvestEffects,
  type RepairSelectionContext,
  type RepairSourceScanEvidence,
  type RunRepairDispatchResult,
} from '../../../src/ops/crq/internal/repairDispatch.js';
import type { FixFindingOp } from '../../../src/ops/review/fixFinding.js';
import { FixFindingInputSchema } from '../../../src/ops/review/registry.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { receiptJsonDigest, sha256Hex } from '../../../src/policy/crq/pythonJson.js';
import type { RepairRequestContext } from '../../../src/policy/crq/repairRequest.js';
import { completeWorker } from '../review/fixReviewItem.helpers.js';
import { scriptedFindingOp } from '../review/fixFinding.helpers.js';

const PRODUCER_FIXTURE = new URL(
  '../../../apps/crq-python/fixtures/crq-repair-prepare-execution/cases.json',
  import.meta.url,
);

const FIXED = {
  disposition: 'fixed',
  summary: 'Guarded the lock ordering.',
  commits: ['ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'],
  evidence: [],
};

const OTHER = 'b'.repeat(40);
const OTHER_BLOB = 'd'.repeat(40);
const encoder = new TextEncoder();
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

const producerDocument = asObject(parseJsonValue(readFileSync(PRODUCER_FIXTURE, 'utf8')));
const producerCase = asArray(producerDocument.get('execution_cases'))
  .map((entry) => asObject(entry))
  .find((entry) => entry.get('name') === 'new-non-canonical');
if (producerCase === undefined) throw new Error('missing new-non-canonical producer case');

const gateEffects = asObject(producerCase.get('gate_effects'));
const sourceText = asString(gateEffects.get('source_text'));
const sourceSha = asString(gateEffects.get('current_tip'));
const blob = asString(gateEffects.get('blob_oid'));
const sourceSha256 = sha256Hex(encoder.encode(sourceText));

const firstAttempt = asObject(asArray(producerCase.get('attempts'))[0]);
const writeJob = asArray(firstAttempt.get('trace'))
  .map((entry) => asObject(entry))
  .find((entry) => entry.get('kind') === 'write' && entry.get('target') === 'job');
if (writeJob === undefined) throw new Error('missing prepared job producer write');
const preparedJobText = asString(writeJob.get('canonical'));
const preparedJob = asObject(parseJsonValue(preparedJobText));
const jobId = asString(preparedJob.get('job'));
const revalidation = asObject(preparedJob.get('revalidation'));
const revalidationSha256 = receiptJsonDigest(revalidation);

function withPreparedJob(mutate: (job: Record<string, unknown>) => void): string {
  const copy = structuredClone(toPlainJson(preparedJob) as Record<string, unknown>);
  mutate(copy);
  return JSON.stringify(copy);
}

function context(
  overrides: {
    readonly selectedJobId?: string;
    readonly selection?: Partial<RepairSelectionContext>;
    readonly scans?: {
      readonly source?: RepairSourceScanEvidence;
      readonly guidance?: RepairGuidanceScanEvidence;
    };
    readonly requestContext?: Partial<RepairRequestContext>;
  } = {},
): RepairDispatchCallerContext {
  return {
    selectedJobId: overrides.selectedJobId ?? jobId,
    selection: {
      state: 'queued',
      canonicalDelivery: 'verified',
      severity: 'repairable',
      base: sourceSha,
      jobs: [jobId],
      originJob: 'crq-historical-F1',
      revalidationSha256,
      ...overrides.selection,
    },
    scans: {
      source: overrides.scans?.source ?? {
        verdict: 'clean',
        sourceSha,
        sourceBlobSha: blob,
        sourceSha256,
      },
      guidance: overrides.scans?.guidance ?? { verdict: 'absent' },
    },
    requestContext: {
      repo: 'owner/repo',
      worktree: { path: '/tmp/cq-repair-wt', branch: 'cq/repair' },
      driver: { provider: 'test-provider', model: 'test-model' },
      ...overrides.requestContext,
    },
  };
}

interface EffectOptions {
  readonly tip?: string;
  readonly blobOid?: string;
  readonly sourceText?: string;
  readonly preparedJobText?: string;
  readonly tipFailure?: boolean;
  readonly blobFailure?: boolean;
  readonly showFailure?: boolean;
  readonly onRead?: () => void;
}

function effects(options: EffectOptions = {}): RepairDispatchEffects {
  const tip = options.tip ?? sourceSha;
  const observedBlob = options.blobOid ?? blob;
  const text = options.sourceText ?? sourceText;
  const prepared = options.preparedJobText ?? preparedJobText;
  return {
    git: {
      currentTip: async () => {
        if (options.tipFailure === true) throw new Error('tip unavailable');
        return tip;
      },
      blobOid: async () => {
        if (options.blobFailure === true) throw new Error('blob unavailable');
        return observedBlob;
      },
      showFile: async () => {
        if (options.showFailure === true) throw new Error('source unavailable');
        return text;
      },
    },
    readPreparedJob: async (id) => {
      options.onRead?.();
      if (id !== jobId) throw new Error('prepared job missing');
      return prepared;
    },
  };
}

function harvestEffects(options: EffectOptions = {}): RepairHarvestEffects {
  return effects(options);
}

function registryFor(op: FixFindingOp): OpRegistryView {
  return {
    get: (name) =>
      name === 'review.fixFinding'
        ? ({
            name: 'review.fixFinding',
            inputSchema: FixFindingInputSchema,
            importer: async () => op as unknown as Op<never, never>,
          } as OpRegistryEntry<never, never>)
        : undefined,
  };
}

async function tempJournal(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crq-repair-dispatch-'));
  dirs.push(root);
  return join(root, 'journal');
}

async function journalFinished(
  journalDir: string,
): Promise<
  Array<{ readonly runId: string; readonly event: Extract<JournalEvent, { type: 'job-finished' }> }>
> {
  const log = openRunLog(journalDir);
  const runs = await log.runs();
  const finished: Array<{
    readonly runId: string;
    readonly event: Extract<JournalEvent, { type: 'job-finished' }>;
  }> = [];
  for (const runId of runs) {
    for (const event of await log.read(runId)) {
      if (event.type === 'job-finished') {
        finished.push({ runId, event });
      }
    }
  }
  return finished;
}

function planOk(
  result: Awaited<ReturnType<typeof planRepairDispatch>>,
): asserts result is Extract<typeof result, { ok: true }> {
  if (!result.ok) throw new Error(`plan refused: ${result.refusal}`);
}

function runOk(
  result: RunRepairDispatchResult,
): asserts result is Extract<RunRepairDispatchResult, { ok: true }> {
  if (!result.ok) throw new Error(`run refused: ${result.refusal}`);
}

async function freshRun(input: {
  readonly journalDir: string;
  readonly opResults: WorkerResult[];
  readonly contextValue?: RepairDispatchCallerContext;
  readonly effectOptions?: EffectOptions;
}) {
  const scripted = scriptedFindingOp(input.opResults);
  const effect = effects(input.effectOptions);
  const plan = await planRepairDispatch(
    {
      context: input.contextValue ?? context(),
      attempt: { journalDir: input.journalDir, resume: false },
    },
    effect,
  );
  planOk(plan);
  const run = await runRepairDispatch(
    plan.value,
    { resume: false, registry: registryFor(scripted.op) },
    harvestEffects(input.effectOptions),
  );
  return { plan: plan.value, run, scripted };
}

describe('repair dispatch bridge', () => {
  test('plans and runs one fresh F1 job over the real producer job and kernel journal', async () => {
    const journalDir = await tempJournal();
    const scripted = scriptedFindingOp([completeWorker(FIXED)]);
    const effect = effects();
    const plan = await planRepairDispatch(
      { context: context(), attempt: { journalDir, resume: false } },
      effect,
    );
    planOk(plan);
    expect(plan.value.attempt).toBe('fresh');
    expect(plan.value.plan.jobs).toHaveLength(1);
    expect(plan.value.plan.jobs[0]?.op).toBe('review.fixFinding');
    expect(plan.value.binding).toMatchObject({
      job: jobId,
      sourceSha,
      sourceBlobSha: blob,
      repairBase: sourceSha,
    });
    expect(plan.value.source).toEqual({
      sourceSha,
      sourceBlobSha: blob,
      sourceSha256,
      atTip: true,
      blobMatches: true,
    });
    expect(plan.value.preconditions).toEqual({
      selection: 'caller-asserted',
      scans: 'clean',
      binding: 'verified',
      sourceBlob: 'verified',
    });
    expect(plan.value.remainingGates).toEqual([
      'queue-selection',
      'canonical-delivery',
      'severity-selection',
      'invocation-size-bound',
      'dispatch-execution',
      'harvest-disposition',
    ]);
    expect(existsSync(journalDir)).toBe(false);

    const run = await runRepairDispatch(
      plan.value,
      { resume: false, registry: registryFor(scripted.op) },
      harvestEffects(),
    );
    runOk(run);
    expect(scripted.requests).toHaveLength(1);
    expect(run.value.harvest.ok).toBe(true);
    if (!run.value.harvest.ok) return;
    expect(run.value.harvest.value.harvest.status).toBe('ok');
    expect(run.value.harvest.value.binding).toBe('verified');
    expect(run.value.harvest.value.source).toMatchObject({
      observed: true,
      atTip: true,
      blobMatches: true,
    });

    const finished = await journalFinished(journalDir);
    expect(finished).toHaveLength(1);
    const event = finished[0]?.event as {
      readonly result: { readonly status: string; readonly value?: { readonly binding?: unknown } };
      readonly inputsHash: string;
    };
    expect(event.result.status).toBe('ok');
    expect(event.result.value?.binding).toEqual(plan.value.binding);
    const manifest = makeManifest(plan.value.plan);
    expect(event.inputsHash).toBe(manifest.jobs[0]?.inputsHash);
    expect(run.value.artifactJson).toBe(JSON.stringify(event.result));
    expect(run.value.run.jobs[0]?.result).toEqual(event.result);

    const journalFile = join(journalDir, `${finished[0]?.runId ?? ''}.ndjson`);
    const before = await readFile(journalFile, 'utf8');
    const again = await harvestRepairDispatch(plan.value, harvestEffects());
    expect(again.ok).toBe(true);
    const retained = await readRetainedRepairArtifact(
      {
        journalDir,
        plan: plan.value.plan,
        binding: plan.value.binding,
        path: plan.value.path,
      },
      harvestEffects(),
    );
    expect(retained.ok).toBe(true);
    expect(scripted.requests).toHaveLength(1);
    expect(await readFile(journalFile, 'utf8')).toBe(before);
  });

  test('fresh attempts refuse moved tips, unverified scans, binding mismatches and selection failures', async () => {
    const journalDir = await tempJournal();
    const cases: Array<{
      readonly name: string;
      readonly contextValue: RepairDispatchCallerContext;
      readonly effect: RepairDispatchEffects;
      readonly refusal: string;
    }> = [
      {
        name: 'moved tip',
        contextValue: context(),
        effect: effects({ tip: OTHER }),
        refusal: 'source-not-current-tip',
      },
      {
        name: 'unverified source scan',
        contextValue: context({
          scans: { source: { verdict: 'unverified', reason: 'not run' } },
        }),
        effect: effects(),
        refusal: 'scan-unverified',
      },
      {
        name: 'source sha mismatch',
        contextValue: context({
          scans: {
            source: {
              verdict: 'clean',
              sourceSha: OTHER,
              sourceBlobSha: blob,
              sourceSha256,
            },
          },
        }),
        effect: effects(),
        refusal: 'scan-source-sha-mismatch',
      },
      {
        name: 'source blob mismatch',
        contextValue: context({
          scans: {
            source: {
              verdict: 'clean',
              sourceSha,
              sourceBlobSha: OTHER_BLOB,
              sourceSha256,
            },
          },
        }),
        effect: effects(),
        refusal: 'scan-source-blob-mismatch',
      },
      {
        name: 'source content hash mismatch',
        contextValue: context({
          scans: {
            source: {
              verdict: 'clean',
              sourceSha,
              sourceBlobSha: blob,
              sourceSha256: '0'.repeat(64),
            },
          },
        }),
        effect: effects(),
        refusal: 'scan-source-hash-mismatch',
      },
      {
        name: 'guidance mismatch',
        contextValue: context({
          scans: { guidance: { verdict: 'clean', instructionsSha256: '0'.repeat(64) } },
        }),
        effect: effects(),
        refusal: 'scan-guidance-mismatch',
      },
      {
        name: 'selection not queued',
        contextValue: context({ selection: { state: 'not-queued' } }),
        effect: effects(),
        refusal: 'selection-not-queued',
      },
      {
        name: 'canonical delivery failed',
        contextValue: context({ selection: { canonicalDelivery: 'failed' } }),
        effect: effects(),
        refusal: 'canonical-delivery-unverified',
      },
      {
        name: 'severity not repairable',
        contextValue: context({ selection: { severity: 'not-repairable' } }),
        effect: effects(),
        refusal: 'severity-not-repairable',
      },
      {
        name: 'selection base mismatch',
        contextValue: context({ selection: { base: OTHER } }),
        effect: effects(),
        refusal: 'selection-mismatch',
      },
      {
        name: 'observed blob mismatch',
        contextValue: context(),
        effect: effects({ blobOid: OTHER_BLOB }),
        refusal: 'source-blob-mismatch',
      },
      {
        name: 'source unreadable',
        contextValue: context(),
        effect: effects({ showFailure: true }),
        refusal: 'source-content-unreadable',
      },
      {
        name: 'tip unreadable',
        contextValue: context(),
        effect: effects({ tipFailure: true }),
        refusal: 'source-tip-unreadable',
      },
      {
        name: 'blob unreadable',
        contextValue: context(),
        effect: effects({ blobFailure: true }),
        refusal: 'source-blob-unreadable',
      },
      {
        name: 'prepared job unreadable',
        contextValue: context(),
        effect: effects({ preparedJobText: '{}' }),
        refusal: 'prepared-job-unreadable',
      },
    ];
    for (const entry of cases) {
      const result = await planRepairDispatch(
        { context: entry.contextValue, attempt: { journalDir, resume: false } },
        entry.effect,
      );
      expect(result.ok, entry.name).toBe(false);
      if (!result.ok) expect(result.refusal, entry.name).toBe(entry.refusal);
    }
  });

  test('run revalidates the prepared job and fresh tip immediately before invocation', async () => {
    const journalDir = await tempJournal();
    const scripted = scriptedFindingOp([completeWorker(FIXED)]);
    const plan = await planRepairDispatch(
      { context: context(), attempt: { journalDir, resume: false } },
      effects(),
    );
    planOk(plan);

    const moved = await runRepairDispatch(
      plan.value,
      { resume: false, registry: registryFor(scripted.op) },
      harvestEffects({ tip: OTHER }),
    );
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.refusal).toBe('source-not-current-tip');
    expect(existsSync(journalDir)).toBe(false);

    const changed = withPreparedJob((job) => {
      job['source_sha'] = OTHER;
      job['repair_base'] = OTHER;
      (job['revalidation'] as Record<string, unknown>)['source_blob_sha'] = OTHER;
    });
    const stale = await runRepairDispatch(
      plan.value,
      { resume: false, registry: registryFor(scripted.op) },
      harvestEffects({ preparedJobText: changed }),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.refusal).toBe('prepared-job-changed');
    expect(scripted.invocations).toHaveLength(0);
    expect(existsSync(journalDir)).toBe(false);
  });

  test('resume skips a matching retained ok artifact even after the tip moves', async () => {
    const journalDir = await tempJournal();
    const first = await freshRun({ journalDir, opResults: [completeWorker(FIXED)] });
    runOk(first.run);
    const before = first.run.value.artifactJson;

    const plan = await planRepairDispatch(
      { context: context(), attempt: { journalDir, resume: true } },
      effects({ tip: OTHER }),
    );
    planOk(plan);
    expect(plan.value.attempt).toBe('retained-ok');
    expect(plan.value.source.atTip).toBe(false);
    expect(plan.value.remainingGates).toEqual([
      'queue-selection',
      'canonical-delivery',
      'severity-selection',
      'harvest-disposition',
    ]);

    const second = scriptedFindingOp([completeWorker(FIXED)]);
    const run = await runRepairDispatch(
      plan.value,
      { resume: true, registry: registryFor(second.op) },
      harvestEffects({ tip: OTHER }),
    );
    runOk(run);
    expect(second.requests).toHaveLength(0);
    expect(run.value.artifactJson).toBe(before);
    expect(run.value.harvest.ok).toBe(true);
    if (!run.value.harvest.ok) return;
    expect(run.value.harvest.value.harvest.status).toBe('ok');
  });

  test('a retained-ok plan refuses if the retained artifact disappears before invocation', async () => {
    const journalDir = await tempJournal();
    const first = await freshRun({ journalDir, opResults: [completeWorker(FIXED)] });
    runOk(first.run);

    const plan = await planRepairDispatch(
      { context: context(), attempt: { journalDir, resume: true } },
      effects(),
    );
    planOk(plan);
    expect(plan.value.attempt).toBe('retained-ok');

    const journal = (await readdir(journalDir)).find((name) => name.endsWith('.ndjson'));
    expect(journal).toBeDefined();
    if (journal === undefined) return;
    await unlink(join(journalDir, journal));

    const second = scriptedFindingOp([completeWorker(FIXED)]);
    const run = await runRepairDispatch(
      plan.value,
      { resume: true, registry: registryFor(second.op) },
      harvestEffects(),
    );
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.refusal).toBe('attempt-inconsistent');
    expect(second.invocations).toHaveLength(0);
  });

  test('resume re-dispatches a matching retained non-ok artifact', async () => {
    const journalDir = await tempJournal();
    const first = await freshRun({
      journalDir,
      opResults: [completeWorker(undefined, { stopReason: 'aborted' })],
    });
    runOk(first.run);
    const firstHarvest = first.run.value.harvest;
    expect(firstHarvest.ok).toBe(true);
    if (!firstHarvest.ok) return;
    expect(firstHarvest.value.harvest.status).toBe('indeterminate');

    const plan = await planRepairDispatch(
      { context: context(), attempt: { journalDir, resume: true } },
      effects({ tip: OTHER }),
    );
    planOk(plan);
    expect(plan.value.attempt).toBe('resumed');
    expect(plan.value.preconditions.scans).toBe('clean');
    expect(plan.value.remainingGates).toContain('dispatch-execution');

    const second = scriptedFindingOp([completeWorker(FIXED)]);
    const run = await runRepairDispatch(
      plan.value,
      { resume: true, registry: registryFor(second.op) },
      harvestEffects({ tip: OTHER }),
    );
    runOk(run);
    expect(second.requests).toHaveLength(1);
    expect(run.value.harvest.ok).toBe(true);
    if (!run.value.harvest.ok) return;
    expect(run.value.harvest.value.harvest.status).toBe('ok');
  });

  test('resume: true without a matching retained artifact is fresh and refuses a moved tip', async () => {
    const journalDir = await tempJournal();
    const first = await freshRun({ journalDir, opResults: [completeWorker(FIXED)] });
    runOk(first.run);

    const changedJobText = withPreparedJob((job) => {
      const finding = job['finding'] as Record<string, unknown>;
      finding['body'] = 'A different finding body for a new input hash.';
      job['finding_sha256'] = receiptJsonDigest(finding);
    });
    const result = await planRepairDispatch(
      { context: context(), attempt: { journalDir, resume: true } },
      effects({ tip: OTHER, preparedJobText: changedJobText }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('source-not-current-tip');
  });

  test('a resumed attempt may carry unverified scans and still re-dispatch', async () => {
    const journalDir = await tempJournal();
    const first = await freshRun({
      journalDir,
      opResults: [completeWorker(undefined, { stopReason: 'aborted' })],
    });
    runOk(first.run);
    const plan = await planRepairDispatch(
      {
        context: context({
          scans: { source: { verdict: 'unverified', reason: 'scan not rerun' } },
        }),
        attempt: { journalDir, resume: true },
      },
      effects({ tip: OTHER }),
    );
    planOk(plan);
    expect(plan.value.attempt).toBe('resumed');
    expect(plan.value.preconditions.scans).toBe('unverified');
    expect(plan.value.remainingGates).toContain('scan-confirmation');
    const second = scriptedFindingOp([completeWorker(FIXED)]);
    const run = await runRepairDispatch(
      plan.value,
      { resume: true, registry: registryFor(second.op) },
      harvestEffects({ tip: OTHER }),
    );
    runOk(run);
    expect(second.requests).toHaveLength(1);
  });

  test('aborted and budget artifacts harvest typed failure classes', async () => {
    const abortedJournal = await tempJournal();
    const aborted = await freshRun({
      journalDir: abortedJournal,
      opResults: [completeWorker(undefined, { stopReason: 'aborted' })],
    });
    runOk(aborted.run);
    expect(aborted.run.value.harvest.ok).toBe(true);
    if (!aborted.run.value.harvest.ok) return;
    expect(aborted.run.value.harvest.value.harvest).toMatchObject({
      status: 'indeterminate',
      failureClass: 'transient',
    });
    expect(aborted.run.value.harvest.value.binding).toBe('not-ok');

    const budgetJournal = await tempJournal();
    const budget = await freshRun({
      journalDir: budgetJournal,
      opResults: [completeWorker(undefined, { stopReason: 'budget' })],
    });
    runOk(budget.run);
    expect(budget.run.value.harvest.ok).toBe(true);
    if (!budget.run.value.harvest.ok) return;
    expect(budget.run.value.harvest.value.harvest).toMatchObject({
      status: 'budget-exhausted',
      failureClass: 'exhausted',
    });
  });

  test('harvest refuses a mutated ok binding echo without inferring a status', async () => {
    const journalDir = await tempJournal();
    const first = await freshRun({ journalDir, opResults: [completeWorker(FIXED)] });
    runOk(first.run);
    const artifact = JSON.parse(first.run.value.artifactJson) as {
      value: { binding: { job: string } };
    };
    artifact.value.binding.job = 'crq-other-F1';
    const result = await harvestRepairArtifact(
      {
        expectedBinding: first.plan.binding,
        path: first.plan.path,
        artifactJson: JSON.stringify(artifact),
      },
      harvestEffects(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('fixfinding-result-binding-mismatch');
  });

  test('harvest refuses when the durable prepared job changed', async () => {
    const journalDir = await tempJournal();
    const first = await freshRun({ journalDir, opResults: [completeWorker(FIXED)] });
    runOk(first.run);
    const changed = withPreparedJob((job) => {
      job['source_sha'] = OTHER;
      job['repair_base'] = OTHER;
      (job['revalidation'] as Record<string, unknown>)['source_blob_sha'] = OTHER;
    });
    const result = await harvestRepairArtifact(
      {
        expectedBinding: first.plan.binding,
        path: first.plan.path,
        artifactJson: first.run.value.artifactJson,
      },
      harvestEffects({ preparedJobText: changed }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe('prepared-job-changed');
  });

  test('the bridge does not precompute the op-owned 32768 invocation bound', async () => {
    const journalDir = await tempJournal();
    const largeJob = withPreparedJob((job) => {
      const finding = job['finding'] as Record<string, unknown>;
      finding['body'] = 'x'.repeat(7000);
      job['finding_sha256'] = receiptJsonDigest(finding);
    });
    const scripted = scriptedFindingOp([completeWorker(FIXED)]);
    const effect = effects({ preparedJobText: largeJob });
    const plan = await planRepairDispatch(
      {
        context: context({
          requestContext: { promptOverride: 'y'.repeat(40000) },
        }),
        attempt: { journalDir, resume: false },
      },
      effect,
    );
    planOk(plan);
    expect(plan.value.remainingGates).toContain('invocation-size-bound');
    const run = await runRepairDispatch(
      plan.value,
      { resume: false, registry: registryFor(scripted.op) },
      harvestEffects({ preparedJobText: largeJob }),
    );
    runOk(run);
    expect(scripted.invocations).toHaveLength(0);
    expect(run.value.harvest.ok).toBe(true);
    if (!run.value.harvest.ok) return;
    expect(run.value.harvest.value.harvest.status).toBe('failed');
    if (run.value.harvest.value.harvest.status !== 'failed') return;
    expect(run.value.harvest.value.harvest.failureClass).toBe('evidence');
    expect(run.value.harvest.value.artifactJson).toContain('32768');
  });
});
