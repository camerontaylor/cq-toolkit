// Analyze lane G3 — test evidence for the agentic remediation seam: the
// prompt's determinism (a pure function of the cluster, no clocks), the
// invocation defaults that keep the worker from touching the workspace
// (tool mode 'none', sandbox 'read-only'), the stop-reason → frozen-taxonomy
// mapping (complete→ok, error→failed, budget→budget-exhausted,
// aborted→indeterminate), the honest refusals (no driver wired; a driver
// that rejects), and that the op returns the WorkerResult verbatim WITHOUT
// applying anything. A fake Driver (a scripted run() over the frozen seam)
// is the whole harness — no model, no network.
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import {
  AGENTIC_PROPOSAL_SCHEMA,
  agenticRemediationPrompt,
  makeAgenticRemediation,
} from '../../../src/ops/analyze/agenticRemediation.js';
import { clusterErrors } from '../../../src/ops/analyze/clusterErrors.js';
import type { AgenticRemediationInput } from '../../../src/ops/analyze/agenticRemediation.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';

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

function baseInput(): AgenticRemediationInput {
  const { cluster } = fixtureCluster();
  return {
    clusterId: cluster.id,
    cluster,
    modelSpec: { model: 'glm-4.6', provider: 'zai' },
  };
}

const COMPLETE: WorkerResult = {
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

describe('makeAgenticRemediation (the driver seam)', () => {
  test('a complete run returns the WorkerResult verbatim, with the no-write defaults', async () => {
    const driver = fakeDriver(COMPLETE);
    const result = await makeAgenticRemediation(driver)(baseInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toEqual(COMPLETE);
    expect(driver.invocations).toHaveLength(1);
    const invocation = driver.invocations[0] as OpInvocation;
    // The op NEVER applies anything: defaults keep the worker read-only.
    expect(invocation.toolPolicy).toEqual({ allow: [], mode: 'none' });
    expect(invocation.sandboxPolicy).toEqual({ level: 'read-only' });
    expect(invocation.budget).toEqual({});
    expect(invocation.modelSpec).toEqual({ model: 'glm-4.6', provider: 'zai' });
    expect(invocation.prompt).toContain(`cluster id: ${fixtureCluster().cluster.id}`);
  });

  test('a caller MAY widen the tool policy and set a budget — an explicit, approval-gated decision (R2-2)', async () => {
    const driver = fakeDriver(COMPLETE);
    await makeAgenticRemediation(driver)({
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

  test('the stop-reason mapping: error→failed, budget→budget-exhausted, aborted→indeterminate', async () => {
    const op = makeAgenticRemediation(
      fakeDriver({
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'error',
      }),
    );
    const failed = await op(baseInput());
    expect(failed.status).toBe('failed');

    const budgetOp = makeAgenticRemediation(
      fakeDriver({
        usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'budget',
      }),
    );
    const exhausted = await budgetOp(baseInput());
    expect(exhausted).toEqual({ status: 'budget-exhausted' });

    const abortOp = makeAgenticRemediation(
      fakeDriver({
        usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'aborted',
      }),
    );
    const aborted = await abortOp(baseInput());
    expect(aborted.status).toBe('indeterminate');
    if (aborted.status === 'indeterminate') {
      expect(aborted.detail).toContain('aborted');
    }
  });

  test('a driver whose run() REJECTS is indeterminate (no WorkerResult ever existed)', async () => {
    const broken: Driver = {
      run: async () => {
        throw new Error('connection reset');
      },
    };
    const result = await makeAgenticRemediation(broken)(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('connection reset');
    }
  });

  test('a WRITE-CAPABLE policy without approval is refused as needs-human (R2-2)', async () => {
    const driver = fakeDriver(COMPLETE);
    const op = makeAgenticRemediation(driver);
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
    // The widened invocation never reached the driver.
    expect(driver.invocations).toHaveLength(0);
  });

  test('a write-capable policy WITH approved: true proceeds to the driver (R2-2)', async () => {
    const driver = fakeDriver(COMPLETE);
    const result = await makeAgenticRemediation(driver)({
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
    const result = await makeAgenticRemediation(driver)(baseInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Verbatim: the op adds nothing and strips nothing.
    expect(result.value.structuredOutput).toEqual(proposal);
  });

  test('a clusterId that does not match cluster.id is a failed result (L3: the id names ITS cluster)', async () => {
    const result = await makeAgenticRemediation(fakeDriver(COMPLETE))({
      ...baseInput(),
      clusterId: '00000000',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("clusterId '00000000' does not match cluster.id");
      expect(result.error).toContain(fixtureCluster().cluster.id);
    }
  });

  test('a MISSING driver is a failed result naming the wiring — never a fabricated run', async () => {
    const result = await makeAgenticRemediation(undefined)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('no driver is wired');
    }
  });

  test('no state between calls: two invocations are two fresh runs (I6)', async () => {
    const driver = fakeDriver(COMPLETE);
    const op = makeAgenticRemediation(driver);
    await op(baseInput());
    await op(baseInput());
    expect(driver.invocations).toHaveLength(2);
    expect(driver.invocations[0]).toEqual(driver.invocations[1]);
  });
});
