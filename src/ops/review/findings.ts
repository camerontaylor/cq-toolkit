import { z } from 'zod';
import { ReviewCoverageSchema } from './internal/reviewPartitions.js';
import { isCoverageV2Complete } from './internal/reviewCoverageV2.js';
import { FindingFingerprintSchema } from '../../kernel/schema.js';
import type { AvailabilityRecord } from '../../kernel/types.js';

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

const ObservedShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/**
 * Normalized finding shared by local and forge review producers. The
 * disposition fields are ADR-0008 findings-record v2 additions: OPTIONAL on
 * the type because a legacy v1 record cannot prove them (unknown is never
 * fabricated), REQUIRED by the record refinement below on every v2 terminal
 * disposition. `evidence` is one legacy string in v1 and a string array in
 * v2; the record refinement enforces which belongs to which version.
 */
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
    evidence: z.union([z.string(), z.array(z.string())]).optional(),
    /**
     * Optional versioned evidence payload. Legacy records (including every
     * CodeRabbit-shaped finding) lack it and stay valid unchanged; the record
     * envelope's `schemaVersion` therefore remains 1. The payload versions
     * itself under its own `version` literal so later evidence schemas can
     * add a sibling field without breaking any reader of this one.
     */
    evidenceV1: FindingEvidenceV1Schema.optional(),
    /** F1 shared identity; absent on legacy records, never guessed. */
    fingerprint: FindingFingerprintSchema.optional(),
    /** Who made the terminal adjudication (v2). */
    owner: z.string().min(1).optional(),
    /** Re-review trigger; nonempty when the v2 disposition is deferred. */
    reviewTrigger: z.string().min(1).nullable().optional(),
    /** Head the adjudicator observed (v2). */
    observedHead: ObservedShaSchema.optional(),
    /** UTC ISO-8601 with milliseconds (v2). */
    observedAt: z.iso.datetime({ precision: 3 }).optional(),
    /** Explicitly accepted risk, or null when unknown (v2). */
    acceptedRisk: z.string().nullable().optional(),
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

/**
 * ADR-0008 findings-record migration: v1 is unchanged; v2 adds the complete
 * disposition provenance. A legacy v1 record may not carry v2 fields (an old
 * reader must reject v2 explicitly), and a v2 terminal disposition is
 * complete or it is not a disposition. Open v2 findings may still lack
 * adjudication fields: nothing has been adjudicated yet.
 */
const V2_DISPOSITION_FIELDS = [
  'fingerprint',
  'owner',
  'reviewTrigger',
  'observedHead',
  'observedAt',
  'acceptedRisk',
] as const;

function validateFindingVersions(
  record: { schemaVersion: 1 | 2; findings: Finding[] },
  ctx: z.RefinementCtx,
): void {
  record.findings.forEach((finding, index) => {
    const at = ['findings', index] as const;
    if (record.schemaVersion === 1) {
      if (Array.isArray(finding.evidence))
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'evidence'],
          message: 'a v1 finding stores evidence as one string; an array requires schemaVersion 2',
        });
      for (const field of V2_DISPOSITION_FIELDS)
        if (finding[field] !== undefined)
          ctx.addIssue({
            code: 'custom',
            path: [...at, field],
            message: `a v1 finding cannot carry the v2 disposition field '${field}'`,
          });
      return;
    }
    if (finding.evidence !== undefined && !Array.isArray(finding.evidence))
      ctx.addIssue({
        code: 'custom',
        path: [...at, 'evidence'],
        message: 'a v2 finding stores evidence as a string array',
      });
    if (finding.status === 'open') return;
    for (const field of V2_DISPOSITION_FIELDS)
      if (finding[field] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [...at, field],
          message: `a v2 terminal disposition requires '${field}' (null when unknown, never omitted)`,
        });
    if (finding.evidence === undefined)
      ctx.addIssue({
        code: 'custom',
        path: [...at, 'evidence'],
        message: 'a v2 terminal disposition requires its evidence array',
      });
    if (finding.reason === undefined || finding.reason.trim() === '')
      ctx.addIssue({
        code: 'custom',
        path: [...at, 'reason'],
        message: 'a v2 terminal disposition requires a nonempty reason',
      });
    if (finding.status === 'deferred' && !finding.reviewTrigger)
      ctx.addIssue({
        code: 'custom',
        path: [...at, 'reviewTrigger'],
        message: 'a deferred disposition requires a nonempty reviewTrigger',
      });
  });
}

export const FindingsRecordSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
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
  .strict()
  .superRefine(validateFindingVersions);
