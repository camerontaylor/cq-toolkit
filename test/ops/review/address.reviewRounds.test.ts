import { join } from 'node:path';
import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
// Split provenance: test/ops/review/address.test.ts was split into this file
// plus address.{helpers.ts,composition,admission,blockedRereview,vendorBoundary,lock,m5b3Correlation}.test.ts.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { makeReviewAddress, type ReviewAddressDeps } from '../../../src/ops/review/address.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import { devLedgerPath } from '../../../src/ops/dev/record.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { config, fixture, finding, reportOf } from './address.helpers.js';

describe('review.address composition', () => {
  test('no token default or missing roles dispatches work; durable report survives every refusal', async () => {
    const f = await fixture();
    try {
      for (const gap of ['budget', 'roles'] as const) {
        const c = { ...config };
        if (gap === 'budget') delete c.budgets;
        else delete c.roles;
        const result = await makeReviewAddress({ ...f.deps, config: c })(f.input);
        expect(result.status).toBe('needs-human');
        expect(f.calls).toEqual([]);
        const report = reportOf(result);
        expect(report.admissionHead).toBeUndefined();
        expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
      }
    } finally {
      await f.cleanup();
    }
  });
  test('stale findings and incomplete review sources refuse before dispatch', async () => {
    const f = await fixture();
    try {
      for (const record of [
        { ...f.record(), head: 'stale' },
        {
          ...f.record(),
          sources: [
            { kind: 'agent' as const, status: 'blocked' as const, reason: 'review unavailable' },
          ],
        },
      ]) {
        const result = await makeReviewAddress({ ...f.deps, initialRecord: record })(f.input);
        expect(result.status).toBe('needs-human');
        expect(f.calls).toEqual([]);
        // A refusal that is not a budget stop never carries the budget marker.
        expect(reportOf(result).stop).toBeUndefined();
      }
    } finally {
      await f.cleanup();
    }
  });
  test('deferred blocking remains open through omitted re-review findings and the round cap', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress(f.deps)({ ...f.input, rounds: 2 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).openBlocking).toMatchObject([
        { id: 'a', status: 'deferred', reason: 'requires owner' },
      ]);
      expect(f.calls.filter((call) => call === 'fix:a')).toHaveLength(1);
      expect(f.calls).toContain('disposition:deferred');
      expect(reportOf(result).reasons).toContain('review round cap reached with open findings');
      // The production round cap carries the structured marker compositions
      // key on — inside the report envelope (the kernel-sanctioned extension),
      // never a top-level field (the strict OpResultSchema would reject it).
      expect(reportOf(result).stop).toBe('round-cap');
      expect(reportOf(result).rounds.map((entry) => entry.round)).toEqual([1, 2]);
    } finally {
      await f.cleanup();
    }
  });
  test('re-review reporting an allegedly fixed defect again keeps it open', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (finding) => ({
            finding: { ...finding, status: 'fixed', reason: 'claimed' },
            commit: 'a'.repeat(40),
            observedHead: f.record().head,
            reason: 'claimed',
            validation: [],
          }),
        }),
        review: async () => ({ status: 'ok', value: f.record() }),
      })({ ...f.input, rounds: 1 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).openBlocking[0]?.status).toBe('open');
      // #490: the validated re-review's rows are authoritative; the earlier
      // claimed fix never overwrites the reopened row.
      expect(reportOf(result).findings.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'a', status: 'open' },
      ]);
    } finally {
      await f.cleanup();
    }
  });
  test('local re-review uploads the prior round findings with their final dispositions', async () => {
    const f = await fixture();
    try {
      let priorFindings: readonly Finding[] | undefined;
      const result = await makeReviewAddress({
        ...f.deps,
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (finding) => ({
            finding: { ...finding, status: 'fixed', reason: 'verified candidate bytes' },
            observedHead: f.record().head,
            reason: 'verified candidate bytes',
            validation: [],
          }),
        }),
        review: async (input) => {
          priorFindings = input.priorFindings;
          return {
            status: 'ok',
            value: { ...f.record(), findings: [], advisories: ['re-review advisory'] },
          };
        },
      })({ ...f.input, rounds: 1 });
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      expect(priorFindings).toEqual([
        expect.objectContaining({
          id: 'a',
          status: 'fixed',
          reason: 'verified candidate bytes',
        }),
      ]);
      expect(reportOf(result).advisories).toEqual(['re-review advisory']);
    } finally {
      await f.cleanup();
    }
  });
  test('review advisories stay report context and never enter findings', async () => {
    const f = await fixture([]);
    try {
      const deps = {
        ...f.deps,
        initialRecord: {
          ...f.record(),
          advisories: ['lockfile excluded: assured by dev.check'],
        },
      };
      const result = await makeReviewAddress(deps)(f.input);
      expect(result.status).toBe('ok');
      expect(reportOf(result).advisories).toEqual(['lockfile excluded: assured by dev.check']);
      expect(reportOf(result).findings).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  test('a disposition persistence failure cannot become a clean run when re-review omits it', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress({
        ...f.deps,
        disposition: async () => ({ status: 'failed', error: 'ledger unavailable' }),
      })({ ...f.input, rounds: 1 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.some((reason) => reason.includes('ledger unavailable'))).toBe(
        true,
      );
    } finally {
      await f.cleanup();
    }
  });
  test('#490: a failed disposition write leaves the dispatched row open', async () => {
    const f = await fixture();
    try {
      const result = await makeReviewAddress({
        ...f.deps,
        disposition: async () => ({ status: 'failed', error: 'ledger unavailable' }),
        review: async () => ({
          status: 'needs-human',
          reason: 'review.run: not every configured reviewer completed a terminal cycle',
        }),
      })({ ...f.input, rounds: 1 });
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).fixes.map((fix) => fix.finding.status)).toEqual(['open']);
      expect(reportOf(result).findings.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'a', status: 'open' },
      ]);
      // An unpersisted outcome never leaves the blockers.
      expect(reportOf(result).openBlocking.map(({ id }) => id)).toEqual(['a']);
      expect(JSON.parse(await readFile(reportOf(result).reportPath, 'utf8'))).toEqual(
        reportOf(result),
      );
    } finally {
      await f.cleanup();
    }
  });
  test('invalid source still emits its report and clean complete findings exit ok without workers', async () => {
    const f = await fixture([]);
    try {
      const invalid = await makeReviewAddress(f.deps)({ ...f.input, source: 'pr:0' });
      expect(invalid.status).toBe('failed');
      expect(reportOf(invalid).usage.input).toBe(0);
      expect(reportOf(invalid).admissionHead).toBeUndefined();
      const clean = await makeReviewAddress(f.deps)(f.input);
      expect(clean.status).toBe('ok');
      // The clean exit is admitted through `admitCleanRecord`'s final guards, so
      // it carries the engine-read head even though no worker ran.
      expect(reportOf(clean).admissionHead).toBe(f.record().head);
      expect(f.calls).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  test('a successful re-review refreshes the first-round record but not the admission witness', async () => {
    const f = await fixture([finding('a')]);
    const { disposition: _bypass, ...realDeps } = f.deps;
    try {
      // Real admission writes the engine's own ledger, so the fixture must ignore
      // `.cq/` before the run: the clean exit validates a clean publication tree.
      await f.repo.write('.gitignore', '/.cq/\n');
      f.repo.commitAll('ignore engine state');
      const admittedHead = f.record().head;
      let fixedHead = '';
      const deps: ReviewAddressDeps = {
        ...realDeps,
        initialRecord: f.record(),
        // Real admission: the injected disposition would bypass `admitRecord`,
        // and a bypass may never fabricate a witness.
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (target) => {
            await f.repo.write(`src/${target.id}.ts`, 'export const fixed = 1;\n');
            fixedHead = f.repo.commitAll(`fix ${target.id}`);
            return {
              finding: { ...target, status: 'fixed' as const, reason: 'fixed' },
              reason: 'fixed',
              observedHead: fixedHead,
              commit: fixedHead,
              validation: [],
            };
          },
        }),
        review: async () => ({
          status: 'ok' as const,
          value: { ...f.record(), head: fixedHead, findings: [] },
        }),
      };
      const result = await makeReviewAddress(deps)({ ...f.input, rounds: 1 });
      const report = reportOf(result);
      await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
      expect(fixedHead).not.toBe(admittedHead);
      // The mutable producer view really was refreshed to the verified fix head…
      expect(report.rounds[0]?.record.head).toBe(fixedHead);
      // …while the immutable witness still names the admitted head.
      expect(report.admissionHead).toBe(admittedHead);
      expect(report.verifiedHead).toBe(fixedHead);
      expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
    } finally {
      await f.cleanup();
    }
  });
  test.each(['', '   \n'])(
    'blank finding evidence (%j) records an empty evidence list, never [""]',
    async (blank) => {
      const f = await fixture([{ ...finding('a'), evidence: blank }]);
      const { disposition: _bypass, ...realDeps } = f.deps;
      try {
        await f.repo.write('.gitignore', '/.cq/\n');
        f.repo.commitAll('ignore engine state');
        let fixedHead = '';
        const result = await makeReviewAddress({
          ...realDeps,
          initialRecord: f.record(),
          workerFactory: () => ({
            escalation: createEscalationState,
            fix: async (target) => {
              await f.repo.write(`src/${target.id}.ts`, 'export const fixed = 1;\n');
              fixedHead = f.repo.commitAll(`fix ${target.id}`);
              return {
                finding: { ...target, status: 'fixed' as const, reason: 'fixed' },
                reason: 'fixed',
                observedHead: fixedHead,
                commit: fixedHead,
                validation: [],
              };
            },
          }),
          review: async () => ({
            status: 'ok' as const,
            value: { ...f.record(), head: fixedHead, findings: [] },
          }),
        })({ ...f.input, rounds: 1 });
        const report = reportOf(result);
        await expectOpaqueIncomplete(result, join(f.repo.root, '.git'));
        const ledger = JSON.parse(
          await readFile(devLedgerPath(f.repo.root, 'feature/x'), 'utf8'),
        ) as { records: { kind: string; findingId?: string; evidence?: unknown }[] };
        const recorded = ledger.records.find(
          (entry) => entry.kind === 'disposition' && entry.findingId === 'a',
        );
        expect(recorded, report.reasons.join(' | ')).toBeDefined();
        expect(recorded?.evidence).toEqual([]);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a head-matching record refused for its sources never fabricates a witness', async () => {
    const f = await fixture([finding('a')]);
    const { disposition: _bypass, ...realDeps } = f.deps;
    try {
      const result = await makeReviewAddress({
        ...realDeps,
        initialRecord: { ...f.record(), sources: [] },
      })(f.input);
      expect(result.status).toBe('needs-human');
      expect(reportOf(result).reasons.join(' ')).toMatch(/review source incomplete/);
      // The head matched, but the run refused before any admission.
      expect(reportOf(result).admissionHead).toBeUndefined();
      expect(f.calls).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});
