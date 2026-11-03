// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// capability and advisory retention tests.
import { describe, expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput, workerResult } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('stays complete with an unavailable-rg capability and one deduped advisory', async () => {
    const advisory = 'search tools unavailable: ripgrep not found';
    const rgAbsent = {
      rg: { available: false, minimum: '15.2.0', probe: 'absent' as const },
    };
    const fake = fakeDrivers({
      result: workerResult({
        structuredOutput: { findings: [] },
        capabilities: rgAbsent,
        advisories: [advisory, advisory],
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.findings).toEqual([]);
    expect(result.value.advisories).toEqual([advisory]);
    expect(result.value.limitations).toEqual([]);
    expect(result.value.coverage.pieces[0]?.state).toBe('completed');
    expect(result.value.coverage.sessions[0]).toMatchObject({
      status: 'complete',
      capabilities: rgAbsent,
    });
  });

  it.each([false, undefined] as const)(
    'records no advisory when search is %s and no capability metadata is reported',
    async (searchTools) => {
      const fake = fakeDrivers({
        result: workerResult({ structuredOutput: { findings: [] } }),
      });
      const result = await runAgentReviewer(
        fake.drivers,
        reviewerInput(searchTools === undefined ? {} : { searchTools }),
      );
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.findings).toEqual([]);
      expect(result.value.advisories).toEqual([]);
      expect(result.value.coverage.sessions[0]).not.toHaveProperty('capabilities');
    },
  );

  it('does not synthesize an advisory when search is disabled despite unavailable-rg evidence', async () => {
    const rgAbsent = {
      rg: { available: false, minimum: '15.2.0', probe: 'absent' as const },
    };
    const fake = fakeDrivers({
      result: workerResult({ structuredOutput: { findings: [] }, capabilities: rgAbsent }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput({ searchTools: false }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.advisories).toEqual([]);
    expect(result.value.coverage.sessions[0]).toMatchObject({ capabilities: rgAbsent });
  });

  it('keeps capability evidence and the deduped advisory on an errored session while blocking', async () => {
    const advisory = 'search tools unavailable: ripgrep not found';
    const rgAbsent = {
      rg: { available: false, minimum: '15.2.0', probe: 'absent' as const },
    };
    const fake = fakeDrivers({
      result: workerResult({
        stopReason: 'error',
        error: 'provider exploded',
        capabilities: rgAbsent,
        advisories: [advisory, advisory],
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human' || result.report === undefined) return;
    expect(result.reason).toContain('agent review did not complete (error)');
    expect(result.report.findings).toEqual([]);
    expect(result.report.advisories).toEqual([advisory]);
    expect(result.report.coverage.pieces[0]?.state).toBe('delivered');
    expect(result.report.coverage.sessions[0]).toMatchObject({
      status: 'error',
      capabilities: rgAbsent,
    });
  });

  it('retains capability evidence and the deduped advisory on a budget-settled session', async () => {
    const advisory = 'search tools unavailable: ripgrep not found';
    const rgAbsent = {
      rg: { available: false, minimum: '15.2.0', probe: 'absent' as const },
    };
    const fake = fakeDrivers({
      result: workerResult({
        stopReason: 'budget',
        capabilities: rgAbsent,
        advisories: [advisory, advisory],
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ report: { budgetExhausted: true } });
    if (result.status !== 'needs-human' || result.report === undefined) return;
    expect(result.reason).toContain('agent review budget exhausted');
    expect(result.report.findings).toEqual([]);
    expect(result.report.advisories).toEqual([advisory]);
    expect(result.report.coverage.pieces[0]?.state).toBe('delivered');
    expect(result.report.coverage.sessions[0]).toMatchObject({
      status: 'budget',
      capabilities: rgAbsent,
    });
  });

  it('retains capability evidence and the deduped advisory on invalid structured output', async () => {
    const advisory = 'search tools unavailable: ripgrep not found';
    const rgAbsent = {
      rg: { available: false, minimum: '15.2.0', probe: 'absent' as const },
    };
    const fake = fakeDrivers({
      result: workerResult({
        structuredOutput: { unexpected: true },
        capabilities: rgAbsent,
        advisories: [advisory, advisory],
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human' || result.report === undefined) return;
    expect(result.reason).toContain('agent review returned invalid structured output');
    expect(result.report.findings).toEqual([]);
    expect(result.report.advisories).toEqual([advisory]);
    expect(result.report.coverage.pieces[0]?.state).toBe('delivered');
    expect(result.report.coverage.sessions[0]).toMatchObject({
      status: 'error',
      capabilities: rgAbsent,
    });
  });
});
