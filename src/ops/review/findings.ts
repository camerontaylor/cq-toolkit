import { z } from 'zod';
import { ReviewCoverageSchema } from './internal/reviewPartitions.js';
import { isCoverageV2Complete } from './internal/reviewCoverageV2.js';

/**
 * Side-aware location of an exact quoted range in one tree of the reviewed
 * comparison (R3S additive evidence schema, card R3S of plans/upcoming-20261027).
 * `side` names the tree the range lives in: `base` for removed code, `head`
 * for added or surviving code. `start`/`end` are inclusive 1-based line
 * numbers into that side's pinned blob and `quote` is the exact bytes of
 * lines start..end (never normalized or trimmed). The validating engine
 * supplies the pinned blobs; this schema carries only what a producer emits.
 */
export const FindingAnchorSchema = z
  .object({
    file: z.string().min(1),
    side: z.enum(['base', 'head']),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    quote: z.string().min(1),
  })
  .strict();
export type FindingAnchor = z.infer<typeof FindingAnchorSchema>;

/**
 * Bounded supporting evidence for a finding: an anchor plus the producer's
 * stated reason it supports the failure scenario. Producers must keep this
 * small; the schema cap is a hard bound, not a style hint.
 */
export const SupportingEvidenceSchema = FindingAnchorSchema.extend({
  relevance: z.string().min(1),
}).strict();
export type SupportingEvidence = z.infer<typeof SupportingEvidenceSchema>;

/**
 * Version 1 additive agent evidence payload (R3S). `failureScenario` states
 * the concrete behavior the finding claims; `primary` anchors it;
 * `supporting` (max 5) may cite dependencies. `validation` appears only on
 * an INVALID survivor the engine chose to persist: it carries the reasons,
 * and the rest of the payload stays the raw candidate unchanged. A payload
 * without `validation` is producer-attested and not yet engine-validated.
 *
 * R3S ships the schema and the pure validator only: no runtime producer is
 * required to emit it before R3W wires the reviewer, and no runtime behavior
 * change is claimed until R3W consumes it.
 */
