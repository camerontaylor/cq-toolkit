// oxfmt `--check` adapter — the wire lists one unformatted file per line as
//   path (Nms)
// between a "Checking formatting..." header and a summary, and exits 1; a
// clean tree prints "All matched files use the correct format." and exits 0.
// ANSI styling is stripped first. Clean requires exit 0 AND the recognized
// clean summary AND no listed file; a failure report requires exit 1, its
// "Format issues found in above N files" summary, and exactly N listed
// files. Any other combination (empty or help output, a usage error, an
// unexpected or unobservable exit, a partial capture) is indeterminate,
// never clean (I5).
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
const OXFMT_CLEAN_SUMMARY = /^All matched files use the correct format\.$/;
const OXFMT_ISSUES_SUMMARY = /^Format issues found in above (\d+) files?\b/;
// SGR colour/style sequences; a coloured record must not vanish from the set.
// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

function parseOxfmtCheck(raw: RawCheckOutput): CheckParseResult {
  const failures: CheckFailure[] = [];
  let clean = false;
  let issues: number | undefined;
  for (const rawLine of raw.stdout.split('\n')) {
    const line = rawLine.replace(ANSI_SGR, '').trimEnd();
    if (OXFMT_CLEAN_SUMMARY.test(line)) clean = true;
    const summary = OXFMT_ISSUES_SUMMARY.exec(line)?.[1];
    if (summary !== undefined) issues = Number(summary);
    const file = OXFMT_FILE_LINE.exec(line)?.[1];
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
  // Clean needs the recognized completed clean report — empty, help or
  // unrecognized output on exit 0 is not format evidence.
  if (raw.exitCode === 0 && clean && failures.length === 0 && issues === undefined)
    return { verdict: 'parsed', set: { tool: 'oxfmt', failures: [], exitCode: 0 } };
  // A failure report needs its summary, and the summary's count must match
  // the files parsed — a partial capture never stands in for the whole.
  if (raw.exitCode === 1 && !clean && failures.length > 0 && issues === failures.length)
    return { verdict: 'parsed', set: { tool: 'oxfmt', failures, exitCode: 1 } };
  return {
    verdict: 'indeterminate',
    reason: `oxfmt-check: exit ${raw.exitCode === null ? 'unobservable' : String(raw.exitCode)} with ${String(failures.length)} listed file(s), summary ${clean ? 'clean' : issues === undefined ? 'absent' : `of ${String(issues)} issue(s)`}`,
  };
}
