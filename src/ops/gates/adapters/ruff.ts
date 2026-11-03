// Ruff check --output-format json (0.14.3 wire fixture).
import { z } from 'zod';
import type { CheckAdapter } from '../checkRunner.js';

const Position = z.object({
  row: z.number().int().positive(),
  column: z.number().int().positive(),
});
const Report = z.array(
  z.object({
    filename: z.string().min(1).nullable(),
    code: z.string().min(1).nullable(),
    message: z.string().min(1),
    location: Position.nullable(),
  }),
);

export const ruffJsonAdapter: CheckAdapter = {
  name: 'ruff-json',
  parse(raw) {
    const unknown = {
      verdict: 'indeterminate' as const,
      reason: 'ruff-json: missing, malformed or contradictory lint report',
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
    const failures = parsed.data.map((item) => ({
      file: item.filename,
      ruleId: item.code,
      message: item.message,
      severity: 'error' as const,
      line: item.location?.row ?? null,
      column: item.location?.column ?? null,
    }));
    if ((raw.exitCode === 0) !== (failures.length === 0)) return unknown;
    return { verdict: 'parsed', set: { tool: 'ruff', failures, exitCode: raw.exitCode } };
  },
};
