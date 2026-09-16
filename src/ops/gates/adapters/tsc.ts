// tsc/tsgo classic-line adapter — the wire is one diagnostic per line:
//   path(line,col): error TS1234: message   (or `warning TS…`)
// Related-info lines carry the same `path(k,k):` prefix but NO TS code and
// are skipped, not failures. Clean requires exit 0 AND empty stdout; any
// other unparsable combination — non-empty stdout with zero parsable lines
// (config crash, unknown flag), or a non-zero exit without parsable output —
// is indeterminate, never clean (I5).
import type {
  CheckAdapter,
  CheckFailure,
  CheckParseResult,
  RawCheckOutput,
} from '../checkRunner.js';

/** Adapter for tsc/tsgo `--pretty false` diagnostic lines. */
export const tscLinesAdapter: CheckAdapter = {
  name: 'tsc-lines',
  parse: parseTscLines,
};

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s?(.*)$/;

function parseTscLines(raw: RawCheckOutput): CheckParseResult {
  const failures: CheckFailure[] = [];
  for (const line of raw.stdout.split('\n')) {
    const match = TSC_LINE.exec(line.trimEnd());
    if (match === null) {
      continue;
    }
    const [, file, lineNumber, column, severity, ruleId, message] = match;
    if (
      file === undefined ||
      lineNumber === undefined ||
      column === undefined ||
      severity === undefined ||
      ruleId === undefined ||
      message === undefined
    ) {
      return { verdict: 'indeterminate', reason: 'tsc-lines: incomplete diagnostic captures' };
    }
    failures.push({
      file,
      line: Number(lineNumber),
      column: Number(column),
      ruleId,
      message,
      severity: severity === 'error' ? 'error' : 'warning',
    });
  }
  if (raw.stdout.trim() === '') {
    if (raw.exitCode === 0) {
      return { verdict: 'parsed', set: { tool: 'tsc', failures: [], exitCode: raw.exitCode } };
    }
    return {
      verdict: 'indeterminate',
      reason: 'tsc-lines: empty output on a non-zero exit',
    };
  }
  if (failures.length === 0) {
    return {
      verdict: 'indeterminate',
      reason: 'tsc-lines: non-empty output with no parsable diagnostics',
    };
  }
  return { verdict: 'parsed', set: { tool: 'tsc', failures, exitCode: raw.exitCode } };
}
