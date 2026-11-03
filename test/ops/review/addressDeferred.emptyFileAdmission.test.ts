// Split provenance: test/ops/review/addressDeferred.test.ts was split into
// addressDeferred.{admission,fixLoop,cachedFindings,realEngine,queueOwnership,
// importProvenance,emptyFileAdmission}.test.ts. This file holds the real
// admission path for empty-file and absent-file finding identities.
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { cycleRecord } from '../dev/fakes.js';
import { config, fixture } from './addressDeferred.helpers.js';

test.each([false, true])(
  'real admission preserves empty-file identity and OPEN nondispatchable debt (absent companion=%s)',
  async (withAbsent) => {
    const f = await fixture();
    try {
      const { assembleReadiness } = await import('../../../src/ops/dev/record.js');
      const record = f.record();
      const coverage = record.sources[1]?.coverage;
      if (!coverage || !('version' in coverage) || coverage.version !== 2)
        throw new Error('fixture requires genuine v2 agent coverage');
      // Match the genuine full agent source supplied by fixture(), without inventing
      // any finding witness or letting the import cycle lend disposition authority.
      await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
        ledger: {
          ...ledger,
          records: [
            ...ledger.records,
            cycleRecord({
              cycleId: 'agent-current-empty-file',
              reviewer: 'agent:reviewer',
              head: f.state.head,
              base: f.state.base,
              dirtySha256: 'clean-tree',
              agentCoverage: coverage,
            }),
          ],
        },
        value: undefined,
      }));
      record.findings = [
        {
          id: 'empty-file',
          source: 'coderabbit',
          severity: 'major',
          text: 'empty identity',
          file: '',
          status: 'open',
        },
      ];
      if (withAbsent)
        record.findings.push({
          id: 'absent-file',
          source: 'coderabbit',
          severity: 'major',
          text: 'absent identity',
          status: 'open',
        });
      const fixed: string[] = [];
      let reviews = 0;
      const result = await makeReviewAddress({
        config,
        initialRecord: record,
        resolveDeferredVendorContext: f.resolver,
        // NO deps.disposition: that seam bypasses admitRecord entirely (1088 at 9d).
        // The stopped predecessor's missing import cycle was caused by that bypass,
        // not evidence that dispatch was unentered or batching changed the finding.
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (finding) => {
            fixed.push(finding.id);
            return {
              finding: { ...finding, status: 'deferred', reason: 'requires owner' },
              observedHead: f.state.head,
              reason: 'requires owner',
              validation: [],
            };
          },
        }),
        review: async () => {
          reviews++;
          return { status: 'ok', value: f.record() };
        },
      })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, rounds: 1 });
      const reason = 'unresolved: finding has no file path';
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'needs-human' });
      if (result.status !== 'needs-human' || !result.report)
        throw new Error('missing refusal report');
      const report = result.report;
      expect(result.reason).toBe(`${reason}; report: ${report.reportPath}`);
      expect(report.reasons).toContain(reason);
      expect(report.admissionHead).toBe(f.state.head);
      expect(report.findings.find((row) => row.id === 'empty-file')).toMatchObject({
        file: '',
        status: 'open',
        reason,
      });
      expect(report.openBlocking.find((row) => row.id === 'empty-file')).toMatchObject({
        file: '',
        status: 'open',
        reason,
      });
      expect(fixed).toEqual(withAbsent ? ['absent-file'] : []);
      expect(reviews).toBe(0);
      expect(report.fixes.some((fix) => fix.finding.id === 'empty-file')).toBe(false);
      expect(report.fixesPerRun).toBe(0);
      expect(report.rounds).toHaveLength(1);
      if (!withAbsent) expect(report.rounds[0]?.runs).toEqual([]);
      const ledger = f.effects.openLedger(f.state.branch).load();
      const imported = ledger.records.findLast(
        (entry) => entry.kind === 'cycle' && entry.reviewer === 'review.address:import',
      );
      expect(imported?.kind).toBe('cycle');
      if (imported?.kind !== 'cycle') throw new Error('real import cycle missing');
      expect(imported.findings.find((row) => row.id === 'empty-file')).toHaveProperty(
        'fileName',
        '',
      );
      if (withAbsent)
        expect(imported.findings.find((row) => row.id === 'absent-file')).not.toHaveProperty(
          'fileName',
        );
      expect(
        ledger.records.some(
          (entry) => entry.kind === 'disposition' && entry.findingId === 'empty-file',
        ),
      ).toBe(false);
      const readiness = assembleReadiness({
        branch: f.state.branch,
        target: 'main',
        identity: { base: f.state.base, head: f.state.head, dirtySha256: 'clean-tree' },
        ledger,
        untracked: [],
        nowIso: f.effects.nowIso(),
      });
      expect(readiness.ready).toBe(false);
      if (readiness.ready) throw new Error('pathless OPEN finding cannot be ready');
      const gap = readiness.gaps.find((entry) => entry.field === 'open-blocking-findings');
      expect(gap?.detail).toContain('empty-file');
      expect(gap?.detail).toContain(reason);
    } finally {
      await f.cleanup();
    }
  },
);
