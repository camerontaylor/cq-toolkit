import { match } from '../../helpers/matchers.js';
// Gates lane C2 — test evidence: the baseline probe's full decision table
// over a SCRIPTED fake runner (no subprocesses): every ProbeVerdict value —
// clean, failing, bail (pattern and exitCode-null flavors, retry budget
// 0/1/2, storm, retry-then-clean) — and both indeterminate flavors (parse
// verdict + runner crash). Plus the I7 no-cache property: the op input has
// no baseline field by construction, and two identical calls re-run the
// check twice.
import { describe, expect, test } from 'vitest';
import { DEFAULT_BAIL_PATTERNS, makeBaselineProbe } from '../../../src/ops/gates/baselineProbe.js';
import type { BaselineProbeInput } from '../../../src/ops/gates/index.js';
import type { RawCheckOutput, RunCheck } from '../../../src/ops/gates/index.js';

/** A vitest-json capture that parses clean behind exit 0. */
const CLEAN_VITEST = (exitCode = 0): RawCheckOutput => ({
  stdout: JSON.stringify({
    success: true,
    numTotalTests: 2,
    numFailedTests: 0,
    testResults: [
      {
        name: '/tmp/a.test.ts',
        status: 'passed',
        assertionResults: [
          {
            title: 'ok',
            fullName: 'a > ok',
            status: 'passed',
            ancestorTitles: ['a'],
            failureMessages: [],
          },
        ],
      },
    ],
  }),
  stderr: '',
  exitCode,
});

/** An eslint-json capture with one failure behind exit 1. */
const FAILING_ESLINT: RawCheckOutput = {
  stdout: JSON.stringify([
    {
      filePath: '/tmp/bad.ts',
      messages: [
        {
          ruleId: 'prefer-const',
          severity: 2,
          message: "'g' is never reassigned.",
          line: 4,
          column: 7,
        },
      ],
    },
  ]),
  stderr: '',
  exitCode: 1,
};

