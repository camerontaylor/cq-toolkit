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
} from '../../../src/ops/review/internal/reviewContext.js';
import type { CommandResult, DevEffects } from '../../../src/ops/dev/effects.js';
import { makeTestRepo, repoEffects, type TestRepo } from '../dev/repo.js';

/** A scripted non-git effects object over the real-git repo harness. */
function scriptedRepoEffects(
  repo: TestRepo,
  handler: (command: string, args: readonly string[]) => CommandResult | undefined,
) {
  return repoEffects(repo, (command, args) => handler(command, args));
}

const DEADLINE = { remainingWallMs: () => 60_000 };

describe('capBoundedContext', () => {
  it('returns short text unchanged', () => {
    expect(capBoundedContext('hello', 10)).toBe('hello');
  });

  it('truncates with a visible, truthful omission count inside the cap', () => {
    const capped = capBoundedContext('a'.repeat(50), 40);
    expect(capped.length).toBeLessThanOrEqual(40);
    const omitted = Number(/\[truncated: (\d+) characters omitted\]/.exec(capped)?.[1]);
    // The marker counts what the reader will NOT see: original minus kept.
    expect(omitted).toBe(50 - capped.indexOf('\n'));
    expect(capped).toContain('[truncated: ');
  });

  it('degrades safely at a tiny cap: the marker never exceeds a whole cap of its own', () => {
    // With the realistic cap (4_000) the floor keeps the marker inside;
    // a degenerate tiny cap produces a marker that names the whole text.
    const capped = capBoundedContext('abcdef', 3);
    expect(capped).toContain('[truncated: 6 characters omitted]');
  });

  it('the omission count plus the kept prefix equals the original length', () => {
    const text = 'b'.repeat(200);
    const capped = capBoundedContext(text, 100);
    const omitted = Number(/\[truncated: (\d+) characters omitted\]/.exec(capped)?.[1]);
    expect(capped.indexOf('b')).toBe(0);
    const kept = capped.indexOf('\n');
    expect(kept + omitted).toBe(text.length);
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
    expect(result.context.intent.length).toBeLessThanOrEqual(REVIEW_CONTEXT_INTENT_CAP);
    const omitted = Number(
      /\[truncated: (\d+) characters omitted\]/.exec(result.context.intent)?.[1],
    );
    const kept = result.context.intent.indexOf('\n[truncated:');
    const rawIntent = repo.git(
      'log',
      '--format=%s%n%n%b',
      repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim() + '..HEAD',
    );
    expect(kept).toBeGreaterThan(0);
    expect(kept + omitted).toBe(rawIntent.length);
    expect(result.context.intent).toContain('[truncated:');
  });

  it('a non-zero git log exit is a NON-fatal fault naming the command class', async () => {
    await repo.write('src/a.ts', 'export const a = 2;\n');
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
    await repo.write('src/a.ts', 'export const a = 2;\n');
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
    await repo.write('src/a.ts', 'export const a = 2;\n');
    repo.commitAll('base work');
    const controller = new AbortController();
    const effects = scriptedRepoEffects(repo, (command, args) => {
      if (command === 'git' && args[0] === 'log') {
        controller.abort(new Error('fixture deadline'));
        return { exitCode: 0, stdout: 'subject', stderr: '', timedOut: false };
      }
      return undefined;
    });
    const result = await collectBoundedReviewContext(
      effects,
      'HEAD',
      repo.git('rev-parse', 'HEAD').trim(),
      'full',
      {
        signal: controller.signal,
        remainingWallMs: () => 60_000,
      },
    );
    expect(result).toMatchObject({ ok: false, fatal: true });
    if (!result.ok) expect(result.reason).toContain('could not collect review context');
  });

  it.each([0, -1, Number.NaN, Infinity, -Infinity])(
    'rejects invalid caller budget %s before spawning any command',
    async (remaining) => {
      const effects = repoEffects(repo);
      const result = await collectBoundedReviewContext(effects, 'HEAD', 'HEAD', 'full', {
        remainingWallMs: () => remaining,
      });
      expect(result).toMatchObject({ ok: false, fatal: true });
      expect(effects.calls).toEqual([]);
    },
  );

  it.each(['log', 'diff'])(
    'checks exhausted/nonfinite budget after %s even on failed git exits',
    async (collapseAfter) => {
      for (const exitCode of [0, 128]) {
        for (const expired of [0, Number.NaN, Infinity]) {
          let remaining = 5_000;
          const effects = scriptedRepoEffects(repo, (_command, args) => {
            if (args[0] === collapseAfter) remaining = expired;
            return {
              exitCode: args[0] === 'log' && collapseAfter === 'diff' ? 0 : exitCode,
              stdout: '',
              stderr: '',
              timedOut: false,
            };
          });
          const result = await collectBoundedReviewContext(effects, 'HEAD', 'HEAD', 'full', {
            remainingWallMs: () => remaining,
          });
          expect(result).toMatchObject({ ok: false, fatal: true });
          if (!result.ok) expect(result.reason).toContain('after the');
          expect(effects.calls.map((call) => call.args[0])).toEqual(
            collapseAfter === 'log' ? ['log'] : ['log', 'diff'],
          );
        }
      }
    },
  );

  it.each(['log', 'diff'])(
    'denies a successful REAL git read when the budget expires during %s',
    async (collapseAfter) => {
      let remaining = 5_000;
      const effects = repoEffects(repo);
      const run = effects.runCommand;
      effects.runCommand = async (command, args, opts) => {
        const result = await run(command, args, opts);
        if (args[0] === collapseAfter) remaining = 0;
        return result;
      };
      const result = await collectBoundedReviewContext(effects, 'HEAD', 'HEAD', 'full', {
        remainingWallMs: () => remaining,
      });
      expect(result).toMatchObject({ ok: false, fatal: true });
      expect(effects.calls.map((call) => call.args[0])).toEqual(
        collapseAfter === 'log' ? ['log'] : ['log', 'diff'],
      );
    },
  );

  it('returns empty context for an empty real Git comparison', async () => {
    const effects = repoEffects(repo);
    const result = await collectBoundedReviewContext(effects, 'HEAD', 'HEAD', 'full', DEADLINE);
    expect(result).toEqual({ ok: true, context: { intent: '', fileList: '', scope: 'full' } });
  });

  it('does not spawn when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const effects = repoEffects(repo);
    const result = await collectBoundedReviewContext(effects, 'HEAD', 'HEAD', 'full', {
      signal: controller.signal,
      remainingWallMs: () => 5_000,
    });
    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(effects.calls).toEqual([]);
  });

  it.each(['log', 'diff'])(
    'cancellation during failed %s overrides its exit code',
    async (cancelAfter) => {
      const controller = new AbortController();
      const effects = scriptedRepoEffects(repo, (_command, args) => {
        if (args[0] === cancelAfter) controller.abort(new Error('cancelled during read'));
        return {
          exitCode: args[0] === cancelAfter ? 128 : 0,
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      });
      const result = await collectBoundedReviewContext(effects, 'HEAD', 'HEAD', 'full', {
        signal: controller.signal,
        remainingWallMs: () => 5_000,
      });
      expect(result).toMatchObject({ ok: false, fatal: true });
      expect(effects.calls.map((call) => call.args[0])).toEqual(
        cancelAfter === 'log' ? ['log'] : ['log', 'diff'],
      );
    },
  );

  it('uses each validated budget sample for the next read and stops when it collapses', async () => {
    let remaining = 5_000;
    const seen: number[] = [];
    const effects = repoEffects(repo);
    const run = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      seen.push(opts.timeoutMs);
      const result = await run(command, args, opts);
      remaining = args[0] === 'log' ? 2_000 : 0;
      return result;
    };
    const result = await collectBoundedReviewContext(effects, 'HEAD', 'HEAD', 'full', {
      remainingWallMs: () => remaining,
    });
    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(seen).toEqual([5_000, 2_000]);
  });

  it('both reads share the caller deadline: options carry the signal and bounded timeout', async () => {
    await repo.write('src/a.ts', 'export const a = 2;\n');
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
    const result = await collectBoundedReviewContext(
      effects,
      'HEAD',
      repo.git('rev-parse', 'HEAD').trim(),
      'full',
      {
        signal: controller.signal,
        remainingWallMs: () => 5_000,
      },
    );
    expect(result.ok).toBe(true);
    expect(seen.length).toBe(2);
    for (const call of seen) {
      expect(call.timeoutMs).toBe(5_000);
      expect(call.signal).toBe(controller.signal);
    }
  });
});
