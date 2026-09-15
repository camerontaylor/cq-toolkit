// vitest JSON-reporter adapter — the wire is a top-level summary (`success`
// boolean, `numTotalTests`) plus a `testResults` array of suites, each with
// an `assertionResults` array. Failing assertions become failures: the
// message comes from `fullName` / `ancestorTitles`+`title`, the file from
// the suite `name`, line/column from `location` when the reporter emitted
// one. A failed suite with NO failing-assertion detail surfaces its
// `message` (or the first failureMessage line) as ONE suite-level failure.
// Anything that is not this shape — truncated JSON, wrong envelope, missing
// summary — is indeterminate, never clean (I5).
import type {
  CheckAdapter,
  CheckFailure,
  CheckParseResult,
  RawCheckOutput,
} from '../checkRunner.js';

/** Adapter for vitest's `--reporter=json` output. */
export const vitestJsonAdapter: CheckAdapter = {
  name: 'vitest-json',
  parse: parseVitestJson,
};

function parseVitestJson(raw: RawCheckOutput): CheckParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.stdout);
  } catch {
    return { verdict: 'indeterminate', reason: 'vitest-json: output is not valid JSON' };
  }
  const report = asRecord(parsed);
  if (
    report === null ||
    typeof report.success !== 'boolean' ||
    typeof report.numTotalTests !== 'number' ||
    !Array.isArray(report.testResults)
  ) {
    return {
      verdict: 'indeterminate',
      reason: 'vitest-json: missing the success/numTotalTests/testResults summary',
    };
  }
  const failures: CheckFailure[] = [];
  for (const suite of report.testResults) {
    const suiteRecord = asRecord(suite);
    if (suiteRecord === null) {
      return { verdict: 'indeterminate', reason: 'vitest-json: testResults entry is not an object' };
    }
    const file = typeof suiteRecord.name === 'string' ? suiteRecord.name : null;
    if (!Array.isArray(suiteRecord.assertionResults)) {
      return {
        verdict: 'indeterminate',
        reason: 'vitest-json: testResults entry without an assertionResults array',
      };
    }
    const assertions = suiteRecord.assertionResults;
    let failingAssertions = 0;
    for (const assertion of assertions) {
      const record = asRecord(assertion);
      if (record === null) {
        return {
          verdict: 'indeterminate',
          reason: 'vitest-json: assertionResults entry is not an object',
        };
      }
      if (record.status !== 'failed') {
        continue;
      }
      failingAssertions++;
      const line = firstFailureLine(record);
      const message = assertionMessage(record, line);
      if (message === null) {
        return {
          verdict: 'indeterminate',
          reason: 'vitest-json: failing assertion without any message field',
        };
      }
      const location = asRecord(record.location);
      failures.push({
        file,
        line: typeof location?.line === 'number' ? location.line : null,
        column: typeof location?.column === 'number' ? location.column : null,
        ruleId: null,
        message,
        severity: 'error',
      });
    }
    if (suiteRecord.status === 'failed' && failingAssertions === 0) {
      const suiteMessage =
        typeof suiteRecord.message === 'string' && suiteRecord.message.trim() !== ''
          ? suiteRecord.message.trim()
          : firstFailureLine(suiteRecord);
      if (suiteMessage === null) {
        return {
          verdict: 'indeterminate',
          reason: 'vitest-json: failed suite without message or failureMessages detail',
        };
      }
      failures.push({
        file,
        line: null,
        column: null,
        ruleId: null,
        message: suiteMessage,
        severity: 'error',
      });
    }
  }
  if (failures.length === 0 && report.success === false) {
    // Adapter-domain I5 knowledge: `success` exists only in the vitest
    // shape, and success:false with zero extracted failures is
    // contradictory evidence — never certified clean.
    return {
      verdict: 'indeterminate',
      reason: 'summary reports a failing run but no failure details were extracted',
    };
  }
  return { verdict: 'parsed', set: { tool: 'vitest', failures, exitCode: raw.exitCode } };
}

/** The test title, titles-chain style: ancestorTitles joined with the title. */
function assertionMessage(
  record: Record<string, unknown>,
  fallbackLine: string | null,
): string | null {
  if (typeof record.fullName === 'string' && record.fullName.trim() !== '') {
    return record.fullName;
  }
  const ancestors = Array.isArray(record.ancestorTitles)
    ? record.ancestorTitles.filter((part): part is string => typeof part === 'string')
    : [];
  const title = typeof record.title === 'string' ? record.title : '';
  const composed = [...ancestors, title].filter((part) => part !== '').join(' > ');
  return composed !== '' ? composed : fallbackLine;
}

/** First non-empty line of the first string failureMessage, when present. */
function firstFailureLine(record: Record<string, unknown>): string | null {
  if (!Array.isArray(record.failureMessages)) {
    return null;
  }
  for (const message of record.failureMessages) {
    if (typeof message !== 'string') {
      continue;
    }
    const line = message.split('\n', 1)[0]?.trim();
    if (line !== undefined && line !== '') {
      return line;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
