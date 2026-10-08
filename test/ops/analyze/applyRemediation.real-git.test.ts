// Real Git evidence for the promotion F3 report exception. Kept separate
// from the pure apply tests so only this file needs the process budget.
import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ApprovalState, ApprovalStateReader } from '../../../src/ops/analyze/approval.js';
import {
  makeApprovalAuthority,
  makeGitApprovalStateReader,
  makeInMemoryNonceLedger,
  makeProcessLocalMutationLocks,
} from '../../../src/ops/analyze/approval.js';
import type { AnalyzeFileStore } from '../../../src/ops/analyze/analysisStore.js';
import { pathAnalysisFileStore } from '../../../src/ops/analyze/analysisStore.js';
import { makeApplyRemediation } from '../../../src/ops/analyze/applyRemediation.js';
import { clusterErrors } from '../../../src/ops/analyze/clusterErrors.js';
import { makeRenderAnalysisReport } from '../../../src/ops/analyze/renderAnalysisReport.js';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';

const FIXTURE_FILES = {
  'src/a.ts': 'const foo_bar = 1;\n',
  'src/b.ts': 'export const foo_bar = 2;\n',
};

function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
  return {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    ruleId: 'no-unused-vars',
    message: "'x' is assigned a value but never used",
    severity: 'error',
    ...overrides,
  };
}

function fixtureReport() {
  return clusterErrors({
    tool: 'eslint',
    exitCode: 1,
    failures: Object.keys(FIXTURE_FILES).map((file) => failureOf({ file })),
  });
}

function baseInput() {
  return {
    clusterId: fixtureReport().clusters[0]?.id ?? '',
    approved: true,
    rule: 'id: rename\nlanguage: ts\nrule:\n  pattern: foo_bar',
    dryRun: false,
  };
}

function codemodRunner(files: Record<string, string>): RunCheck {
  return async () => ({
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify(
      Object.entries(files).map(([file, text]) => ({
        file,
        replacement: 'fooBar',
        replacementOffsets: { start: text.indexOf('foo_bar'), end: text.indexOf('foo_bar') + 7 },
      })),
    ),
  });
}

function approvedAuthority(reader: ApprovalStateReader, signedState: ApprovalState) {
  const ledger = makeInMemoryNonceLedger();
  const authority = makeApprovalAuthority({
    approvals: {
      verifiedFor: (subject) =>
        Promise.resolve({
          nonce: `nonce-${subject.inputDigest}`,
          state: signedState,
        }),
    },
    ledger,
    locks: makeProcessLocalMutationLocks(),
    readState: reader,
  });
  return { authority, ledger };
}

function makeOp(
  store: AnalyzeFileStore,
  run: RunCheck,
  authority: ReturnType<typeof makeApprovalAuthority>,
) {
  return makeApplyRemediation(() => store, run, authority);
}

