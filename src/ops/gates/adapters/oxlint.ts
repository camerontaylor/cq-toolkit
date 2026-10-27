// Oxlint's JSON envelope is diagnostics[], not ESLint's per-file array.
// Require a completed nonempty file scan and recognized diagnostics (I5).
import { z } from 'zod';
import type { CheckAdapter } from '../checkRunner.js';

const Report = z.object({
  number_of_files: z.number().int().positive(),
  diagnostics: z.array(
    z.object({
      message: z.string().min(1),
      code: z.string().min(1),
      severity: z.enum(['error', 'warning']),
      filename: z.string().min(1),
      labels: z
        .array(
          z.object({
            span: z.object({
              line: z.number().int().positive(),
              column: z.number().int().positive(),
            }),
          }),
        )
        .min(1),
    }),
  ),
});

/** Typed Oxlint is a verification gate, not a fix.run static source. */
export const oxlintJsonAdapter: CheckAdapter = {
  name: 'oxlint-json',
  parse(raw) {
    const unknown = {
      verdict: 'indeterminate' as const,
      reason: 'oxlint-json: missing, malformed or contradictory completed lint report',
    };
    if (raw.exitCode !== 0 && raw.exitCode !== 1) return unknown;
    let value: unknown;
    try {
      value = JSON.parse(raw.stdout);
    } catch {
      return unknown;
    }
    const parsed = Report.safeParse(value);
    if (!parsed.success) return unknown;
    const failures = parsed.data.diagnostics.map((d) => ({
      file: d.filename,
      ruleId: d.code,
      message: d.message,
      severity: d.severity,
      line: d.labels[0]!.span.line,
      column: d.labels[0]!.span.column,
    }));
    if (
      (raw.exitCode === 1 && failures.length === 0) ||
      (raw.exitCode === 0 && failures.some((f) => f.severity === 'error'))
    )
      return unknown;
    return { verdict: 'parsed', set: { tool: 'oxlint', failures, exitCode: raw.exitCode } };
  },
};
