// reviewContext unit tests — the shared bounded intent/file-list extraction
// (Q5, #499): real git over the test repo harness for the happy path and
// scope truth, scripted effects for the failure classes. Caps, deadline
// sharing, and the fatal vs blocked fault split are the contract;
// run.ts/dev.review integration asserts its own wiring separately.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REVIEW_CONTEXT_FILE_LIST_CAP,
  REVIEW_CONTEXT_INTENT_CAP,
  capBoundedContext,
  collectBoundedReviewContext,
} from '../../../src/ops/review/reviewContext.js';
import type { CommandResult, DevEffects } from '../../../src/ops/dev/effects.js';
import { makeTestRepo, repoEffects, type TestRepo } from '../dev/repo.js';

/** A scripted non-git effects object over the real-git repo harness. */
function scriptedRepoEffects(
  repo: TestRepo,
  handler: (command: string, args: readonly string[]) => CommandResult | undefined,
): DevEffects & { commands: { command: string; args: readonly string[] }[] } {
  return repoEffects(repo, (command, args) => handler(command, args)) as unknown as DevEffects & {
    commands: { command: string; args: readonly string[] }[];
  };
}

const DEADLINE = { remainingWallMs: () => 60_000 };

describe('capBoundedContext', () => {
  it('returns short text unchanged', () => {
    expect(capBoundedContext('hello', 10)).toBe('hello');
  });

  it('truncates with a visible count-accurate marker inside the cap', () => {
    const capped = capBoundedContext('a'.repeat(50), 40);
    expect(capped.length).toBe(40);
    expect(capped).toContain('[truncated: 10 characters omitted]');
  });

  it('degrades to a hard slice when the marker alone would exceed the cap', () => {
    const capped = capBoundedContext('abcdef', 3);
    expect(capped).toBe('abc');
    expect(capped.length).toBe(3);
  });
});