// Promotion F3: real render outputs + the real Git state predicate, with
// only the codemod subprocess faked. No ignore rules or blanket exemptions.
describe('rendered reports at the apply approval boundary (promotion F3)', () => {
  async function repoFixture() {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cq-report-approval-')));
    const git = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'approval@example.invalid']);
    git(['config', 'user.name', 'approval test']);
    mkdirSync(join(repo, 'src'));
    for (const [path, text] of Object.entries(FIXTURE_FILES)) writeFileSync(join(repo, path), text);
    // Track only the source files; the render pair must be genuinely untracked.
    git(['add', 'src/a.ts', 'src/b.ts']);
    git(['commit', '-q', '-m', 'approved source state']);
    const reader = makeGitApprovalStateReader();
    const signedState = await reader.read(repo);
    expect(signedState.treeClean).toBe(true);
    const store = pathAnalysisFileStore(repo);
    const rendered = await makeRenderAnalysisReport(() => store)({
      report: fixtureReport(),
      dir: repo,
    });
    if (rendered.status !== 'ok') throw new Error('fixture render failed');
    expect((await reader.read(repo)).treeClean).toBe(false);
    return { repo, git, reader, signedState, store, paths: rendered.value };
  }

  test.each([false, true])(
    'only the exact render pair is admitted; unrelated untracked file = %s',
    async (unrelated) => {
      const fixture = await repoFixture();
      try {
        if (unrelated) writeFileSync(join(fixture.repo, 'unrelated.txt'), 'unapproved bytes');
        const { authority, ledger } = approvedAuthority(fixture.reader, fixture.signedState);
        const result = await makeOp(
          fixture.store,
          codemodRunner(FIXTURE_FILES),
          authority,
        )({
          ...baseInput(),
          dir: fixture.repo,
          sidecarPath: fixture.paths.sidecarPath,
        });
        expect(result.status).toBe(unrelated ? 'needs-human' : 'ok');
        expect(ledger.spent()).toBe(unrelated ? 0 : 1);
        expect(readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8')).toBe(
          unrelated ? FIXTURE_FILES['src/a.ts'] : 'const fooBar = 1;\n',
        );
        if (result.status === 'needs-human') expect(result.reason).toContain('workspace dirty');
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    },
  );

  test.each(['sidecarPath', 'markdownPath'] as const)(
    'a symlink at the exact %s is refused at admission',
    async (key) => {
      const fixture = await repoFixture();
      try {
        const report = fixture.paths[key];
        const original = readFileSync(report);
        // Point at a regular file INSIDE the workspace with identical bytes:
        // neither a matching digest nor containment can excuse a leaf symlink.
        const referent = join(fixture.repo, '.git', 'report-referent');
        writeFileSync(referent, original);
        unlinkSync(report);
        symlinkSync(referent, report);
        const { authority, ledger } = approvedAuthority(fixture.reader, fixture.signedState);
        const result = await makeOp(
          fixture.store,
          codemodRunner(FIXTURE_FILES),
          authority,
        )({
          ...baseInput(),
          dir: fixture.repo,
          sidecarPath: fixture.paths.sidecarPath,
        });
        expect(result.status).toBe('needs-human');
        expect(result.status === 'needs-human' ? result.reason : '').toContain('regular file');
        expect(ledger.spent()).toBe(0);
        expect(readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8')).toBe(
          FIXTURE_FILES['src/a.ts'],
        );
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    },
  );

  test.each(['symlink', 'bytes', 'unrelated'] as const)(
    'the lock-window re-check refuses report/workspace drift: %s',
    async (change) => {
      const fixture = await repoFixture();
      try {
        let reads = 0;
        const reader: ApprovalStateReader = {
          read: async (workspace, subject) => {
            reads += 1;
            if (reads === 2) {
              if (change === 'symlink') {
                const referent = join(fixture.repo, '.git', 'report-referent');
                writeFileSync(referent, readFileSync(fixture.paths.markdownPath));
                unlinkSync(fixture.paths.markdownPath);
                symlinkSync(referent, fixture.paths.markdownPath);
              } else if (change === 'bytes') {
                writeFileSync(fixture.paths.markdownPath, 'changed report');
              } else {
                writeFileSync(join(fixture.repo, 'unrelated.txt'), 'changed workspace');
              }
            }
            return fixture.reader.read(workspace, subject);
          },
        };
        const { authority, ledger } = approvedAuthority(reader, fixture.signedState);
        const result = await makeOp(
          fixture.store,
          codemodRunner(FIXTURE_FILES),
          authority,
        )({
          ...baseInput(),
          dir: fixture.repo,
          sidecarPath: fixture.paths.sidecarPath,
        });
        expect(result.status).toBe('needs-human');
        const reason = result.status === 'needs-human' ? result.reason : '';
        expect(reason).toContain('approval state changed since approval');
        expect(reason).not.toContain("between the kernel's verification");
        expect(reason).toContain('UNSPENT');
        expect(reads).toBe(2);
        expect(ledger.spent()).toBe(0);
        expect(readFileSync(join(fixture.repo, 'src/a.ts'), 'utf8')).toBe(
          FIXTURE_FILES['src/a.ts'],
        );
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    },
  );

  test.each(['symlink', 'hardlink'] as const)(
    'a report target %s alias is refused even when it has no planned edits',
    async (kind) => {
      const fixture = await repoFixture();
      const alias = kind === 'symlink' ? symlinkSync : linkSync;
      try {
        // A scan target with no edit is still forbidden: the rule may read it.
        // Track the alias so the refusal proves target separation, not dirt.
        alias(fixture.paths.markdownPath, join(fixture.repo, 'src', 'report-alias.ts'));
        fixture.git(['add', 'src/report-alias.ts']);
        fixture.git(['commit', '-q', '-m', 'track alias']);
        const report = clusterErrors({
          tool: 'eslint',
          exitCode: 1,
          failures: [
            ...fixtureReport().clusters.flatMap((cluster) => cluster.failures),
            failureOf({
              file: 'src/report-alias.ts',
              line: 1,
              message: "'alias' is assigned a value but never used",
            }),
          ],
        });
        // The old markdown is retained as the alias target. The new report
        // pair is the only exception; keeping old reports must stay dirty.
        const rendered = await makeRenderAnalysisReport(() => fixture.store)({
          report,
          dir: fixture.repo,
        });
        if (rendered.status !== 'ok') throw new Error('alias fixture render failed');
        // Repoint the tracked alias at the current pair and commit the link.
        unlinkSync(join(fixture.repo, 'src', 'report-alias.ts'));
        alias(rendered.value.markdownPath, join(fixture.repo, 'src', 'report-alias.ts'));
        fixture.git(['add', 'src/report-alias.ts']);
        fixture.git(['commit', '-q', '-m', 'point alias at current report']);
        // Re-render with the alias digest now matching the actual current bytes.
        const finalRender = await makeRenderAnalysisReport(() => fixture.store)({
          report,
          dir: fixture.repo,
        });
        if (finalRender.status !== 'ok') throw new Error('alias fixture re-render failed');
        unlinkSync(fixture.paths.sidecarPath);
        unlinkSync(fixture.paths.markdownPath);
        const signedState: ApprovalState = {
          workspace: fixture.repo,
          headSha: fixture.git(['rev-parse', 'HEAD']),
          treeClean: true,
        };
        const { authority, ledger } = approvedAuthority(fixture.reader, signedState);
        const result = await makeOp(
          fixture.store,
          codemodRunner(FIXTURE_FILES),
          authority,
        )({
          ...baseInput(),
          clusterId: report.clusters[0]?.id ?? '',
          dir: fixture.repo,
          sidecarPath: finalRender.value.sidecarPath,
        });
        expect(result.status).toBe('needs-human');
        expect(result.status === 'needs-human' ? result.reason : '').toContain(
          'codemod target or alias',
        );
        expect(ledger.spent()).toBe(0);
      } finally {
        rmSync(fixture.repo, { recursive: true, force: true });
      }
    },
  );
});
