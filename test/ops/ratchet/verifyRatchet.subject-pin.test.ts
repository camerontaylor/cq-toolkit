// Issue #1191 — the canonical subject baseline is read at the already
// resolved subject SHA, never by re-resolving the caller's ref. `gitReadBlob`
// is injected at the module seam: `rev-parse` first answers A for a branch
// name, then the ref "moves" (answers B). The canonical baseline read must
// still be requested at A — the guarded commit — not at the moved ref. The
// pre-fix code passed the unresolved `input` into judgeRatchet, so its
// subject-side read followed the ref to B and judged A against B's baseline.
import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RatchetManifest } from '../../../src/ops/ratchet/internal/definitions.js';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';

const holders = vi.hoisted(() => ({
  revParseMock: undefined as undefined | ((repo: string, rev: string) => Promise<string>),
  readBlobMock: undefined as
    | undefined
    | ((repo: string, rev: string, path: string) => Promise<string | null>),
  changedPathsMock: undefined as
    | undefined
    | ((repo: string, from: string, to: string) => Promise<string[]>),
  diffTextMock: undefined as
    | undefined
    | ((repo: string, from: string, to: string, pathspecs: readonly string[]) => Promise<string>),
  mergeBaseMock: undefined as undefined | ((repo: string, a: string, b: string) => Promise<string>),
  reads: [] as Array<{ rev: string; path: string }>,
}));

vi.mock('../../../src/adapters/git/ratchetGit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/adapters/git/ratchetGit.js')>();
  return {
    ...actual,
    gitRevParse: (repo: string, rev: string) => holders.revParseMock?.(repo, rev),
    gitMergeBase: (repo: string, a: string, b: string) => holders.mergeBaseMock?.(repo, a, b),
    gitChangedPaths: (repo: string, from: string, to: string) =>
      holders.changedPathsMock?.(repo, from, to),
    gitDiffText: (repo: string, from: string, to: string, pathspecs: readonly string[]) =>
      holders.diffTextMock?.(repo, from, to, pathspecs),
    gitReadBlob: (repo: string, rev: string, path: string) =>
      holders.readBlobMock?.(repo, rev, path),
  };
});

// The op module is imported AFTER the mock above, so its git seam is injected.
const { createVerifyRatchet } = await import('../../../src/ops/ratchet/verifyRatchet.js');

const TRUST = 'a'.repeat(40);
const SUBJECT_A = 'b'.repeat(40);
const SUBJECT_B = 'c'.repeat(40);

const MANIFEST: RatchetManifest = {
  schemaVersion: 1,
  ratchets: [
    {
      target: 'coverage',
      metric: 'coverage',
      direction: 'higher-is-better',
      unit: 'pct',
      evidence: 'measurement',
    },
  ],
  definitionSet: ['^baselines/ratchets\\.json$'],
};

const coveragePath = baselineRelPath('coverage', 'coverage');

function baselineText(value: number): string {
  return renderBaseline({
    schemaVersion: 1,
    target: 'coverage',
    metric: 'coverage',
    direction: 'higher-is-better',
    value,
    unit: 'pct',
    capturedAt: '2026-09-20T00:00:00.000Z',
  });
}

describe('verifyRatchet pins the subject SHA for the canonical baseline read (#1191)', () => {
  test('a ref that moves between rev-parse and the blob read still judges the guarded commit', async () => {
    holders.reads = [];
    let moved = false;
    // First every rev-parse answers the pre-move SHAs; once the subject is
    // resolved, the ref "moves" — later rev-parse calls answer B.
    holders.revParseMock = async (_repo, rev) => {
      if (rev === 'trust-ref') return TRUST;
      if (rev === 'subject-branch') return moved ? SUBJECT_B : SUBJECT_A;
      if (rev === 'tsconfig.json') return TRUST;
      return rev;
    };
    holders.mergeBaseMock = async () => TRUST;
    holders.changedPathsMock = async () => [];
    holders.diffTextMock = async () => '';
    holders.readBlobMock = async (_repo, rev, path) => {
      if (path === 'baselines/ratchets.json') return JSON.stringify(MANIFEST);
      if (path === 'tsconfig.json') return '{}\n';
      if (path === 'policy/protected-paths.json') {
        return JSON.stringify({ schemaVersion: 1, protectedPaths: [], requiredChecks: [] });
      }
      if (path === coveragePath) {
        holders.reads.push({ rev, path });
        if (rev === TRUST) return baselineText(90);
        if (rev === SUBJECT_A) {
          // The ref moves AFTER the subject resolves but BEFORE the
          // subject-side canonical read (the TOCTOU window).
          moved = true;
          return baselineText(90);
        }
        if (rev === SUBJECT_B) return baselineText(50);
        throw new Error(`unexpected baseline rev ${rev}`);
      }
      return null;
    };

    const verify = createVerifyRatchet({ posture: 'human', layer: 'default' });
    const artifactDir = mkdtempSync(join(tmpdir(), 'cq-subject-pin-'));
    const measurementPath = join(artifactDir, 'measurement.json');
    // Evidence between the two baselines: satisfies the moved ref's
    // loosened 50 but regresses the guarded commit's 90.
    writeFileSync(measurementPath, JSON.stringify({ schemaVersion: 1, metrics: { coverage: 60 } }));
    const outcome = await verify({
      repo: '/repo',
      trustRef: 'trust-ref',
      subject: 'subject-branch',
      subjectKind: 'pr',
      base: 'main',
      measureConclusion: 'success',
      measurementPath,
      typecheckCount: 0,
    });

    // Harness check: the ref really did move mid-verification.
    expect(moved).toBe(true);
    // The subject-side canonical read went to the guarded SHA, not the moved ref.
    const subjectReads = holders.reads.filter((read) => read.path === coveragePath);
    expect(subjectReads.map((read) => read.rev)).toContain(SUBJECT_A);
    expect(subjectReads.map((read) => read.rev)).not.toContain(SUBJECT_B);

    // Behavioural pin: A's own baseline (90) still governs. Evidence 60
    // satisfies B's loosened 50 but regresses A's 90 — a verdict of fail
    // proves the judge used the pinned commit, not the moved ref.
    if (outcome.status !== 'ok')
      throw new Error(`verify ${outcome.status}: ${JSON.stringify(outcome)}`);
    expect(outcome.value.results.find((r) => r.metric === 'coverage')).toMatchObject({
      baseline: 90,
      value: 60,
      verdict: 'fail',
    });
  });
});
