// Split from self-review-loop.test.ts (pure move); shared fixtures in ./self-review-loop-fakes.js.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildSweepUsage, main, sweepUsageMarkdown } from '../../src/selfhost/self-review-loop.js';
import { SelfhostDefaults } from '../../src/selfhost/config.js';
import {
  LIST_PATH,
  REPO_PATH,
  type RecordedCall,
  baseDeps,
  cleanupTempRoots,
  fakeGh,
  fakeLoop,
  fakeOutcome,
  outcomeWithFixTokens,
  pullRow,
  tempJournalRoot,
} from './self-review-loop-fakes.js';

afterEach(cleanupTempRoots);

describe('main — usage reporting', () => {
  const originalArgv = process.argv;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.argv = originalArgv;
  });

  const setup = () => {
    const root = tempJournalRoot();
    const out = join(root, 'fresh', 'nested', 'sweep-usage.json');
    const stepSummary = join(root, 'summary.md');
    process.argv = ['node', 'self-review-loop.js', '--repo', REPO_PATH, '--dry-run'];
    vi.stubEnv('SWEEP_USAGE_OUT', out);
    vi.stubEnv('GITHUB_STEP_SUMMARY', stepSummary);
    return { out, stepSummary };
  };

  test('a listing failure writes zero usage and an error before rejecting', async () => {
    const { out } = setup();
    await expect(
      main(
        baseDeps(
          fakeGh([], { failListing: true }),
          fakeLoop([], async () => fakeOutcome(1)),
        ),
      ),
    ).rejects.toThrow();
    const report = JSON.parse(readFileSync(out, 'utf8')) as { sweepUsage: unknown; error: string };
    expect(report.sweepUsage).toEqual(buildSweepUsage(SelfhostDefaults.maxTokens, []));
    expect(report.error).toContain('gh failed (exit 1)');
    expect(report.error).toContain(LIST_PATH);
  });

  test('a fresh dry run creates the artifact directory and waits for stdout before appending', async () => {
    const { out, stepSummary } = setup();
    let finishWrite: ((error?: Error | null) => void) | undefined;
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(
        (
          _chunk: string | Uint8Array,
          encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
          callback?: (error?: Error | null) => void,
        ) => {
          const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
          finishWrite = done;
          return false;
        },
      );
    const pending = main(
      baseDeps(
        fakeGh([]),
        fakeLoop([], async () => fakeOutcome(1)),
      ),
    );
    await vi.waitFor(() => expect(stdout).toHaveBeenCalledOnce());
    expect(existsSync(stepSummary)).toBe(false);
    expect(existsSync(out)).toBe(false);
    finishWrite?.();
    await pending;
    const usage = buildSweepUsage(SelfhostDefaults.maxTokens, []);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ sweepUsage: usage });
    expect(readFileSync(stepSummary, 'utf8')).toBe(sweepUsageMarkdown(usage));
  });

  // Q34 explicitly replaces the former stdout-rejection/error-field oracle
  // with a new, scoped best-effort transport policy after a completed sweep.
  test.each([
    'callback',
    'callback and event',
    'throw',
    'callback with broken stderr',
    'callback with long message',
  ])('a stdout %s error preserves the completed sweep and remaining reports', async (mode) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const originalErrorListeners = process.stdout.listenerCount('error');
    const { out, stepSummary } = setup();
    const message =
      mode === 'callback with long message' ? `${'x'.repeat(600)}\nsecond line` : 'stdout failed';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      if (mode === 'callback with broken stderr') throw new Error('stderr failed');
      return true;
    });
    let finishWrite: ((error?: Error | null) => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (
        _chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        if (mode === 'throw') throw new Error(message);
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        finishWrite = done;
        return false;
      },
    );
    const pending = main(
      baseDeps(
        fakeGh([]),
        fakeLoop([], async () => fakeOutcome(1)),
      ),
    );
    if (mode !== 'throw') {
      await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
      expect(existsSync(stepSummary)).toBe(false);
      expect(existsSync(out)).toBe(false);
      const error = new Error(message);
      finishWrite?.(error);
      if (mode === 'callback and event') {
        await Promise.resolve();
        expect(process.stdout.listenerCount('error')).toBe(originalErrorListeners + 1);
        expect(process.stdout.emit('error', error)).toBe(true);
      }
    }
    await expect(pending).resolves.toBeUndefined();
    const warningDetail = mode === 'callback with long message' ? 'x'.repeat(500) : 'stdout failed';
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      `sweep-usage: could not write stdout: ${warningDetail}\n`,
    );
    const usage = buildSweepUsage(SelfhostDefaults.maxTokens, []);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      sweepUsage: usage,
    });
    expect(readFileSync(stepSummary, 'utf8')).toBe(sweepUsageMarkdown(usage));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(process.stdout.listenerCount('error')).toBe(originalErrorListeners);
  });

  test.each([1, 12])(
    'Q34 shares stderr protection across %i diagnostics, handles late errors and cleans up',
    async (writes) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const baseline = process.stderr.listenerCount('error');
      const { out, stepSummary } = setup();
      const warning = vi.spyOn(process, 'emitWarning');
      vi.spyOn(process.stdout, 'write').mockImplementation(() => {
        throw new Error('stdout failed');
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await Promise.all(
        Array.from({ length: writes }, () =>
          main(
            baseDeps(
              fakeGh([]),
              fakeLoop([], async () => fakeOutcome(1)),
            ),
          ),
        ),
      );
      expect(stderr).toHaveBeenCalledTimes(writes);
      expect(process.stderr.listenerCount('error')).toBe(baseline + 1);
      // Node can emit the stream error after the write and main have returned.
      await new Promise<void>((resolve) => {
        process.nextTick(() => {
          expect(process.stderr.emit('error', new Error('late stderr EPIPE'))).toBe(true);
          resolve();
        });
      });
      expect(existsSync(out)).toBe(true);
      expect(existsSync(stepSummary)).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(process.stderr.listenerCount('error')).toBe(baseline);
      expect(warning).not.toHaveBeenCalled();
    },
  );

  test('Q34 retains payload serialization failure as a whole-run error before stdout', async () => {
    const { out, stepSummary } = setup();
    const stringify = JSON.stringify;
    let payloadEncounters = 0;
    const stringifySpy = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
        const value: unknown = args[0];
        if (
          typeof value === 'object' &&
          value !== null &&
          Object.getPrototypeOf(value) === Object.prototype &&
          Object.keys(value).sort().join(',') === 'dryRun,excluded,failures,results,wouldRun' &&
          'dryRun' in value &&
          value.dryRun === true &&
          'results' in value &&
          Array.isArray(value.results) &&
          value.results.length === 0 &&
          'failures' in value &&
          Array.isArray(value.failures) &&
          value.failures.length === 0 &&
          'excluded' in value &&
          Array.isArray(value.excluded) &&
          value.excluded.length === 0 &&
          'wouldRun' in value &&
          Array.isArray(value.wouldRun) &&
          value.wouldRun.length === 0
        ) {
          payloadEncounters += 1;
          throw new Error('payload serialization failed');
        }
        return stringify(...args);
      });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(
        main(
          baseDeps(
            fakeGh([]),
            fakeLoop([], async () => fakeOutcome(1)),
          ),
        ),
      ).rejects.toThrow('payload serialization failed');
    } finally {
      stringifySpy.mockRestore();
    }

    expect(payloadEncounters).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(existsSync(stepSummary)).toBe(false);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      sweepUsage: buildSweepUsage(SelfhostDefaults.maxTokens, []),
      error: 'payload serialization failed',
    });
  });

  test('Q34 stdout failure preserves nonzero usage and the completed sweep PR failure diagnostic', async () => {
    const { out, stepSummary } = setup();
    const journalRoot = tempJournalRoot();
    process.argv = [
      'node',
      'self-review-loop.js',
      '--repo',
      REPO_PATH,
      '--journal-root',
      journalRoot,
    ];
    vi.stubEnv('CQ_SELFHOST_NOW_MS', '1700000000000');
    vi.stubEnv('ZAI_API_KEY', 'fixture-key');
    const calls: RecordedCall[] = [];
    let finishWrite: ((error?: Error | null) => void) | undefined;
    let stdoutText = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        stdoutText = String(chunk);
        finishWrite = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        return false;
      },
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pending = main(
      baseDeps(
        fakeGh([pullRow(7), pullRow(8)]),
        fakeLoop(calls, async (pr, opts) => {
          if (pr === 7) {
            opts.onSpend?.(0, 300);
            throw new Error('injected loop boom after token spend');
          }
          return outcomeWithFixTokens(pr, 125);
        }),
      ),
    );

    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.opts.runOptions?.maxTokens).toBe(SelfhostDefaults.maxTokens - 300);
    expect(existsSync(stepSummary)).toBe(false);
    expect(existsSync(out)).toBe(false);
    expect(stderr).not.toHaveBeenCalled();
    finishWrite?.(new Error('stdout failed'));
    await expect(pending).resolves.toBeUndefined();

    const failure =
      'injected loop boom after token spend — accounted spend 0 and 300 tokens deducted from the sweep budget';
    const usage = {
      capTokens: SelfhostDefaults.maxTokens,
      totalTokensUsed: 425,
      perPrTokens: [
        { pr: 7, tokens: 300 },
        { pr: 8, tokens: 125 },
      ],
      remainingTokens: SelfhostDefaults.maxTokens - 425,
      exhausted: false,
    };
    expect(stderr.mock.calls).toEqual([
      ['sweep-usage: could not write stdout: stdout failed\n'],
      [`pr 7: ${failure}\n`],
    ]);
    expect(
      stdoutText
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)),
    ).toEqual([
      {
        results: [{ pr: 8, status: 'ok', actionsPosted: 0, reasons: [] }],
        failures: [{ pr: 7, error: failure }],
        excluded: [],
      },
      { sweepUsage: usage },
    ]);
    expect(readFileSync(stepSummary, 'utf8')).toBe(sweepUsageMarkdown(usage));
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ sweepUsage: usage });
  });
});