export const FindingEvidenceV1Schema = z
  .object({
    version: z.literal(1),
    failureScenario: z.string().min(1),
    primary: FindingAnchorSchema,
    supporting: z.array(SupportingEvidenceSchema).max(5),
    validation: z
      .object({ status: z.literal('invalid'), reasons: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type FindingEvidenceV1 = z.infer<typeof FindingEvidenceV1Schema>;

/** Normalized finding shared by local and forge review producers. */
export const FindingSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    rule: z.string().optional(),
    severity: z.string().min(1),
    text: z.string(),
    status: z.enum(['open', 'fixed', 'rejected', 'deferred']),
    reason: z.string().optional(),
    evidence: z.string().optional(),
    /**
     * Optional versioned evidence payload. Legacy records (including every
     * CodeRabbit-shaped finding) lack it and stay valid unchanged; the record
     * envelope's `schemaVersion` therefore remains 1. The payload versions
     * itself under its own `version` literal so later evidence schemas can
     * add a sibling field without breaking any reader of this one.
     */
    evidenceV1: FindingEvidenceV1Schema.optional(),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;
export const ReviewSourceSchema = z
  .object({
    kind: z.enum(['coderabbit', 'agent', 'pr-threads']),
    status: z.enum(['terminal', 'blocked']),
    reason: z.string().optional(),
    cycleId: z.string().optional(),
    coverage: ReviewCoverageSchema.optional(),
  })
  .strict();
export type ReviewSource = z.infer<typeof ReviewSourceSchema>;
export const FindingsRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    branch: z.string(),
    head: z.string(),
    /** Immutable comparison and coverage attested by the review producer. Legacy records lack proof. */
    reviewed: z
      .object({
        base: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        scope: z.enum(['full', 'uncommitted']),
      })
      .strict()
      .optional(),
    sources: z.array(ReviewSourceSchema),
    findings: z.array(FindingSchema),
    /** Report context only: never dispatched to a fixer or counted as blocking. */
    advisories: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type FindingsRecord = z.infer<typeof FindingsRecordSchema>;

function key(finding: Finding): string {
  return finding.file !== undefined && finding.line !== undefined && finding.rule !== undefined
    ? `${finding.file}\0${finding.line}\0${finding.rule}`
    : `id\0${finding.id}`;
}

const severityRank: Record<string, number> = {
  critical: 6,
  blocker: 6,
  high: 5,
  major: 4,
  moderate: 3,
  medium: 3,
  minor: 2,
  low: 1,
  info: 0,
};

function mergeFinding(previous: Finding, next: Finding): Finding {
  const severity =
    (severityRank[next.severity.toLowerCase()] ?? -1) >
    (severityRank[previous.severity.toLowerCase()] ?? -1)
      ? next.severity
      : previous.severity;
  const status =
    previous.status === 'open' || next.status === 'open'
      ? 'open'
      : previous.status === 'deferred' || next.status === 'deferred'
        ? 'deferred'
        : previous.status === 'rejected' || next.status === 'rejected'
          ? 'rejected'
          : 'fixed';
  return {
    ...previous,
    ...(previous.file === undefined && next.file !== undefined ? { file: next.file } : {}),
    ...(previous.line === undefined && next.line !== undefined ? { line: next.line } : {}),
    ...(previous.rule === undefined && next.rule !== undefined ? { rule: next.rule } : {}),
    severity,
    status,
    source: [...new Set(`${previous.source},${next.source}`.split(','))].join(','),
    ...(previous.reason === undefined && next.reason !== undefined ? { reason: next.reason } : {}),
    ...(previous.evidence === undefined && next.evidence !== undefined
      ? { evidence: next.evidence }
      : {}),
    ...(previous.evidenceV1 === undefined && next.evidenceV1 !== undefined
      ? { evidenceV1: next.evidenceV1 }
      : {}),
  };
}

/** Merge source records deterministically, retaining the first id and unioning source labels. */
export function merge(records: readonly FindingsRecord[]): FindingsRecord {
  const first = records[0];
  if (first === undefined) throw new Error('findings.merge requires at least one record');
  const sources = new Map<string, ReviewSource>();
  const findings = new Map<string, Finding>();
  const advisories = new Set<string>();
  for (const record of records) {
    if (record.branch !== first.branch || record.head !== first.head)
      throw new Error('findings records must describe the same branch and head');
    for (const source of record.sources)
      sources.set(`${source.kind}\0${source.cycleId ?? ''}`, source);
    for (const advisory of record.advisories ?? []) advisories.add(advisory);
    for (const finding of record.findings) {
      const id = key(finding),
        previous = findings.get(id);
      if (previous === undefined) findings.set(id, finding);
      else findings.set(id, mergeFinding(previous, finding));
    }
  }
  return {
    schemaVersion: 1,
    branch: first.branch,
    head: first.head,
    ...(first.reviewed &&
    records.every(
      (record) =>
        record.reviewed?.base === first.reviewed!.base &&
        record.reviewed.scope === first.reviewed!.scope,
    )
      ? { reviewed: first.reviewed }
      : {}),
    sources: [...sources.values()],
    findings: [...findings.values()],
    ...(advisories.size > 0 ? { advisories: [...advisories] } : {}),
  };
}

/** Blocked is visible evidence, but does not satisfy source completion. */
export function isComplete(
  record: FindingsRecord,
  configured: readonly ReviewSource['kind'][],
): boolean {
  return configured.every((kind) =>
    record.sources.some(
      (source) =>
        source.kind === kind &&
        source.status === 'terminal' &&
        (!source.coverage ||
          (ReviewCoverageSchema.safeParse(source.coverage).success &&
            source.coverage.head === record.head &&
            ('version' in source.coverage
              ? isCoverageV2Complete(source.coverage)
              : source.coverage.partitions.every((part) => part.complete)) &&
            (!record.reviewed ||
              (source.coverage.base === record.reviewed.base &&
                source.coverage.scope === record.reviewed.scope)))),
    ),
  );
}

export function openBlocking(
  record: Pick<FindingsRecord, 'findings'>,
  severities: readonly string[] = ['critical', 'major'],
): Finding[] {
  const blocking = new Set(severities.map((severity) => severity.toLowerCase()));
  return record.findings.filter(
    (finding) =>
      (finding.status === 'open' || finding.status === 'deferred') &&
      blocking.has(finding.severity.toLowerCase()),
  );
}
