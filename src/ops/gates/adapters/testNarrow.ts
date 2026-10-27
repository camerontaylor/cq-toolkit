import { z } from 'zod';
import type { CheckAdapter } from '../checkRunner.js';
import { vitestJsonAdapter } from './vitest.js';

const Counts = z.object({
  success: z.boolean(),
  numTotalTests: z.number().int().nonnegative(),
  numPassedTests: z.number().int().nonnegative(),
  numFailedTests: z.number().int().nonnegative(),
  numPendingTests: z.number().int().nonnegative().optional().default(0),
  numTodoTests: z.number().int().nonnegative().optional().default(0),
  testResults: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.enum(['passed', 'failed']),
        assertionResults: z.array(
          z.object({
            status: z.enum(['passed', 'failed', 'pending', 'todo', 'skipped', 'disabled']),
          }),
        ),
      }),
    )
    .min(1),
});

/** Only the bounded wrapper's terminal pass/fail is evidence; refusals are unknown. */
export const testNarrowAdapter: CheckAdapter = {
  name: 'test-narrow',
  parse(raw) {
    const unknown = {
      verdict: 'indeterminate' as const,
      reason: 'test-narrow: missing, refused, failed-to-run or inconsistent wrapper evidence',
    };
    const lines = raw.stdout.trimEnd().split('\n');
    if (lines.filter((line) => line.startsWith('test:narrow result=')).length !== 1) return unknown;
    const summary =
      /^test:narrow result="(pass|fail)" exit=(\d+) files=(\d+) (?:projects=\S+ )?tests=("(\d+)\/(\d+)"|-) failed=(\d+|-)(?: |$)/.exec(
        lines.at(-1) ?? '',
      );
    if (!summary || Number(summary[2]) !== raw.exitCode) return unknown;
    const pass = summary[1] === 'pass';
    if ((pass && raw.exitCode !== 0) || (!pass && raw.exitCode !== 1)) return unknown;
    const reports = lines.filter((line) => line.startsWith('test:narrow report='));
    const advisories = lines.filter((line) => line.startsWith('test:narrow advisory='));
    if (
      pass &&
      summary[3] === '0' &&
      summary[4] === '-' &&
      summary[7] === '-' &&
      reports.length === 0 &&
      advisories.length === 1 &&
      advisories[0] === 'test:narrow advisory="no related tests mapped"' &&
      lines.at(-1) === 'test:narrow result="pass" exit=0 files=0 tests=- failed=-'
    )
      return {
        verdict: 'parsed',
        set: { tool: 'vitest', failures: [], exitCode: 0, advisories: ['no related tests mapped'] },
      };
    if (reports.length !== 1 || Number(summary[3]) === 0) return unknown;
    const report = reports[0]!.slice('test:narrow report='.length);
    let value: unknown;
    try {
      value = JSON.parse(report);
    } catch {
      return unknown;
    }
    const counts = Counts.safeParse(value);
    if (
      !counts.success ||
      counts.data.success !== pass ||
      counts.data.numFailedTests !== Number(summary[7]) ||
      new Set(counts.data.testResults.map((suite) => suite.name)).size !== Number(summary[3]) ||
      (pass && counts.data.numPassedTests === 0)
    )
      return unknown;
    const data = counts.data;
    const assertions = data.testResults.flatMap((suite) => suite.assertionResults);
    const skipped = /(?:^| )skipped=(\S+)/.exec(lines.at(-1)!);
    if (skipped && Number(skipped[1]) !== data.numPendingTests + data.numTodoTests) return unknown;
    const count = (status: string) =>
      assertions.filter((assertion) => assertion.status === status).length;
    if (
      assertions.length !== data.numTotalTests ||
      count('passed') !== data.numPassedTests ||
      count('failed') !== data.numFailedTests ||
      count('todo') !== data.numTodoTests ||
      count('pending') + count('skipped') + count('disabled') !== data.numPendingTests ||
      data.numPassedTests + data.numFailedTests + data.numPendingTests + data.numTodoTests !==
        data.numTotalTests ||
      data.testResults.some(
        (suite) =>
          suite.status === 'passed' &&
          suite.assertionResults.some((assertion) => assertion.status === 'failed'),
      ) ||
      pass !== data.testResults.every((suite) => suite.status === 'passed') ||
      advisories.length !== 0
    )
      return unknown;
    const parsed = vitestJsonAdapter.parse({
      ...raw,
      stdout: report,
    });
    if (parsed.verdict !== 'parsed') return unknown;
    const set = parsed.set;
    if (
      set.numTotalTests !== Number(summary[6]) ||
      set.numPassedTests !== Number(summary[5]) ||
      (pass ? set.failures.length !== 0 || summary[7] !== '0' : set.failures.length === 0)
    )
      return unknown;
    return parsed;
  },
};
