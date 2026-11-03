// Split provenance: test/ops/review/addressDeferred.test.ts was split into
// addressDeferred.{admission,fixLoop,cachedFindings,realEngine,queueOwnership,
// importProvenance,emptyFileAdmission}.test.ts. This file holds the cached
// finding retention and content-mismatch reset tests.
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';
import { cycleRecord } from '../dev/fakes.js';
import { config, fixture } from './addressDeferred.helpers.js';

test('cached clean record cannot erase findings from original outage or an unconfigured reviewer', async () => {
  const f = await fixture();
  try {
    await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: [
          ...ledger.records.map((entry) =>
            entry.kind === 'cycle'
              ? {
                  ...entry,
                  findings: [
                    { id: 'original-known', severity: 'major', excerpt: 'retained outage finding' },
                  ],
                }
              : entry,
          ),
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'unconfigured',
            reviewer: 'retired-reviewer',
            findings: [
              { id: 'retired-known', severity: 'major', excerpt: 'still needs disposition' },
            ],
          }),
        ],
      },
      value: undefined,
    }));
    const context = await f.resolver({
      repoRoot: f.repo.root,
      target: 'main',
      base: f.state.base,
      record: f.record(),
    });
    expect(context?.findings.map((finding) => finding.id)).toEqual([
      'original-known',
      'retired-known',
    ]);
    const cached = f.record();
    cached.findings = [
      {
        id: 'original-known',
        source: 'coderabbit',
        severity: 'major',
        text: 'retained outage finding',
        status: 'fixed',
      },
    ];
    const result = await makeReviewAddress({
      config,
      initialRecord: cached,
      resolveDeferredVendorContext: f.resolver,
      disposition: async (root, finding) =>
        makeDevDisposition(f.effects)({
          repoRoot: root,
          findingId: finding.id,
          action: 'deferred',
          why: 'requires owner',
          owner: 'test',
          evidence: [],
          reviewTrigger: 're-check at next head',
        }),
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (finding) => {
          expect(finding.status).toBe('open');
          return {
            finding: { ...finding, status: 'deferred', reason: 'requires owner' },
            observedHead: f.record().head,
            reason: 'requires owner',
            validation: [],
          };
        },
      }),
      review: async () => ({ status: 'ok', value: f.record() }),
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, rounds: 1 });
    expect(result.status).toBe('needs-human');
    expect(result.report?.openBlocking.map((finding) => finding.id)).toEqual([
      'original-known',
      'retired-known',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('P2: a content-mismatched cached row is reset to OPEN and loses its cached reason', async () => {
  const f = await fixture();
  try {
    // The ledger witness is LEGACY: it carries no line/rule/evidence, so a cached
    // row that carries them can never match it.
    await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: ledger.records.map((entry) =>
          entry.kind === 'cycle'
            ? {
                ...entry,
                findings: [
                  { id: 'original-known', severity: 'major', excerpt: 'retained outage finding' },
                ],
              }
            : entry,
        ),
      },
      value: undefined,
    }));
    const cached = f.record();
    cached.findings = [
      {
        id: 'original-known',
        source: 'coderabbit',
        severity: 'major',
        text: 'retained outage finding',
        file: 'src/a.ts',
        line: 7,
        rule: 'no-a',
        status: 'rejected',
        reason: 'cached adjudication',
      },
    ];
    const seen: { status: string; reason?: string }[] = [];
    const result = await makeReviewAddress({
      config,
      initialRecord: cached,
      resolveDeferredVendorContext: f.resolver,
      disposition: async (root, finding) =>
        makeDevDisposition(f.effects)({
          repoRoot: root,
          findingId: finding.id,
          action: 'deferred',
          why: 'requires owner',
          owner: 'test',
          evidence: [],
          reviewTrigger: 're-check at next head',
        }),
      workerFactory: () => ({
        escalation: createEscalationState,
        fix: async (finding) => {
          seen.push({
            status: finding.status,
            ...(finding.reason === undefined ? {} : { reason: finding.reason }),
          });
          return {
            finding: { ...finding, status: 'deferred', reason: 'requires owner' },
            observedHead: f.record().head,
            reason: 'requires owner',
            validation: [],
          };
        },
      }),
      review: async () => ({ status: 'ok', value: f.record() }),
    })({ repoRoot: f.repo.root, source: 'local', journalDir: f.journalDir, rounds: 1 });
    // The cached 'rejected' status and its reason cannot survive a content mismatch:
    // the row reaches the fixer as open, so openBlocking still reports it.
    expect(seen).toEqual([{ status: 'open' }]);
    expect(result.status).toBe('needs-human');
  } finally {
    await f.cleanup();
  }
});
