// dev.review op tests — scripted effects + a stub scanner. Pinned: the base
// pin (merge-base against the intended target, or the explicit sha resolved
// once), the secret scan BEFORE any reviewer run, the host-lock span, the
// honest completion recording (terminal vs blocked with the reason), the
// finding id minting, and the log written outside the repository.
import { describe, expect, test } from 'vitest';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { BASE, BRANCH, failResult, HEAD, makeFakeEffects, okResult, stubScanner } from './fakes.js';

const NDJSON_OK = [
  JSON.stringify({ type: 'status', status: 'scanning' }),
  JSON.stringify({ type: 'finding', severity: 'major', fileName: 'src/a.ts', comment: 'fix this' }),
  JSON.stringify({ type: 'finding', severity: 'minor', comment: 'nit' }),
  JSON.stringify({ type: 'complete', status: 'completed' }),
  '',
].join('\n');

/** Effects whose reviewer run produces the given NDJSON and exit code. */
function reviewEffects(ndjson: string, exitCode: number) {
  return makeFakeEffects((command, args) => {
    if (command === 'coderabbit') {
      expect(args[0]).toBe('review');
      expect(args[1]).toBe('--agent');
      expect(args[2]).toBe('--base-commit');
      return { exitCode, stdout: ndjson, stderr: '', timedOut: false };
    }
    if (command === 'git' && args[0] === 'diff' && args[1] === '--binary') {
      return okResult('patchtext', '');
    }
    return undefined;
  });
}