export type FindingsRecord = z.infer<typeof FindingsRecordSchema>;

/**
 * Legacy carrier projection for review carriers that still store ONE evidence
 * string (the dev cycle record). A v2 array is JSON-encoded rather than
 * dropped; an absent value stays absent.
 */
export function legacyEvidenceText(finding: Pick<Finding, 'evidence'>): string | undefined {
  return Array.isArray(finding.evidence) ? JSON.stringify(finding.evidence) : finding.evidence;
}

/**
 * ADR-0008 findings-record dual-read adapter (T19): the ONE place a finding's
 * stored disposition is adapted to its v2 read shape, for every reader.
 *
 * - a legacy v1 evidence string becomes a one-element array (never a JSON
 *   re-encode that a reader would have to parse);
 * - absent or whitespace-only evidence is null, never [] (unknown is not an
 *   empty proof);
 * - missing `fingerprint` and the new provenance fields are null, with an
 *   availability entry explaining the absence. Nothing is fabricated and no
 *   legacy identity is guessed.
 *
 * Producers write v2 directly; only readers adapt. The availability pointers
 * are relative to a disposition payload, so a producer that derives its own
 * values (address builds the fingerprint and observed head itself) keeps its
 * own producer-specific availability.
 */
export interface FindingDispositionView {
  status: Finding['status'];
  reason: string | null;
  evidence: string[] | null;
  fingerprint: Finding['fingerprint'] | null;
  owner: string | null;
  reviewTrigger: string | null;
  observedHead: string | null;
  observedAt: string | null;
  acceptedRisk: string | null;
  availability: Record<string, AvailabilityRecord>;
}

export function findingDispositionView(finding: Finding): FindingDispositionView {
  const retained = finding.evidence;
  const evidence =
    retained === undefined || (typeof retained === 'string' && retained.trim() === '')
      ? null
      : Array.isArray(retained)
        ? retained
        : [retained];
  const availability: Record<string, AvailabilityRecord> = {};
  const unknown = (
    pointer: string,
    reason: string,
    state: AvailabilityRecord['state'] = 'unavailable',
  ) => {
    availability[pointer] = { state, reason, source: null };
  };
  if (evidence === null)
    unknown(
      '/evidence',
      'no evidence was recorded; absence is unknown, never an empty proof',
      'not-collected',
    );
  if (finding.fingerprint === undefined)
    unknown('/fingerprint', 'no F1 identity recorded; a legacy identity is never guessed');
  if (finding.owner === undefined)
    unknown('/owner', 'no owner recorded; the adjudicating authority is unknown');
  if (finding.observedHead === undefined)
    unknown('/observedHead', 'no observed head recorded; the disposition is tied to no head');
  if (finding.observedAt === undefined)
    unknown('/observedAt', 'no observed-at timestamp recorded; the adjudication time is unknown');
  if (finding.acceptedRisk === undefined)
    unknown(
      '/acceptedRisk',
      'the adjudicator recorded no accepted risk (null is unknown, never none)',
      'not-collected',
    );
  if (finding.status !== 'deferred')
    unknown(
      '/reviewTrigger',
      'the disposition is not deferred, so no re-review trigger applies',
      'n-a',
    );
  else if (finding.reviewTrigger === undefined || finding.reviewTrigger === null)
    unknown(
      '/reviewTrigger',
      'a deferred disposition recorded no re-review trigger; re-review timing is unknown',
    );
  return {
    status: finding.status,
    reason: finding.reason ?? null,
    evidence,
    fingerprint: finding.fingerprint ?? null,
    owner: finding.owner ?? null,
    reviewTrigger: finding.reviewTrigger ?? null,
    observedHead: finding.observedHead ?? null,
    observedAt: finding.observedAt ?? null,
    acceptedRisk: finding.acceptedRisk ?? null,
    availability,
  };
}

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
    // This legacy projection only knows the v1 finding shape. Merging a v2
    // record here would silently drop its disposition provenance; the
    // versioned merger is T09's.
    if (record.schemaVersion !== 1)
      throw new Error(
        `findings.merge: schemaVersion ${String(record.schemaVersion)} records require the versioned merger`,
      );
    if (record.branch !== first.branch || record.head !== first.head)
      throw new Error('findings records must describe the same branch and head');
    for (const source of record.sources) {
      const sourceKey = `${source.kind}\0${source.cycleId ?? ''}`;
      const previous = sources.get(sourceKey);
      // A completion cannot overwrite a failed observation of the same cycle.
      if (previous?.status !== 'blocked') sources.set(sourceKey, source);
    }
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
