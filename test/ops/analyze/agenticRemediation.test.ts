// Analyze lane G3 — test evidence for the agentic remediation seam: the
// prompt's determinism (a pure function of the cluster, no clocks), the
// invocation defaults that keep the worker from touching the workspace
// (tool mode 'none', sandbox 'read-only'), the stop-reason → frozen-taxonomy
// mapping (complete→ok, error→failed — post-S3 including the lane-settled
// output-invalid schema miss, with errorClass=<x> named in the text,
// budget→budget-exhausted, aborted→indeterminate), the throw mapping (a
// governed-signal abort is indeterminate; a config/auth DispatchError — and
// an UNCLASSIFIED throw, from resolve() or run() alike — is needs-human),
// the honest refusals (no factory wired; a write-capable policy without
// approval — the gate runs BEFORE the factory is consulted), and that the
// op returns the WorkerResult verbatim WITHOUT applying anything. The fakes
// mimic POST-S3 LANES: every lane enforces the invocation's schema, so a
// scripted `complete` carries a schema-valid proposal and a schema miss
// arrives as error/errorClass:'output-invalid'. A fake DriverFactory (a
// scripted resolve over the ADR-0002 §2.5 seam handing back a scripted
// Driver) is the whole harness — no model, no network.
import { describe, expect, test } from 'vitest';
import {
  AGENTIC_PROPOSAL_SCHEMA,
  agenticRemediationPrompt,
  makeAgenticRemediation,
} from '../../../src/ops/analyze/agenticRemediation.js';
import { clusterErrors } from '../../../src/ops/analyze/clusterErrors.js';
import type { AgenticRemediationInput } from '../../../src/ops/analyze/agenticRemediation.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';
import { DispatchError } from '../../../src/driver/errors.js';
import type { DriverFactory, DriverRequest } from '../../../src/driver/factory.js';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { currentJobContext, runLadder } from '../../../src/kernel/governor.js';
import { KnownUsageSummarySchema } from '../../../src/kernel/schema.js';

function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
  return {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    ruleId: 'no-explicit-any',
    message: 'Unexpected any. Specify a different type.',
    severity: 'error',
    ...overrides,
  };
}

/** A realistic two-member cluster (one signature) built through the real G1 clustering. */
function fixtureCluster() {
  const report = clusterErrors({
    tool: 'oxlint',
    exitCode: 1,
    failures: [
      failureOf({ file: 'src/a.ts', line: 5, column: 11 }),
      failureOf({ file: 'src/b.ts', line: 12, column: 3 }),
    ],
  });
  return { report, cluster: report.clusters[0] as NonNullable<(typeof report.clusters)[number]> };
}

/** A scripted driver: records the invocation, returns a canned WorkerResult. */
function fakeDriver(
  result: WorkerResult | ((invocation: OpInvocation) => Promise<WorkerResult> | WorkerResult),
): Driver & { invocations: OpInvocation[] } {
  const invocations: OpInvocation[] = [];
  const run = async (invocation: OpInvocation): Promise<WorkerResult> => {
    invocations.push(invocation);
    return typeof result === 'function' ? result(invocation) : result;
  };
  return { run, invocations } as Driver & { invocations: OpInvocation[] };
}

/**
 * A scripted FACTORY: records every DriverRequest and resolves to the
 * given driver verbatim on the 'ai-sdk' lane with the request's modelSpec
 * (the real factory's lane selection and served-model wrapper are its own
 * concern — test/driver/factory.resolution-*.test.ts and
 * factory.wrappers.test.ts own them).
 */
function fakeFactory(driver: Driver): DriverFactory & { requests: DriverRequest[] } {
  const requests: DriverRequest[] = [];
  return {
    requests,
    resolve: (request: DriverRequest) => {
      requests.push(request);
      return { driver, lane: 'ai-sdk' as const, modelSpec: request.modelSpec };
    },
  };
}

function baseInput(): AgenticRemediationInput {
  const { cluster } = fixtureCluster();
  return {
    clusterId: cluster.id,
    cluster,
    modelSpec: { model: 'glm-4.6', provider: 'zai' },
  };
}

/**
 * A POST-S3 lane's `complete`: the schema rode the invocation,
 * the lane validated the settle-time payload, and the proposal landed. (A
 * proposal-less or invalid proposal never settles `complete` on a real lane
 * — it is error/'output-invalid'.)
 */