describe('collectBoundedReviewContext (real git)', () => {
  let repo: TestRepo;
  beforeEach(async () => {
    repo = await makeTestRepo();
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('collects the capped commit intent and numstat list for the committed scope', async () => {
    repo.git('checkout', '-q', '-b', 'feature/x');
    await repo.write('src/intent.ts', 'export const intent = 1;\n');
    repo.commitAll('feat: capture INTENT_MARKER\n\nexplains the change');
    const effects = repoEffects(repo);
    const result = await collectBoundedReviewContext(
      effects,
      repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(),
      repo.git('rev-parse', 'HEAD').trim(),
      'full',
      DEADLINE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.scope).toBe('full');
    expect(result.context.intent).toContain('INTENT_MARKER');
    expect(result.context.intent).toContain('explains the change');
    expect(result.context.intent.length).toBeLessThanOrEqual(REVIEW_CONTEXT_INTENT_CAP);
    expect(result.context.fileList).toMatch(/\d+\t\d+\tsrc\/intent\.ts/);
    expect(result.context.fileList.length).toBeLessThanOrEqual(REVIEW_CONTEXT_FILE_LIST_CAP);
  });

  it('the uncommitted scope describes the dirty work, not committed history', async () => {
    repo.git('checkout', '-q', '-b', 'feature/x');
    await repo.write('src/committed.ts', 'export const committed = 1;\n');
    repo.commitAll('feat: COMMITTED_MARKER');
    await repo.write('src/dirty.ts', 'export const dirty = 1;\n');
    repo.git('add', '-A');
    const effects = repoEffects(repo);
    const result = await collectBoundedReviewContext(
      effects,
      'HEAD',
      repo.git('rev-parse', 'HEAD').trim(),
      'uncommitted',
      DEADLINE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The list describes the staged/unstaged diff ('HEAD' comparison):
    // the dirty file appears, the earlier commit's file does not, and the
    // intent is EMPTY (no committed history masquerades as dirty context).
    expect(result.context.fileList).toContain('src/dirty.ts');
    expect(result.context.fileList).not.toContain('src/committed.ts');
    expect(result.context.intent).toBe('');
    expect(result.context.scope).toBe('uncommitted');
  });

  it('a giant intent is truncated once at the cap with the marker inside it', async () => {
    repo.git('checkout', '-q', '-b', 'feature/x');
    await repo.write('src/big.ts', 'export const big = 1;\n');
    repo.commitAll(`${'x'.repeat(REVIEW_CONTEXT_INTENT_CAP + 500)}`);
    const effects = repoEffects(repo);
    const result = await collectBoundedReviewContext(
      effects,
      repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(),
      repo.git('rev-parse', 'HEAD').trim(),
      'full',
      DEADLINE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.intent.length).toBe(REVIEW_CONTEXT_INTENT_CAP);
    expect(result.context.intent).toContain('[truncated:');
  });

  it('a non-zero git log exit is a NON-fatal fault naming the command class', async () => {
    repo.git('checkout', '-q', '-b', 'feature/x');
    await repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('base work');
    const effects = scriptedRepoEffects(repo, (command, args) =>
      command === 'git' && args[0] === 'log'
        ? { exitCode: 128, stdout: '', stderr: 'fatal: bad object', timedOut: false }
        : undefined,
    );
    const result = await collectBoundedReviewContext(
      effects,
      repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(),
      repo.git('rev-parse', 'HEAD').trim(),
      'full',
      DEADLINE,
    );
    expect(result).toMatchObject({ ok: false, fatal: false });
    if (!result.ok) expect(result.reason).toContain('could not collect review intent');
  });

  it('a non-zero numstat exit is a NON-fatal fault naming the stats read', async () => {
    repo.git('checkout', '-q', '-b', 'feature/x');
    await repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('base work');
    const effects = scriptedRepoEffects(repo, (command, args) =>
      command === 'git' && args[0] === 'diff' && args.includes('--numstat')
        ? { exitCode: 2, stdout: '', stderr: 'error', timedOut: false }
        : undefined,
    );
    const result = await collectBoundedReviewContext(
      effects,
      repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(),
      repo.git('rev-parse', 'HEAD').trim(),
      'full',
      DEADLINE,
    );
    expect(result).toMatchObject({ ok: false, fatal: false });
    if (!result.ok) expect(result.reason).toContain('could not list review diff stats');
  });

  it('an aborted signal is FATAL: the caller deadline stops the review, no degraded run', async () => {
    repo.git('checkout', '-q', '-b', 'feature/x');
    await repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('base work');
    const controller = new AbortController();
    const effects = scriptedRepoEffects(repo, (command, args) => {
      if (command === 'git' && args[0] === 'log') {
        controller.abort(new Error('fixture deadline'));
        return { exitCode: 0, stdout: 'subject', stderr: '', timedOut: false };
      }
      return undefined;
    });
    const result = await collectBoundedReviewContext(effects, 'HEAD', repo.git('rev-parse', 'HEAD').trim(), 'full', {
      signal: controller.signal,
      remainingWallMs: () => 60_000,
    });
    expect(result).toMatchObject({ ok: false, fatal: true });
    if (!result.ok) expect(result.reason).toContain('could not collect review context');
  });

  it('an exhausted wall budget is FATAL and the reads carry the remaining time', async () => {
    repo.git('checkout', '-q', '-b', 'feature/x');
    await repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('base work');
    const effects = scriptedRepoEffects(repo, () => undefined);
    const result = await collectBoundedReviewContext(effects, 'HEAD', repo.git('rev-parse', 'HEAD').trim(), 'full', {
      remainingWallMs: () => 0,
    });
    expect(result).toMatchObject({ ok: false, fatal: true });
  });

  it('both reads share the caller deadline: options carry the signal and bounded timeout', async () => {
    repo.git('checkout', '-q', '-b', 'feature/x');
    await repo.write('src/a.ts', 'export const a = 1;\n');
    repo.commitAll('base work');
    const controller = new AbortController();
    const seen: { timeoutMs: number; signal?: AbortSignal }[] = [];
    const base = repoEffects(repo);
    const effects: DevEffects = {
      ...base,
      runCommand: async (command, args, opts) => {
        seen.push({ timeoutMs: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
        return base.runCommand(command, args, opts);
      },
    };
    const result = await collectBoundedReviewContext(effects, 'HEAD', repo.git('rev-parse', 'HEAD').trim(), 'full', {
      signal: controller.signal,
      remainingWallMs: () => 5_000,
    });
    expect(result.ok).toBe(true);
    expect(seen.length).toBe(2);
    for (const call of seen) {
      expect(call.timeoutMs).toBe(5_000);
      expect(call.signal).toBe(controller.signal);
    }
  });
});
