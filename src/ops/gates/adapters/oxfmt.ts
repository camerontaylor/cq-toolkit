// oxfmt `--check` adapter — the wire lists one unformatted file per line as
//   path (Nms)
// between a "Checking formatting..." header and a summary, and exits 1; a
// clean tree prints "All matched files use the correct format." and exits 0.
// Clean requires exit 0 AND no listed file; exit 1 must list at least one
// file; any other combination (a usage error, an unexpected exit code, an
// unobservable exit) is indeterminate, never clean (I5).
import type {
  CheckAdapter,
  CheckFailure,
  CheckParseResult,
  RawCheckOutput,
} from '../checkRunner.js';

/** Adapter for `oxfmt --check` output: a gate, never a fix source. */
export const oxfmtCheckAdapter: CheckAdapter = {
  name: 'oxfmt-check',
  parse: parseOxfmtCheck,
};

const OXFMT_FILE_LINE = /^(.+?) \(\d+(?:\.\d+)?m?s\)$/;

function parseOxfmtCheck(raw: RawCheckOutput): CheckParseResult {
  const failures: CheckFailure[] = [];
  for (const line of raw.stdout.split('\n')) {
    const file = OXFMT_FILE_LINE.exec(line.trimEnd())?.[1];
    if (file !== undefined)
      failures.push({
        file,
        line: null,
        column: null,
        ruleId: 'oxfmt',
        message: 'not formatted',
        severity: 'error',
      });
  }
  if (raw.exitCode === 0 && failures.length === 0)
    return { verdict: 'parsed', set: { tool: 'oxfmt', failures: [], exitCode: 0 } };
  if (raw.exitCode === 1 && failures.length > 0)
    return { verdict: 'parsed', set: { tool: 'oxfmt', failures, exitCode: 1 } };
  return {
    verdict: 'indeterminate',
    reason: `oxfmt-check: exit ${raw.exitCode === null ? 'unobservable' : String(raw.exitCode)} with ${String(failures.length)} listed file(s)`,
  };
}
