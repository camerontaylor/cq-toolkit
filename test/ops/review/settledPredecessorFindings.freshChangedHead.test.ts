import { managedTerminal } from '../dev/reviewTestKit.js';
// Split provenance: test/ops/review/settledPredecessorFindings.test.ts was split into the
// settledPredecessorFindings.*.test.ts siblings in this directory; shared fixtures live in
// settledPredecessorFindings.helpers.ts.
import { expect, test, vi } from 'vitest';
import { retainedReceiptFindings } from '../../../src/ops/dev/internal/deferredLedger.js';
import { assembleReadiness } from '../../../src/ops/dev/record.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import {
  cleanDrivers,
  fixtureFactory,
  terminalReport,
} from './settledPredecessorFindings.helpers.js';

const fixture = fixtureFactory();

test.each(['major', 'clean'] as const)(
  'newly settled %s predecessor survives fresh changed-head review without coverage credit',
  async (mode) => {
    const f = await fixture();
    const raw = {
      type: 'finding',
      severity: 'major',
      fileName: 'src/a.ts',
      comment: 'retained original comment',
      codegenInstructions: 'original repair guidance',
    };
    const terminal = terminalReport(f, mode === 'major' ? [raw] : []);
    await f.repo.write('src/a.ts', 'export const a = 2;\n');
    f.repo.commitAll('new head');
    const notifications: { settled: boolean; beforeVendor: boolean }[] = [];
    const note = vi.fn(async () => {
      const latest = f.effects.openLedger(f.state.branch).load();
      notifications.push({
        settled: latest.records.some(
          (entry) => entry.kind === 'vendor-debt' && entry.debt.vendorCompleted,
        ),
        beforeVendor: !f.effects.calls.some((call) => call.command === 'coderabbit'),
      });
    });
    const result = await makeReviewRun({
      managedSubmit: managedTerminal([]),
      drivers: cleanDrivers(),
      queueClient: terminal.client,
      effectsFactory: () => f.effects,
      noteLedgerWrite: note,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: f.repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    if (result.status !== 'ok') throw Error(JSON.stringify(result));
    const ledger = f.effects.openLedger(f.state.branch).load();
    const retained = retainedReceiptFindings(ledger);
    expect(result.report?.deferredVendorDebt).toBeUndefined();
    expect(result.value.head).toBe(f.repo.git('rev-parse', 'HEAD').trim());
    expect(result.value.sources.filter((s) => s.kind === 'coderabbit')).toHaveLength(1);
    expect(result.value.sources.find((s) => s.kind === 'coderabbit')).toMatchObject({
      status: 'terminal',
    });
    expect(f.effects.calls.filter((c) => c.command === 'coderabbit')).toHaveLength(0);
    expect(notifications).toContainEqual({ settled: true, beforeVendor: true });
    const completed = ledger.records.filter((r) => r.kind === 'vendor-debt').at(-1)!.debt;
    expect(completed.vendorCompleted).toBe(true);
    if (!completed.vendorCompleted) throw Error('not settled');
    expect(completed.reference).toEqual(f.debt.reference);
    expect(completed.completion.document.findings).toEqual(mode === 'major' ? [raw] : []);
    if (mode === 'major') {
      expect(retained).toHaveLength(1);
      expect(result.value.findings).toContainEqual(retained[0]);
      expect(retained[0]).toMatchObject({
        severity: 'major',
        status: 'open',
        text: 'original repair guidance',
        evidence: completed.completion.receiptId,
      });
      const ready = assembleReadiness({
        branch: f.state.branch,
        target: 'main',
        identity: { head: result.value.head, base: f.state.base, dirtySha256: 'clean-tree' },
        ledger,
        untracked: [],
        configuredReviewers: ['agent', 'coderabbit'],
        nowIso: f.effects.nowIso(),
      });
      expect(ready.ready).toBe(false);
      if (ready.ready) throw Error('unexpected readiness');
      expect(ready.gaps.map((g) => g.detail).join(' ')).toContain(retained[0]!.id);
    } else expect(retained).toEqual([]);
  },
);
