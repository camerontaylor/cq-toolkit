// Ratchet baseline file format — lane H slice 1.
//
// One baseline file per (target, metric): the unit the ratchet op family
// compares against. The file is committed evidence, so two properties are
// load-bearing:
//   - renderBaseline is BYTE-DETERMINISTIC: keys are emitted in schema order
//     regardless of the caller's insertion order, 2-space indent, exactly one
//     trailing newline. The same baseline always renders to the same bytes,
//     so a re-capture cannot produce a spurious diff.
//   - parseBaseline is STRICT: zod validates the full schema (extra keys fail
//     rather than being silently stripped) and violations throw a plain Error
//     with a clear message.
// tightens/loosens are pure comparators: equal values are neither, so an
// unchanged metric never rewrites a baseline.
import { z } from 'zod';

/** Which way the metric's "better" points. */
export type Direction = 'lower-is-better' | 'higher-is-better';

/** The persisted baseline: one file per (target, metric). */
export interface BaselineFile {
  schemaVersion: 1;
  /** What is measured: a logical name or repo-relative path. */
  target: string;
  /** Adapter id, e.g. 'typecheck-count'. */
  metric: string;
  direction: Direction;
  /** The ratcheted value. */
  value: number;
  /** Adapter-defined, e.g. 'errors', 'pct'. */
  unit?: string;
  /** ISO-8601 timestamp. */
  capturedAt: string;
}

const BaselineFileSchema: z.ZodType<BaselineFile> = z.object({
  schemaVersion: z.literal(1),
  target: z.string(),
  metric: z.string(),
  direction: z.enum(['lower-is-better', 'higher-is-better']),
  value: z.number(),
  unit: z.string().optional(),
  capturedAt: z.string(),
}).strict();

/** Serialize a baseline deterministically: schema-order keys, 2-space indent, trailing newline. */
export function renderBaseline(b: BaselineFile): string {
  // Rebuilt field-by-field so the emitted key order is the schema order, not
  // the caller's insertion order. `unit: undefined` is dropped by
  // JSON.stringify, matching the schema's optional field.
  const ordered = {
    schemaVersion: b.schemaVersion,
    target: b.target,
    metric: b.metric,
    direction: b.direction,
    value: b.value,
    unit: b.unit,
    capturedAt: b.capturedAt,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Parse and validate baseline text; throws a plain Error on any schema violation. */
export function parseBaseline(text: string): BaselineFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`baseline: not valid JSON — ${(err as Error).message}`, { cause: err });
  }
  const parsed = BaselineFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`baseline: schema violation — ${issues}`);
  }
  return parsed.data;
}

/** Collapse a target/metric to a path segment: lowercase, [a-z0-9-] only, no doubled or edge dashes. */
function sanitizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deterministic repo-relative path for one (target, metric) baseline. */
export function baselineRelPath(target: string, metric: string): string {
  return `baselines/${sanitizeSegment(target)}--${sanitizeSegment(metric)}.json`;
}

/** True when `next` improves on `prev` for direction `d`; equal values are never a tighten. */
export function tightens(prev: number, next: number, d: Direction): boolean {
  return d === 'lower-is-better' ? next < prev : next > prev;
}

/** True when `next` regresses on `prev` for direction `d`; equal values are never a loosen. */
export function loosens(prev: number, next: number, d: Direction): boolean {
  return d === 'lower-is-better' ? next > prev : next < prev;
}
