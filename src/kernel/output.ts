// I1 output contract helpers — T1.2 slice 3.
//
// THE I1 CONTRACT: stdout carries exactly one machine-readable artifact — the
// run report as JSON. stderr carries human narration. The two never mix:
// narration NEVER touches stdout, so `cq <plan> | jq .` is always safe.
//
// renderHuman is the human view, and its DEFAULT is failures-only (the
// nx/turbo pattern): nobody wants ten green rows when one row failed; pass
// { all: true } for the full picture. Output is deterministic text — no
// colors, no timestamps — so the same report always renders byte-identical.
//
// These helpers write bytes and build strings, nothing more. CLI exit codes
// {0,1,2,3} are NOT encoded here — they belong to the CLI layer (phase-2
// lane I; the DD-7 resolution lives there), which reads the report and
// decides how the run ended.
import type { JobOutcome, RunReport } from './types.js';

/** Write the run report to stdout as pretty JSON plus a trailing newline. Pure in its argument; reads nothing. */
export function emitReport(report: RunReport): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** One narration line to stderr with the `cq:` prefix. Never stdout (I1). */
export function narrate(message: string): void {
  process.stderr.write(`cq: ${message}\n`);
}

/** Human-readable detail of a result row; `ok` rows render bare (values can be arbitrarily large). */
function rowDetail(result: JobOutcome['result']): string {
  switch (result.status) {
    case 'ok':
      return '';
    case 'failed':
      return result.error;
    case 'needs-human':
      return result.reason;
    case 'budget-exhausted':
      return 'budget bound hit';
    case 'indeterminate':
      return result.detail;
  }
}

/**
 * Human view of a run report. DEFAULT = failures-only: one line per non-ok
 * row, `<jobId> (<op>): <status> — <error/reason/detail>`, plus one summary
 * line over all six states. `opts.all === true` renders every row (ok rows
 * as `<jobId> (<op>): ok`). Deterministic: no colors, no timestamps, rows in
 * report order.
 */
export function renderHuman(report: RunReport, opts?: { all?: boolean }): string {
  const lines: string[] = [];
  for (const row of report.jobs) {
    if (!opts?.all && row.result.status === 'ok') continue;
    const detail = rowDetail(row.result);
    lines.push(
      detail === ''
        ? `${row.jobId} (${row.op}): ${row.result.status}`
        : `${row.jobId} (${row.op}): ${row.result.status} — ${detail}`,
    );
  }
  const c = report.counts;
  lines.push(
    `done ${c.done}, failed ${c.failed}, blocked ${c.blocked}, queued ${c.queued}, ` +
      `running ${c.running}, budget-exhausted ${c['budget-exhausted']}`,
  );
  return lines.join('\n');
}