/** A scripted runner: pops one script entry per call; a spent script throws loudly. */
function scriptedRunner(...script: Array<RawCheckOutput | Error>): {
  run: RunCheck;
  callCount(): number;
} {
  let index = 0;
  let calls = 0;
  return {
    run: async () => {
      calls++;
      const next = script[index];
      index++;
      if (next === undefined) {
        throw new Error('script exhausted');
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    callCount: () => calls,
  };
}

const COMMAND = { command: 'npm', args: ['test', '--', '--reporter=json'] };

function probeInput(overrides?: Partial<BaselineProbeInput>): BaselineProbeInput {
  return { adapter: 'vitest-json', command: COMMAND, ...overrides };
}

describe('baselineProbe decision table (scripted fake runner)', () => {
  test('clean: parsed zero failures behind exit 0 → clean on attempt 1, failure set attached', async () => {
    const fake = scriptedRunner(CLEAN_VITEST());
    const probe = makeBaselineProbe(fake.run);
    const result = await probe(probeInput());
    expect(result).toEqual({
      status: 'ok',
      value: {
        verdict: 'clean',
        attempts: 1,
        failureSet: { tool: 'vitest', failures: [], exitCode: 0 },
      },
    });
    expect(fake.callCount()).toBe(1);
  });

  test('failing: parsed non-empty failures → failing with the failure set', async () => {
    const fake = scriptedRunner(FAILING_ESLINT);
    const probe = makeBaselineProbe(fake.run);
    const result = await probe(probeInput({ adapter: 'eslint-json' }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('failing');
    expect(result.value.attempts).toBe(1);
    expect(result.value.failureSet).toMatchObject({ tool: 'eslint', exitCode: 1 });
    expect(result.value.failureSet?.failures).toHaveLength(1);
  });

  test('bail: pattern hit on an UNPARSEABLE attempt (case-insensitive), maxBailRetries 0 → one attempt, no failure set', async () => {
    const fake = scriptedRunner({
      stdout: '',
      stderr: 'FATAL ERROR: Reached heap limit — allocation failed',
      exitCode: 1,
    });
    const probe = makeBaselineProbe(fake.run);
    const result = await probe(probeInput({ bail: { maxBailRetries: 0 } }));
    expect(result).toEqual({ status: 'ok', value: { verdict: 'bail', attempts: 1 } });
    expect(fake.callCount()).toBe(1);
  });

  test('bail budget scales: maxBailRetries 1 → 2 attempts, 2 → 3 attempts', async () => {
    const bailOutput: RawCheckOutput = { stdout: 'no tests found', stderr: '', exitCode: 1 };
    const oneRetry = scriptedRunner(bailOutput, bailOutput);
    await expect(
      makeBaselineProbe(oneRetry.run)(probeInput({ bail: { maxBailRetries: 1 } })),
    ).resolves.toEqual({ status: 'ok', value: { verdict: 'bail', attempts: 2 } });
    expect(oneRetry.callCount()).toBe(2);
    const twoRetries = scriptedRunner(bailOutput, bailOutput, bailOutput);
    await expect(
      makeBaselineProbe(twoRetries.run)(probeInput({ bail: { maxBailRetries: 2 } })),
    ).resolves.toEqual({ status: 'ok', value: { verdict: 'bail', attempts: 3 } });
    expect(twoRetries.callCount()).toBe(3);
  });

  test('bail storm: every attempt bails through the default budget → bail (default config)', async () => {
    const storm = scriptedRunner(
      { stdout: '', stderr: 'econnrefused 127.0.0.1:5432', exitCode: null },
      { stdout: 'spawn enoent', stderr: '', exitCode: null },
      { stdout: '', stderr: 'JavaScript heap out of memory', exitCode: 3 },
    );
    const result = await makeBaselineProbe(storm.run)(probeInput());
    expect(result).toEqual({ status: 'ok', value: { verdict: 'bail', attempts: 3 } });
    expect(storm.callCount()).toBe(3);
  });

  test('retry-then-clean: bail once, then a completed run → clean on attempt 2', async () => {
    const fake = scriptedRunner(
      { stdout: '', stderr: 'test run aborted', exitCode: 1 },
      CLEAN_VITEST(),
    );
    const result = await makeBaselineProbe(fake.run)(probeInput());
    expect(result).toEqual({
      status: 'ok',
      value: {
        verdict: 'clean',
        attempts: 2,
        failureSet: { tool: 'vitest', failures: [], exitCode: 0 },
      },
    });
  });

  test('exitCode null with NO pattern match (signal kill) is a bail per the exitCode-null rule', async () => {
    const fake = scriptedRunner({
      stdout: 'partial output, no signature',
      stderr: '',
      exitCode: null,
    });
    const result = await makeBaselineProbe(fake.run)(probeInput({ bail: { maxBailRetries: 0 } }));
    expect(result).toEqual({ status: 'ok', value: { verdict: 'bail', attempts: 1 } });
  });

  test('exitCode null is a bail-candidate even when the partial output would parse', async () => {
    const fake = scriptedRunner({ ...CLEAN_VITEST(), exitCode: null });
    const result = await makeBaselineProbe(fake.run)(probeInput({ bail: { maxBailRetries: 0 } }));
    expect(result).toEqual({ status: 'ok', value: { verdict: 'bail', attempts: 1 } });
    expect(fake.callCount()).toBe(1);
  });

  test('a failing run whose failure TEXT quotes a signature is FAILING, never bail (parseable evidence wins)', async () => {
    const stdout = JSON.stringify({
      success: false,
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/tmp/conn.test.ts',
          status: 'failed',
          assertionResults: [
            {
              title: 'refuses bad connections',
              fullName: 'conn > refuses bad connections',
              status: 'failed',
              ancestorTitles: ['conn'],
              failureMessages: ['Error: connect ECONNREFUSED 127.0.0.1:5432'],
            },
          ],
        },
      ],
    });
    const fake = scriptedRunner({ stdout, stderr: '', exitCode: 1 });
    const result = await makeBaselineProbe(fake.run)(probeInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('failing');
    expect(result.value.attempts).toBe(1);
    expect(result.value.failureSet).toMatchObject({ tool: 'vitest', exitCode: 1 });
    // The adapter derives the message from fullName (failureMessages feed
    // only fallbacks), so the signature text lives in the raw capture —
    // and the classification is STILL failing, not bail.
    expect(result.value.failureSet?.failures).toHaveLength(1);
    expect(fake.callCount()).toBe(1);
  });

  test('a NaN, Infinity, or negative maxBailRetries falls back to the default 2 (3 attempts), never a NaN budget', async () => {
    const bailOutput: RawCheckOutput = { stdout: 'test run aborted', stderr: '', exitCode: 1 };
    for (const bogus of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
      const fake = scriptedRunner(bailOutput, bailOutput, bailOutput);
      const result = await makeBaselineProbe(fake.run)(
        probeInput({ bail: { bailPatterns: ['test run aborted'], maxBailRetries: bogus } }),
      );
      expect(result).toEqual({ status: 'ok', value: { verdict: 'bail', attempts: 3 } });
      expect(fake.callCount()).toBe(3);
    }
  });

  test('a library-level maxBailRetries of 1000 clamps to the 10 ceiling (at most 11 attempts)', async () => {
    const bailOutput: RawCheckOutput = { stdout: 'test run aborted', stderr: '', exitCode: 1 };
    // One extra scripted output: an un-clamped budget would over-draw and
    // trip the runner's loud 'script exhausted' throw.
    const fake = scriptedRunner(...Array.from({ length: 12 }, () => bailOutput));
    const result = await makeBaselineProbe(fake.run)(
      probeInput({ bail: { bailPatterns: ['test run aborted'], maxBailRetries: 1000 } }),
    );
    expect(result).toEqual({ status: 'ok', value: { verdict: 'bail', attempts: 11 } });
    expect(fake.callCount()).toBe(11);
  });

  test('indeterminate (a): empty stdout on vitest-json (summary-bearing tool) → indeterminate, never clean', async () => {
    const fake = scriptedRunner({ stdout: '', stderr: '', exitCode: 0 });
    const result = await makeBaselineProbe(fake.run)(probeInput());
    expect(result.status).toBe('indeterminate');
    if (result.status !== 'indeterminate') {
      return;
    }
    expect(result.detail).toContain('vitest-json:');
  });

  test('indeterminate (b): unparseable garbage → indeterminate', async () => {
    const fake = scriptedRunner({ stdout: '⟨not json at all⟩', stderr: '', exitCode: 1 });
    const result = await makeBaselineProbe(fake.run)(probeInput());
    expect(result).toMatchObject({ status: 'indeterminate', detail: match.any(String) });
  });

  test('indeterminate (c): a thrown runner crashes the probe → indeterminate with check-runner-crashed detail', async () => {
    const fake = scriptedRunner(new Error('maxBuffer exceeded'));
    const result = await makeBaselineProbe(fake.run)(probeInput());
    expect(result).toEqual({
      status: 'indeterminate',
      detail: 'check runner crashed: maxBuffer exceeded',
    });
  });

  test('indeterminate (c2): a non-Error throw still yields an honest detail', async () => {
    const probe = makeBaselineProbe(async () => {
      throw 'boom-string';
    });
    await expect(probe(probeInput())).resolves.toEqual({
      status: 'indeterminate',
      detail: 'check runner crashed: boom-string',
    });
  });

  test('custom bailPatterns REPLACE the defaults: a default-signature output does NOT bail', async () => {
    const patterns = { bailPatterns: ['custom infrastructure doom'], maxBailRetries: 0 };
    // 'no tests found' is a SHIPPED signature. Under custom patterns it is not a bail:
    // a passing vitest report whose test NAME contains the phrase completes and parses clean.
    const passesMentioningNoTestsFound: RawCheckOutput = {
      stdout: JSON.stringify({
        success: true,
        numTotalTests: 1,
        numFailedTests: 0,
        testResults: [
          {
            name: '/tmp/x.test.ts',
            status: 'passed',
            assertionResults: [
              {
                title: 'no tests found',
                fullName: 'x > no tests found',
                status: 'passed',
                ancestorTitles: ['x'],
                failureMessages: [],
              },
            ],
          },
        ],
      }),
      stderr: '',
      exitCode: 0,
    };
    const parsePath = scriptedRunner(passesMentioningNoTestsFound);
    await expect(
      makeBaselineProbe(parsePath.run)(probeInput({ bail: patterns })),
    ).resolves.toMatchObject({ status: 'ok', value: { verdict: 'clean', attempts: 1 } });
    expect(parsePath.callCount()).toBe(1);
    // Same signature as unparseable output: the attempt still reaches the PARSER
    // (indeterminate), proving it was never bailed on.
    const indeterminatePath = scriptedRunner({ stdout: 'no tests found', stderr: '', exitCode: 1 });
    await expect(
      makeBaselineProbe(indeterminatePath.run)(probeInput({ bail: patterns })),
    ).resolves.toMatchObject({ status: 'indeterminate' });
    // Positive control: the CUSTOM signature does bail.
    const dooming = scriptedRunner({
      stdout: 'CUSTOM INFRASTRUCTURE DOOM',
      stderr: '',
      exitCode: 0,
    });
    await expect(makeBaselineProbe(dooming.run)(probeInput({ bail: patterns }))).resolves.toEqual({
      status: 'ok',
      value: { verdict: 'bail', attempts: 1 },
    });
  });
});

describe('baselineProbe I7: no cache, no baseline input, no memoization', () => {
  test('two calls with identical input run the check twice (zero memoization)', async () => {
    const fake = scriptedRunner(CLEAN_VITEST(), CLEAN_VITEST());
    const probe = makeBaselineProbe(fake.run);
    const input = probeInput();
    const first = await probe(input);
    const second = await probe(input);
    expect(first).toEqual(second);
    expect(fake.callCount()).toBe(2);
  });

  test('DEFAULT_BAIL_PATTERNS is a frozen array carrying the shipped signatures', () => {
    expect(Object.isFrozen(DEFAULT_BAIL_PATTERNS)).toBe(true);
    expect(DEFAULT_BAIL_PATTERNS).toContain('no tests found');
    expect(DEFAULT_BAIL_PATTERNS).toContain('spawn enoent');
  });
});
