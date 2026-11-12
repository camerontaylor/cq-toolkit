// Split from self-review-loop.test.ts (pure move); shared fixtures in ./self-review-loop-fakes.js.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { main } from '../../src/selfhost/self-review-loop.js';
import { SelfhostDefaults, SelfhostPeak, driverKeyEnv } from '../../src/selfhost/config.js';
import {
  REPO_PATH,
  type RecordedCall,
  baseDeps,
  cleanupTempRoots,
  fakeGh,
  fakeLoop,
  fakeOutcome,
  pullRow,
  tempJournalRoot,
} from './self-review-loop-fakes.js';

afterEach(cleanupTempRoots);

describe('main — peak-aware driver credential (fail closed)', () => {
  const originalArgv = process.argv;
  // Several tests here run main() through to the usage tail, whose
  // appendStepSummaryTable/writeSweepUsageFile read these from the real
  // environment. GitHub Actions sets GITHUB_STEP_SUMMARY on every job, so
  // unstubbed they would append fixture tables to the real job summary (and
  // write the usage artifact if the workflow exported SWEEP_USAGE_OUT).
  // Both helpers treat '' as absent; afterEach's unstubAllEnvs restores.
  beforeEach(() => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    vi.stubEnv('SWEEP_USAGE_OUT', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.argv = originalArgv;
  });

  const at = (iso: string): number => Date.parse(iso);
  // The peak window uses OpenCode Go while off-peak uses Z.AI; these tests
  // pin the window selection and the key/base-URL preflight for each route.
  const PEAK_KEY = `${String(driverKeyEnv(SelfhostPeak.driver))}\n`;
  const OFF_PEAK_KEY = `${String(driverKeyEnv(SelfhostDefaults.driver))}\n`;

  test('--print-driver-key-env prints the key env the CURRENT clock selects', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', 'self-review-loop.js', '--print-driver-key-env'];
    // Peak (Mon 2026-10-12T07:00Z) → the peak driver's key …
    await main({
      ...baseDeps(
        fakeGh([]),
        fakeLoop([], async () => fakeOutcome(1)),
      ),
      nowMs: () => at('2026-10-12T07:00:00Z'),
    });
    expect(write).toHaveBeenCalledWith(PEAK_KEY);
    write.mockClear();
    // … and every off-peak instant (same day, noon UTC) → the off-peak key.
    await main({
      ...baseDeps(
        fakeGh([]),
        fakeLoop([], async () => fakeOutcome(1)),
      ),
      nowMs: () => at('2026-10-12T12:00:00Z'),
    });
    expect(write).toHaveBeenCalledWith(OFF_PEAK_KEY);
  });

  test('CQ_SELFHOST_PEAK_DRIVER reroutes the peak window to another provider (configuration, not code)', async () => {
    vi.stubEnv('CQ_SELFHOST_PEAK_DRIVER', 'deepseek/deepseek-flash');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', 'self-review-loop.js', '--print-driver-key-env'];
    await main({
      ...baseDeps(
        fakeGh([]),
        fakeLoop([], async () => fakeOutcome(1)),
      ),
      nowMs: () => at('2026-10-12T07:00:00Z'),
    });
    expect(write).toHaveBeenCalledWith('DEEPSEEK_API_KEY\n');
    write.mockClear();
    // Off-peak is untouched by the peak override.
    await main({
      ...baseDeps(
        fakeGh([]),
        fakeLoop([], async () => fakeOutcome(1)),
      ),
      nowMs: () => at('2026-10-12T12:00:00Z'),
    });
    expect(write).toHaveBeenCalledWith(OFF_PEAK_KEY);
  });

  test('a PEAK run refuses before any effect when the peak driver key is absent', async () => {
    process.argv = ['node', 'self-review-loop.js', '--repo', REPO_PATH];
    // Another provider's key is present but NOT the selected one: the
    // preflight must require the key belonging to the window's driver.
    vi.stubEnv('ZAI_API_KEY', 'present-but-not-selected');
    vi.stubEnv('OPENCODE_GO_API_KEY', '');
    await expect(
      main({
        ...baseDeps(
          fakeGh([]),
          fakeLoop([], async () => fakeOutcome(1)),
        ),
        nowMs: () => at('2026-10-12T07:00:00Z'),
      }),
    ).rejects.toThrow('requires OPENCODE_GO_API_KEY');
  });

  test('a PEAK run refuses a missing Go base URL even with its key present', async () => {
    process.argv = ['node', 'self-review-loop.js', '--repo', REPO_PATH];
    vi.stubEnv('OPENCODE_GO_API_KEY', 'present');
    vi.stubEnv('OPENCODE_GO_BASE_URL', '');
    await expect(
      main({
        ...baseDeps(
          fakeGh([]),
          fakeLoop([], async () => fakeOutcome(1)),
        ),
        nowMs: () => at('2026-10-12T07:00:00Z'),
      }),
    ).rejects.toThrow('requires OPENCODE_GO_BASE_URL');
  });

  test('an OFF-PEAK run likewise refuses when ZAI_API_KEY is absent', async () => {
    process.argv = ['node', 'self-review-loop.js', '--repo', REPO_PATH];
    vi.stubEnv('ZAI_API_KEY', '');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'present-but-not-selected');
    await expect(
      main({
        ...baseDeps(
          fakeGh([]),
          fakeLoop([], async () => fakeOutcome(1)),
        ),
        nowMs: () => at('2026-10-12T12:00:00Z'),
      }),
    ).rejects.toThrow('requires ZAI_API_KEY');
  });

  test('the reserved pre-peak headroom (05:40-06:00) demands the PEAK key too', async () => {
    // A sweep starting at 05:45 can still be dispatching when 06:00 opens, and
    // a run's driver is fixed at its start, so the headroom band selects the
    // peak provider — the handshake and the preflight follow it.
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', 'self-review-loop.js', '--print-driver-key-env'];
    await main({
      ...baseDeps(
        fakeGh([]),
        fakeLoop([], async () => fakeOutcome(1)),
      ),
      nowMs: () => at('2026-10-12T05:45:00Z'),
    });
    expect(write).toHaveBeenCalledWith(PEAK_KEY);
    write.mockRestore();
    // … and a REAL run starting there refuses when the selected key is absent.
    process.argv = ['node', 'self-review-loop.js', '--repo', REPO_PATH];
    vi.stubEnv('ZAI_API_KEY', 'present-but-not-selected');
    vi.stubEnv('OPENCODE_GO_API_KEY', '');
    await expect(
      main({
        ...baseDeps(
          fakeGh([]),
          fakeLoop([], async () => fakeOutcome(1)),
        ),
        nowMs: () => at('2026-10-12T05:45:00Z'),
      }),
    ).rejects.toThrow('requires OPENCODE_GO_API_KEY');
  });

  test('a pinned CQ_SELFHOST_NOW_MS drives the handshake AND the run', async () => {
    // The workflow pins ONE epoch-ms per step so its two node processes (the
    // --print-driver-key-env handshake and the run) cannot straddle a
    // selection boundary. The injected clock here would pick the OTHER window,
    // so a consulted clock would prove the pin was ignored. It is also a
    // counter: the entry snapshot is the ONLY pin source (runStartInstant has
    // no ambient raw fallback to disagree with it), so neither path may
    // consult deps.nowMs for the run instant.
    const pinned = Date.parse('2026-10-12T07:00:00Z'); // peak
    vi.stubEnv('CQ_SELFHOST_NOW_MS', String(pinned));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.argv = ['node', 'self-review-loop.js', '--print-driver-key-env'];
    let reads = 0;
    const injectedClock = () => {
      reads += 1;
      return at('2026-10-12T12:00:00Z');
    };
    await main({
      ...baseDeps(
        fakeGh([]),
        fakeLoop([], async () => fakeOutcome(1)),
      ),
      nowMs: injectedClock,
    });
    expect(write).toHaveBeenCalledWith(PEAK_KEY);
    // Handshake path: the pinned snapshot decided; the injected clock was
    // never consulted.
    expect(reads).toBe(0);
    write.mockRestore();
    // … and the same pin decides the driver the sweep dispatches through.
    const journalRoot = tempJournalRoot();
    const calls: RecordedCall[] = [];
    process.argv = [
      'node',
      'self-review-loop.js',
      '--repo',
      REPO_PATH,
      '--journal-root',
      journalRoot,
    ];
    vi.stubEnv('OPENCODE_GO_API_KEY', 'peak-key');
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://go-wire.invalid/v1');
    vi.stubEnv('ZAI_API_KEY', 'present-but-not-selected');
    reads = 0;
    await main({
      ...baseDeps(
        fakeGh([pullRow(7)]),
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      nowMs: injectedClock,
    });
    expect(calls[0]?.opts.driver).toEqual(SelfhostPeak.driver);
    expect(calls[0]?.opts.runOptions?.journalDir).toBe(join(journalRoot, `7-${String(pinned)}`));
    // Run path: the journal stamp above came from the pinned snapshot, not
    // the clock. The ONE injected read left is the loop's own per-PR
    // opts.nowMs snapshot — never a second run-instant read.
    expect(reads).toBe(1);
  });

  test('a malformed CQ_SELFHOST_NOW_MS fails loud at the entry (exit 2) instead of falling back', async () => {
    // The entry snapshot's registry epoch-ms parser is the only validation:
    // runStartInstant carries no ambient raw parse of its own, so a bad pin
    // dies here, before any effect, on both the handshake and the run path.
    process.argv = ['node', 'self-review-loop.js', '--print-driver-key-env'];
    vi.stubEnv('CQ_SELFHOST_NOW_MS', 'not-a-number');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const priorExitCode = process.exitCode;
    try {
      await main(
        baseDeps(
          fakeGh([]),
          fakeLoop([], async () => fakeOutcome(1)),
        ),
      );
      expect(process.exitCode).toBe(2);
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
        'cq: error: CQ_SELFHOST_NOW_MS',
      );
    } finally {
      process.exitCode = priorExitCode;
      stderr.mockRestore();
    }
  });

  test('a dry run dispatches nothing and needs no provider key', async () => {
    process.argv = ['node', 'self-review-loop.js', '--repo', REPO_PATH, '--dry-run'];
    vi.stubEnv('ZAI_API_KEY', '');
    vi.stubEnv('OPENCODE_GO_API_KEY', '');
    vi.stubEnv('OPENCODE_GO_BASE_URL', '');
    // stdout is spied to keep the payload out of the report; the mock MUST
    // invoke the write callback, which main() awaits (a no-op mock would
    // hang the run).
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(
        (
          _chunk: string | Uint8Array,
          encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
          callback?: (error?: Error | null) => void,
        ) => {
          const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
          done?.(null);
          return true;
        },
      );
    await expect(
      main({
        ...baseDeps(
          fakeGh([]),
          fakeLoop([], async () => fakeOutcome(1)),
        ),
        nowMs: () => at('2026-10-12T07:00:00Z'),
      }),
    ).resolves.toBeUndefined();
    expect(write).toHaveBeenCalled();
  });

  test('main() threads ONE clock read: a boundary-straddling clock cannot pick two providers', async () => {
    const journalRoot = tempJournalRoot();
    process.argv = [
      'node',
      'self-review-loop.js',
      '--repo',
      REPO_PATH,
      '--journal-root',
      journalRoot,
    ];
    // The selected key is present; a sweep that read its OWN clock after the
    // preflight would stamp the journal with the later instant (and, for an
    // adopter with a distinct peak driver, pick the other provider).
    vi.stubEnv('OPENCODE_GO_API_KEY', 'peak-key');
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://go-wire.invalid/v1');
    vi.stubEnv('ZAI_API_KEY', 'present-but-not-selected');
    const peak = Date.parse('2026-10-12T06:00:00Z');
    const offPeakLater = Date.parse('2026-10-12T11:00:00Z');
    let reads = 0;
    const calls: RecordedCall[] = [];
    await main({
      ...baseDeps(
        fakeGh([pullRow(7)]),
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      nowMs: () => {
        reads += 1;
        return reads === 1 ? peak : offPeakLater;
      },
    });
    // Two reads: the entry's single run instant, plus the loop's own per-PR
    // opts.nowMs snapshot. The DRIVER and the run stamp both come from the
    // FIRST (the threaded instant).
    expect(reads).toBe(2);
    expect(calls[0]?.opts.driver).toEqual(SelfhostPeak.driver);
    expect(calls[0]?.opts.nowMs).toBe(offPeakLater);
    expect(calls[0]?.opts.runOptions?.journalDir).toBe(join(journalRoot, `7-${String(peak)}`));
  });
});