const COMPLETE: WorkerResult = {
  structuredOutput: { summary: 'rename foo_bar to fooBar' },
  usage: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  stopReason: 'complete',
};

describe('agenticRemediationPrompt (deterministic, proposal-only)', () => {
  test('the prompt is a pure function of the cluster: byte-identical across calls', () => {
    const first = agenticRemediationPrompt(baseInput());
    const second = agenticRemediationPrompt(baseInput());
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no clocks in the content
  });

  test('the prompt carries the cluster evidence and demands a PROPOSAL, not edits', () => {
    const { cluster } = fixtureCluster();
    const prompt = agenticRemediationPrompt(baseInput());
    expect(prompt).toContain(`cluster id: ${cluster.id}`);
    expect(prompt).toContain('tool: oxlint');
    expect(prompt).toContain(`confidence: ${cluster.confidence}`);
    expect(prompt).toContain(`signature: ${cluster.signature}`);
    expect(prompt).toContain('- src/a.ts:5:11 [error] no-explicit-any:');
    expect(prompt).toContain('do not modify any file');
  });
});

describe('makeAgenticRemediation (the driver-factory seam)', () => {
  test.each(['complete', 'error', 'budget', 'aborted'] as const)(
    'reports paid worker evidence once for %s',
    async (stopReason) => {
      const usage = { input: 120, output: 40, cacheRead: 0, cacheWrite: 0 };
      const worker: WorkerResult = {
        ...COMPLETE,
        usage,
        costUSD: 0.07,
        stopReason,
        ...(stopReason === 'error' ? { errorClass: 'output-invalid' as const } : {}),
      };
      const reported: Array<{ usage?: unknown; costUSD?: number }> = [];
      const outcome = await runLadder(
        () => makeAgenticRemediation(fakeFactory(fakeDriver(worker)))(baseInput()),
        {},
        { op: 'analyze.agenticRemediation', jobKey: 'paid', attempt: 1 },
        { onResult: (result) => reported.push(result) },
      );
      expect(outcome.outcome).toBe('completed');
      expect(reported).toEqual([{ usage, costUSD: 0.07 }]);
    },
  );

  test('a complete run returns the WorkerResult verbatim, with the no-write defaults', async () => {
    const driver = fakeDriver(COMPLETE);
    const result = await makeAgenticRemediation(fakeFactory(driver))(baseInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toEqual(COMPLETE);
    expect(driver.invocations).toHaveLength(1);
    const invocation = driver.invocations[0] as OpInvocation;
    // The op NEVER applies anything: defaults keep the worker read-only.
    expect(invocation.toolPolicy).toEqual({ allow: [], mode: 'none' });
    expect(invocation.sandboxPolicy).toEqual({ level: 'read-only' });
    expect(invocation.budget).toEqual({});
    // The factory echoed the request spec, so the invocation carries it.
    expect(invocation.modelSpec).toEqual({ model: 'glm-4.6', provider: 'zai' });
    expect(invocation.prompt).toContain(`cluster id: ${fixtureCluster().cluster.id}`);
    // The proposal schema rides the invocation (ADR-0002 §2.3) under its
    // stable contract name; the read-only op binds NO workspace.
    expect(invocation.outputSchema?.name).toBe('analyze.agenticRemediation/v1');
    expect(typeof invocation.outputSchema?.schema).toBe('object');
    expect('workspace' in invocation).toBe(false);
  });

  test('the resolve request names the remediator role and the input modelSpec, AFTER the approval gate', async () => {
    const driver = fakeDriver(COMPLETE);
    const factory = fakeFactory(driver);
    await makeAgenticRemediation(factory)(baseInput());
    expect(factory.requests).toEqual([
      { role: 'remediator', modelSpec: { model: 'glm-4.6', provider: 'zai' } },
    ]);
  });

  test('the invocation carries the factory-NORMALISED modelSpec, never the input spec', async () => {
    // The deprecated 'ai-sdk' provider handle is the case normalisation
    // exists for: the fake factory models the real one's behaviour
    // (provider 'ai-sdk' → 'zai') and the invocation must carry the
    // NORMALISED spec.
    const driver = fakeDriver(COMPLETE);
    const normalising: DriverFactory = {
      resolve: (request: DriverRequest) => ({
        driver,
        lane: 'ai-sdk' as const,
        modelSpec: { ...request.modelSpec, provider: 'zai' },
      }),
    };
    await makeAgenticRemediation(normalising)({
      ...baseInput(),
      modelSpec: { model: 'glm-4.6', provider: 'ai-sdk' },
    });
    expect(driver.invocations[0]?.modelSpec).toEqual({ model: 'glm-4.6', provider: 'zai' });
  });

  test('a caller MAY widen the tool policy and set a budget — an explicit, approval-gated decision (R2-2)', async () => {
    const driver = fakeDriver(COMPLETE);
    await makeAgenticRemediation(fakeFactory(driver))({
      ...baseInput(),
      toolPolicy: { allow: ['read'], mode: 'allowlist' },
      budget: { maxTokens: 1000 },
      sessionRef: 'session-1',
      approved: true, // widening beyond read-only is approval-gated
    });
    const invocation = driver.invocations[0] as OpInvocation;
    expect(invocation.toolPolicy).toEqual({ allow: ['read'], mode: 'allowlist' });
    expect(invocation.budget).toEqual({ maxTokens: 1000 });
    expect(invocation.sessionRef).toBe('session-1');
  });

  test('the stop-reason mapping: error→failed (incl. the post-S3 output-invalid miss, class named in the text), budget→budget-exhausted, aborted→indeterminate', async () => {
    // The schema miss a post-S3 lane settles: error/'output-invalid' — the
    // missing proposal is a definitive failed result, never an ok, with
    // the structured class named in the text for humans.
    const missOp = makeAgenticRemediation(
      fakeFactory(
        fakeDriver({
          usage: { input: 120, output: 12, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'error',
          error:
            "subprocess driver: structured output invalid — the result does not validate against schema 'analyze.remediation-proposal/v1'",
          errorClass: 'output-invalid',
        }),
      ),
    );
    const missed = await missOp(baseInput());
    expect(missed.status).toBe('failed');
    if (missed.status === 'failed') {
      expect(missed.error).toContain('run error');
      expect(missed.error).toContain('errorClass=output-invalid');
    }

    // A classless error verdict (a v1 record) maps the same way, minus the
    // class text.
    const op = makeAgenticRemediation(
      fakeFactory(
        fakeDriver({
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'error',
        }),
      ),
    );
    const failed = await op(baseInput());
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') {
      expect(failed.error).not.toContain('errorClass=');
    }

    const budgetOp = makeAgenticRemediation(
      fakeFactory(
        fakeDriver({
          usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'budget',
        }),
      ),
    );
    const exhausted = await budgetOp(baseInput());
    // #1195: the budget stop carries the settled spend on the result envelope.
    expect(exhausted).toEqual({
      status: 'budget-exhausted',
      usageSummary: {
        usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 },
        knownCount: 1,
        unknownCount: 0,
        unpricedCount: 1,
      },
    });

    const abortOp = makeAgenticRemediation(
      fakeFactory(
        fakeDriver({
          usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'aborted',
        }),
      ),
    );
    const aborted = await abortOp(baseInput());
    expect(aborted.status).toBe('indeterminate');
    if (aborted.status === 'indeterminate') {
      expect(aborted.detail).toContain('aborted');
    }
  });

  test('a DispatchError(config) throw is needs-human — a caller/lane misconfiguration, not a coin-flip', async () => {
    const broken: Driver = {
      run: async () => {
        throw new DispatchError('config', "workspace 'nope' does not name an existing directory");
      },
    };
    const result = await makeAgenticRemediation(fakeFactory(broken))(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('could not dispatch');
      expect(result.reason).toContain('config');
      expect(result.reason).toContain('does not name an existing directory');
    }
  });

  test('a factory RESOLVE throw (config) is needs-human too — the unbound-provider surface', async () => {
    // The real factory throws DispatchError('config') for an unbound
    // provider/role; the fake hands the op the same pre-dispatch surface
    // (§2.9: same rows as a thrown run()).
    const broken: DriverFactory = {
      resolve: () => {
        throw new DispatchError('config', "no lane binding for role 'remediator'");
      },
    };
    const result = await makeAgenticRemediation(broken)(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('could not dispatch');
      expect(result.reason).toContain('no lane binding');
    }
  });

  test('a DispatchError(auth) throw is needs-human too', async () => {
    const broken: Driver = {
      run: async () => {
        throw new DispatchError('auth', 'the provider rejected the configured key');
      },
    };
    const result = await makeAgenticRemediation(fakeFactory(broken))(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('auth');
      expect(result.reason).toContain('rejected the configured key');
    }
  });

  test('an UNCLASSIFIED throw is needs-human as well (a lane bug the conformance suite catches)', async () => {
    const broken: Driver = {
      run: async () => {
        throw new Error('connection reset');
      },
    };
    const result = await makeAgenticRemediation(fakeFactory(broken))(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('unclassified');
      expect(result.reason).toContain('connection reset');
    }
  });

  test('a throw under an ALREADY-ABORTED governed signal is indeterminate (the ladder cancellation, I8)', async () => {
    const broken: Driver = {
      run: async () => {
        throw new Error('cancelled mid-run');
      },
    };
    const op = makeAgenticRemediation(fakeFactory(broken));
    const outcome = await runLadder(
      async () => {
        const signal = currentJobContext()?.signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return op(baseInput());
      },
      { wallClockMs: 5, abortGraceMs: 60_000, killGraceMs: 60_000 },
      { op: 'analyze.agenticRemediation', jobKey: 'agentic-abort', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome === 'completed') {
      // The throw happened AFTER the rung-1 signal aborted, so it is the
      // governed cancellation (I8) → indeterminate, NOT needs-human.
      expect(outcome.value.status).toBe('indeterminate');
      if (outcome.value.status === 'indeterminate') {
        expect(outcome.value.detail).toContain('aborted');
        expect(outcome.value.detail).toContain('cancelled mid-run');
      }
    }
  });

  test('a WRITE-CAPABLE policy without approval is refused as needs-human BEFORE the factory is consulted (R2-2)', async () => {
    const driver = fakeDriver(COMPLETE);
    const factory = fakeFactory(driver);
    const op = makeAgenticRemediation(factory);
    for (const widening of [
      { toolPolicy: { allow: ['edit'], mode: 'unrestricted' as const } },
      { sandboxPolicy: { level: 'workspace-write' as const } },
      { sandboxPolicy: { level: 'none' as const } },
      {
        toolPolicy: { allow: [], mode: 'unrestricted' as const },
        sandboxPolicy: { level: 'none' as const },
      },
    ]) {
      const result = await op({ ...baseInput(), ...widening });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason).toContain('approval-gated decision');
        expect(result.reason).toContain('approved: true');
      }
    }
    // The widened invocation never reached the driver — and the approval
    // gate precedes the resolution, so the factory was never asked either.
    expect(driver.invocations).toHaveLength(0);
    expect(factory.requests).toHaveLength(0);
  });

  test('a write-capable policy WITH approved: true proceeds to the driver (R2-2)', async () => {
    const driver = fakeDriver(COMPLETE);
    const result = await makeAgenticRemediation(fakeFactory(driver))({
      ...baseInput(),
      toolPolicy: { allow: [], mode: 'unrestricted' },
      approved: true,
    });
    expect(result.status).toBe('ok');
    expect(driver.invocations).toHaveLength(1);
    const invocation = driver.invocations[0] as OpInvocation;
    expect(invocation.toolPolicy).toEqual({ allow: [], mode: 'unrestricted' });
  });

  test('AGENTIC_PROPOSAL_SCHEMA accepts a proposal and rejects garbage (F1)', () => {
    expect(AGENTIC_PROPOSAL_SCHEMA.parse({ summary: 'rename foo_bar' })).toEqual({
      summary: 'rename foo_bar',
    });
    expect(
      AGENTIC_PROPOSAL_SCHEMA.parse({ summary: 'rename', patch: '-foo_bar\n+fooBar' }),
    ).toEqual({ summary: 'rename', patch: '-foo_bar\n+fooBar' });
    expect(AGENTIC_PROPOSAL_SCHEMA.safeParse({}).success).toBe(false);
    expect(AGENTIC_PROPOSAL_SCHEMA.safeParse({ summary: '' }).success).toBe(false);
    expect(AGENTIC_PROPOSAL_SCHEMA.safeParse({ summary: 's', extra: 1 }).success).toBe(false);
  });

  test('a complete run WITH structuredOutput passes the proposal through verbatim (F1)', async () => {
    const proposal = {
      summary: 'rename foo_bar to fooBar',
      patch: '-const foo_bar\n+const fooBar',
    };
    const driver = fakeDriver({ ...COMPLETE, structuredOutput: proposal });
    const result = await makeAgenticRemediation(fakeFactory(driver))(baseInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Verbatim: the op adds nothing and strips nothing.
    expect(result.value.structuredOutput).toEqual(proposal);
  });

  test('an OMITTED toolPolicy mode is NORMALIZED to none in the invocation — no approval needed, nothing exposed (H1)', async () => {
    // The frozen seam reads an omitted mode as 'allowlist' — pre-H1 this
    // input cleared the gate (gate read 'none') while the driver exposed
    // the Edit tool. The invocation must carry mode 'none' EXPLICITLY.
    const driver = fakeDriver(COMPLETE);
    const result = await makeAgenticRemediation(fakeFactory(driver))({
      ...baseInput(),
      toolPolicy: { allow: ['Edit'] },
    });
    expect(result.status).toBe('ok');
    expect(driver.invocations).toHaveLength(1);
    const invocation = driver.invocations[0] as OpInvocation;
    expect(invocation.toolPolicy).toEqual({ allow: ['Edit'], mode: 'none' });
    // The sandbox normalization is explicit too.
    expect(invocation.sandboxPolicy).toEqual({ level: 'read-only' });
  });

  test('an EXPLICIT allowlist mode is write-capable and refused without approval (H1)', async () => {
    const driver = fakeDriver(COMPLETE);
    const result = await makeAgenticRemediation(fakeFactory(driver))({
      ...baseInput(),
      toolPolicy: { allow: ['Edit'], mode: 'allowlist' },
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain("tool mode 'allowlist'");
    }
    expect(driver.invocations).toHaveLength(0);
  });

  test('a clusterId that does not match cluster.id is a failed result (L3: the id names ITS cluster)', async () => {
    const result = await makeAgenticRemediation(fakeFactory(fakeDriver(COMPLETE)))({
      ...baseInput(),
      clusterId: '00000000',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("clusterId '00000000' does not match cluster.id");
      expect(result.error).toContain(fixtureCluster().cluster.id);
    }
  });

  test('a MISSING factory is a failed result naming the wiring — never a fabricated run', async () => {
    const result = await makeAgenticRemediation(undefined)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('no driver factory is wired');
    }
  });

  test('no state between calls: two invocations are two fresh runs (I6)', async () => {
    const driver = fakeDriver(COMPLETE);
    const factory = fakeFactory(driver);
    const op = makeAgenticRemediation(factory);
    await op(baseInput());
    await op(baseInput());
    expect(driver.invocations).toHaveLength(2);
    expect(driver.invocations[0]).toEqual(driver.invocations[1]);
    expect(factory.requests).toHaveLength(2);
  });
});

// M5b2 — forward governed invocation correlation: the invocation built in
// makeAgenticRemediation carries the runner's governed correlation verbatim
// (plus the helper's preserved role default) when one exists, and stays
// correlation-free when none does. Run/work/parent identity never silently
// inherits the outer job's; no new role is invented here.
describe('makeAgenticRemediation correlation forwarding (M5b2)', () => {
  test('M5b2 nominal evidence', async () => {
    const driver = fakeDriver(COMPLETE);
    const factory = fakeFactory(driver);
    const correlation = { workId: 'w-m5b2', role: 'remediator', runId: 'r-m5b2' } as const;
    const outcome = await runLadder(
      () => makeAgenticRemediation(factory)(baseInput()),
      {},
      {
        op: 'analyze.agenticRemediation',
        jobKey: 'm5b2-nominal',
        attempt: 1,
        correlation: { ...correlation },
      },
    );
    expect(outcome.outcome).toBe('completed');
    expect(driver.invocations).toHaveLength(1);
    expect(driver.invocations[0]!.correlation).toEqual({ ...correlation });
  });

  test('M5b2 missing evidence', async () => {
    const driver = fakeDriver(COMPLETE);
    const factory = fakeFactory(driver);
    const outcome = await runLadder(
      () => makeAgenticRemediation(factory)(baseInput()),
      {},
      { op: 'analyze.agenticRemediation', jobKey: 'm5b2-missing', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    expect(driver.invocations).toHaveLength(1);
    expect(driver.invocations[0]!.correlation).toBeUndefined();
  });

  test('M5b2 failure evidence', async () => {
    const driver = fakeDriver(COMPLETE);
    // Table cases: run/work/parent/role are varied row by row; each row
    // proves the governed correlation's identity fields ride VERBATIM onto
    // the invocation — none silently inherits any outer-job value. Rows
    // with an absent role exercise the shared helper's preserved default;
    // no new role is minted here. (The case name follows the M5b0 literal
    // naming convention; this row set proves the absent-role default, not a
    // failing dispatch.)
    const rows = [
      { workId: 'w-child', parentWorkId: 'w-parent', role: 'remediator' },
      { workId: 'w-other', runId: 'r-9' },
      { workId: 'w-third', role: 'observer', task: 'review a cluster' },
    ] as const;
    let i = 0;
    for (const governed of rows) {
      const outcome = await runLadder(
        () => makeAgenticRemediation(fakeFactory(driver))(baseInput()),
        {},
        {
          op: 'analyze.agenticRemediation',
          jobKey: `m5b2-table-${i++}`,
          attempt: 1,
          correlation: { ...governed },
        },
      );
      expect(outcome.outcome).toBe('completed');
    }
    expect(driver.invocations).toHaveLength(rows.length);
    driver.invocations.forEach((invocation, index) => {
      const governed = rows[index]!;
      expect(invocation.correlation).toEqual({
        ...governed,
        role: ('role' in governed ? governed.role : undefined) ?? 'fixer',
      });
    });
  });
});

// #1195: spend on every exit where it is known — every DRIVER-SERVED terminal
// verdict carries the one-observation usage envelope beside the frozen
// taxonomy, so a standalone caller (direct dispatch, no governed job context)
// sees the invocation's settled spend. Pre-dispatch refusals and throw
// mappings ran no driver, so they carry NO envelope.
describe('#1195 usageSummary on terminal results', () => {
  const DRIVER_USAGE = { input: 120, output: 40, cacheRead: 0, cacheWrite: 0 };

  test('the ok verdict carries the envelope: one known, unpriced observation; value verbatim', async () => {
    const result = await makeAgenticRemediation(fakeFactory(fakeDriver(COMPLETE)))(baseInput());
    expect(result.status).toBe('ok');
    // The WorkerResult still passes through verbatim (the op never re-judges).
    if (result.status === 'ok') expect(result.value).toBe(COMPLETE);
    expect(KnownUsageSummarySchema.parse(result.usageSummary)).toEqual({
      usage: DRIVER_USAGE,
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    });
  });

  test('a priced observation folds costUSD in and unpricedCount stays 0', async () => {
    const priced: WorkerResult = {
      ...COMPLETE,
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.01,
    };
    const result = await makeAgenticRemediation(fakeFactory(fakeDriver(priced)))(baseInput());
    expect(KnownUsageSummarySchema.parse(result.usageSummary)).toEqual({
      usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.01,
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 0,
    });
  });

  test('a driver error verdict (failed) carries the envelope too', async () => {
    const result = await makeAgenticRemediation(
      fakeFactory(
        fakeDriver({
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'error',
          errorClass: 'output-invalid',
        }),
      ),
    )(baseInput());
    expect(result.status).toBe('failed');
    expect(KnownUsageSummarySchema.parse(result.usageSummary)).toEqual({
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    });
  });

  test('an aborted run (indeterminate) still carries the spend of the partial work', async () => {
    const result = await makeAgenticRemediation(
      fakeFactory(
        fakeDriver({
          usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'aborted',
        }),
      ),
    )(baseInput());
    expect(result.status).toBe('indeterminate');
    expect(KnownUsageSummarySchema.parse(result.usageSummary)).toEqual({
      usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 },
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    });
  });

  test('a corrupt usage measurement counts as UNKNOWN, never trusted in part (#1189 rule)', async () => {
    const result = await makeAgenticRemediation(
      fakeFactory(
        fakeDriver({
          usage: { input: -5, output: 1, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
        }),
      ),
    )(baseInput());
    expect(result.status).toBe('ok');
    expect(KnownUsageSummarySchema.parse(result.usageSummary)).toEqual({
      knownCount: 0,
      unknownCount: 1,
      unpricedCount: 1,
    });
  });

  test('no-driver exits carry NO envelope: the no-factory refusal and a dispatch-class throw', async () => {
    const noFactory = await makeAgenticRemediation(undefined)(baseInput());
    expect(noFactory.status).toBe('failed');
    expect(Object.hasOwn(noFactory, 'usageSummary')).toBe(false);

    const broken: Driver = {
      run: async () => {
        throw new DispatchError('auth', 'the provider rejected the configured key');
      },
    };
    const thrown = await makeAgenticRemediation(fakeFactory(broken))(baseInput());
    expect(thrown.status).toBe('needs-human');
    expect(Object.hasOwn(thrown, 'usageSummary')).toBe(false);
  });
});