describe('dev.review', () => {
  test('a terminal cycle: ok report, ledger record with minted ids, log outside the repo', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await makeDevReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.cycleId).toBe('c001-aaaaaaaa');
    expect(result.value.base).toBe(BASE);
    expect(result.value.head).toBe(HEAD);
    expect(result.value.dirtySha256).not.toBe('clean-tree');
    expect(result.value.findings).toHaveLength(2);
    expect(result.value.findings[0]).toMatchObject({
      id: 'c001-aaaaaaaa#f1',
      severity: 'major',
      fileName: 'src/a.ts',
    });
    expect(result.value.logPath).toContain('/tmp/fake-cq-dev-review/');

    const ledger = effects.openLedger(BRANCH).load();
    expect(ledger.records).toHaveLength(1);
    const record = ledger.records[0];
    expect(record?.kind).toBe('cycle');
    if (record?.kind === 'cycle') {
      expect(record.completion).toEqual({ kind: 'terminal' });
      expect(record.reviewer).toBe('coderabbit');
      expect(record.scope).toBe('full');
      expect(record.logPath).toBe(result.value.logPath);
    }
  });

  test('the pinned base is the merge-base of origin/<target> and HEAD', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    await makeDevReview(effects, stubScanner())({ repoRoot: '/repo', target: 'main' });
    const mergeBase = effects.commands.find((entry) => entry.args[0] === 'merge-base');
    expect(mergeBase?.args).toEqual(['merge-base', 'origin/main', 'HEAD']);
  });

  test('an explicit base resolves once to a commit (the immutable pin)', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await makeDevReview(
      effects,
      stubScanner(),
    )({ repoRoot: '/repo', base: '1234567' });
    expect(result.status).toBe('ok');
    const resolve = effects.commands.find(
      (entry) => entry.args[0] === 'rev-parse' && entry.args[1] === '1234567^{commit}',
    );
    expect(resolve).toBeDefined();
    if (result.status === 'ok') expect(result.value.base).toBe(BASE);
  });

  test('an explicit base that does not resolve is needs-human, no reviewer run', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'deadbeef^{commit}') {
        return failResult(128, '', 'unknown revision');
      }
      return undefined;
    });
    const result = await makeDevReview(
      effects,
      stubScanner(),
    )({ repoRoot: '/repo', base: 'deadbeef' });
    expect(result.status).toBe('needs-human');
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });

  test('THE SCAN GATES THE UPLOAD: a secret hit refuses before the reviewer runs, nothing recorded', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const scanner = stubScanner([{ component: 'committed', ruleId: 'class:token-ssh-plumbing' }]);
    const result = await makeDevReview(effects, scanner)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('class:token-ssh-plumbing');
      expect(result.reason).toContain('committed');
    }
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
    expect(effects.openLedger(BRANCH).load().records).toHaveLength(0);
  });

  test('a scanner fault refuses the review too', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await makeDevReview(effects, () => {
      throw new Error('patterns.yml malformed');
    })({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('malformed');
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });

  test('blocked variants are recorded honestly with the reason and never ok', async () => {
    const cases: { name: string; ndjson: string; exitCode: number; why: RegExp }[] = [
      {
        name: 'non-zero exit',
        ndjson: NDJSON_OK,
        exitCode: 3,
        why: /exited 3/,
      },
      {
        name: 'error event',
        ndjson: `${JSON.stringify({ type: 'error', message: 'quota' })}\n`,
        exitCode: 0,
        why: /error event/,
      },
      {
        name: 'skipped',
        ndjson: `${JSON.stringify({ type: 'complete', status: 'review_skipped' })}\n`,
        exitCode: 0,
        why: /review_skipped/,
      },
      {
        name: 'action required',
        ndjson: `${JSON.stringify({ type: 'action_required' })}\n${JSON.stringify({ type: 'complete', status: 'completed' })}\n`,
        exitCode: 0,
        why: /action/,
      },
      {
        name: 'no terminal event',
        ndjson: `${JSON.stringify({ type: 'heartbeat' })}\n`,
        exitCode: 0,
        why: /without a terminal/,
      },
    ];
    for (const testCase of cases) {
      const effects = reviewEffects(testCase.ndjson, testCase.exitCode);
      const result = await makeDevReview(effects, stubScanner())({ repoRoot: '/repo' });
      expect(result.status, testCase.name).toBe('needs-human');
      if (result.status === 'needs-human') {
        expect(result.reason, testCase.name).toMatch(testCase.why);
        expect(result.reason, testCase.name).toContain('c001-aaaaaaaa');
      }
      const ledger = effects.openLedger(BRANCH).load();
      const record = ledger.records[0];
      expect(record?.kind, testCase.name).toBe('cycle');
      if (record?.kind === 'cycle') {
        expect(record.completion.kind, testCase.name).toBe('blocked');
        if (record.completion.kind === 'blocked') {
          expect(record.completion.reason, testCase.name).toMatch(testCase.why);
        }
      }
    }
  });

  test('a spawn fault (missing binary) is a blocked cycle naming the fault, not a crash', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'coderabbit') throw new Error('spawn coderabbit ENOENT');
      // A non-empty unstaged patch so the run reaches the reviewer.
      if (command === 'git' && args[0] === 'diff' && args.length === 1)
        return okResult('patch text');
      return undefined;
    });
    const result = await makeDevReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('BLOCKED');
    const record = effects.openLedger(BRANCH).load().records[0];
    expect(record?.kind).toBe('cycle');
    if (record?.kind === 'cycle' && record.completion.kind === 'blocked') {
      expect(record.completion.reason).toContain('did not run');
    }
  });

  test('a failed dirty-diff read is needs-human, never a fabricated clean tree', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (
        command === 'git' &&
        args[0] === 'diff' &&
        args[1] === '--binary' &&
        args[2] === '--full-index' &&
        args[3] === 'HEAD'
      ) {
        return { exitCode: 128, stdout: '', stderr: 'fatal: bad object HEAD', timedOut: false };
      }
      return original(command, args, opts);
    };
    const result = await makeDevReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('dirty-diff identity');
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });

  test('worktree drift while waiting on the host lock refuses before the reviewer runs', async () => {
    let headCalls = 0;
    const effects = reviewEffects(NDJSON_OK, 0);
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headCalls += 1;
        if (headCalls >= 2) return okResult('9999999999999999999999999999999999999999\n');
      }
      return original(command, args, opts);
    };
    const result = await makeDevReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('HEAD moved');
      expect(result.reason).toContain('waiting for the review lock');
    }
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
    expect(effects.openLedger(BRANCH).load().records).toHaveLength(0);
  });

  test('the agent fallback is refused by name — never a substitute for the CLI cycle', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await makeDevReview(
      effects,
      stubScanner(),
    )({
      repoRoot: '/repo',
      reviewer: 'agent:zai/glm-4.7',
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('agent');
      expect(result.reason).toContain('fallback');
    }
    expect(effects.commands).toHaveLength(0);
  });

  test('an unknown reviewer word is a failed result', async () => {
    const effects = reviewEffects(NDJSON_OK, 0);
    const result = await makeDevReview(
      effects,
      stubScanner(),
    )({ repoRoot: '/repo', reviewer: 'mystery' });
    expect(result.status).toBe('failed');
  });

  test('an empty selected scope is needs-human before the scan or the run', async () => {
    const effects = makeFakeEffects(() => undefined);
    const result = await makeDevReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('no diff to review');
  });

  test('uncommitted scope skips the committed patch component and flags --uncommitted', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'coderabbit') {
        expect(args).toContain('--uncommitted');
        return okResult(NDJSON_OK);
      }
      if (command === 'git' && args[0] === 'diff' && args[1] === '--cached')
        return okResult('staged-patch');
      if (command === 'git' && args[0] === 'diff') return okResult('unstaged-patch');
      return undefined;
    });
    const seenComponents: string[] = [];
    const result = await makeDevReview(effects, (components) => {
      seenComponents.push(...components.map((component) => component.component));
      return components.map((component) => ({ component: component.component, hits: [] }));
    })({ repoRoot: '/repo', uncommitted: true });
    expect(result.status).toBe('ok');
    expect(seenComponents).toEqual(['staged', 'unstaged']);
    // The identity still pins the merge-base (the record's triple), but the
    // committed patch component is absent from the uncommitted scope.
    const mergeBase = effects.commands.find((entry) => entry.args[0] === 'merge-base');
    expect(mergeBase).toBeDefined();
  });

  test('untracked files are scanned and recorded in the cycle', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'coderabbit') return okResult(NDJSON_OK);
      if (command === 'git' && args[0] === 'ls-files') return okResult('notes.md\n');
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary')
        return okResult('patch');
      return undefined;
    });
    effects.readWorktreeFile = async (path) => (path === 'notes.md' ? 'content' : null);
    const seen: string[] = [];
    const result = await makeDevReview(effects, (components) => {
      seen.push(...components.map((component) => component.component));
      return components.map((component) => ({ component: component.component, hits: [] }));
    })({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    expect(seen).toContain('untracked:notes.md');
    const record = effects.openLedger(BRANCH).load().records[0];
    if (record?.kind === 'cycle') expect(record.untracked).toEqual(['notes.md']);
  });

  test('an unreadable untracked file refuses the review (never silently skipped)', async () => {
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'ls-files') return okResult('gone.md\n');
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary')
        return okResult('patch');
      return undefined;
    });
    effects.readWorktreeFile = async () => null;
    const result = await makeDevReview(effects, stubScanner())({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('gone.md');
    expect(effects.commands.find((entry) => entry.command === 'coderabbit')).toBeUndefined();
  });
});
