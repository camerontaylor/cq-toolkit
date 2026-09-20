// T4.2 round-trip parity suite — test/cli/parity.test.ts.
//
// ws-i acceptance "Round-trip parity": invoking an op via TS and via the CLI
// with equivalent input yields equal result JSON (modulo run ids/timestamps).
// The sample is the PURE lane (no clock, no I/O): the library op is called
// directly, the CLI dispatches the SAME registry entry, and the two results
// are compared after a recursive volatile-key strip (`runId`, `timestamp`,
// `capturedAt`, `at`, `ts`); the CLI exit code must equal the mechanical
// `exitCodeForOpResult(tsResult)` mapping.
import { describe, expect, test } from 'vitest';
import { exitCodeForOpResult } from '../../src/cli/exit.js';
import { runCli } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';
import type { OpResult } from '../../src/kernel/types.js';
import { clusterErrorsOp } from '../../src/ops/analyze/clusterErrors.js';
import { collectFailuresOp } from '../../src/ops/analyze/collectFailures.js';
import { hackDetector } from '../../src/ops/gates/hackDetector.js';
import { regressionGate } from '../../src/ops/gates/regressionGate.js';
import { checkDiffMonotonicity } from '../../src/ops/ratchet/monotonicGuard.js';

const VOLATILE_KEYS = new Set(['runId', 'timestamp', 'capturedAt', 'at', 'ts']);

/** Recursively drop volatile-by-contract keys (run ids/timestamps). */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stripVolatile(child);
    }
    return out;
  }
  return value;
}

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const io: CliIo = {
    stdout: (chunk) => outChunks.push(chunk),
    stderr: (chunk) => errChunks.push(chunk),
  };
  const code = await runCli(argv, io);
  return { code, out: outChunks.join(''), err: errChunks.join('') };
}

interface ParityCase {
  name: string;
  /** Equivalent CLI argv (flags are the exact schema keys). */
  cliArgs: string[];
  /** The direct TS invocation. */
  ts: () => Promise<OpResult<unknown>>;
}

const EMPTY_SET = { tool: 'tsc', failures: [], exitCode: 0 };

const cases: ParityCase[] = [
  {
    name: 'gates.regressionGate (no regression)',
    cliArgs: [
      'gates.regressionGate',
      `--base=${JSON.stringify(EMPTY_SET)}`,
      `--final=${JSON.stringify(EMPTY_SET)}`,
    ],
    ts: () => regressionGate({ base: { ...EMPTY_SET }, final: { ...EMPTY_SET } }),
  },
  {
    name: 'gates.regressionGate (regression)',
    cliArgs: [
      'gates.regressionGate',
      `--base=${JSON.stringify(EMPTY_SET)}`,
      `--final=${JSON.stringify({
        ...EMPTY_SET,
        failures: [
          {
            file: 'src/a.ts',
            line: 1,
            column: 1,
            ruleId: 'TS2322',
            message: 'boom',
            severity: 'error',
          },
        ],
        exitCode: 2,
      })}`,
    ],
    ts: () =>
      regressionGate({
        base: { ...EMPTY_SET },
        final: {
          ...EMPTY_SET,
          failures: [
            {
              file: 'src/a.ts',
              line: 1,
              column: 1,
              ruleId: 'TS2322',
              message: 'boom',
              severity: 'error',
            },
          ],
          exitCode: 2,
        },
      }),
  },
  {
    name: 'gates.hackDetector (empty diff)',
    cliArgs: ['gates.hackDetector', '--diff='],
    ts: () => hackDetector({ diff: '' }),
  },
  {
    name: 'analyze.collectFailures (empty fleet is a policy failure)',
    cliArgs: ['analyze.collectFailures', '--sets=[]'],
    ts: () => collectFailuresOp({ sets: [] }),
  },
  {
    name: 'analyze.clusterErrors (empty set)',
    cliArgs: ['analyze.clusterErrors', `--set=${JSON.stringify(EMPTY_SET)}`],
    ts: () => clusterErrorsOp({ set: { ...EMPTY_SET } }),
  },
  {
    name: 'ratchet.monotonicGuard (empty diff)',
    cliArgs: ['ratchet.monotonicGuard', '--diff='],
    // The registry op wraps the pure guard: TS parity is the wrapper's shape
    // around the library verdict.
    ts: async () => ({ status: 'ok', value: checkDiffMonotonicity('') }),
  },
];

describe('TS ⇄ CLI round-trip parity (pure sample)', () => {
  test.each(cases)('$name', async ({ name, cliArgs, ts }) => {
    const tsResult = await ts();
    const { code, out, err } = await capture(cliArgs);
    // Failures-only narration: ok rows are silent, non-ok rows carry one
    // `cq: <subcommand>: <status>` line on stderr (never on stdout).
    if (tsResult.status === 'ok') {
      expect(err).toBe('');
    } else {
      expect(err).toContain(`cq: ${name.split(' ')[0]}: ${tsResult.status}`);
    }
    const cliResult: unknown = JSON.parse(out);
    expect(stripVolatile(cliResult)).toEqual(stripVolatile(tsResult));
    expect(code).toBe(exitCodeForOpResult(tsResult));
  });
});
