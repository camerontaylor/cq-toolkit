import { z } from 'zod';

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
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;
export const ReviewSourceSchema = z
  .object({
    kind: z.enum(['coderabbit', 'agent', 'pr-threads']),
    status: z.enum(['terminal', 'blocked']),
    reason: z.string().optional(),
    cycleId: z.string().optional(),
  })
  .strict();
export type ReviewSource = z.infer<typeof ReviewSourceSchema>;
export const FindingsRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    branch: z.string(),
    head: z.string(),
    sources: z.array(ReviewSourceSchema),
    findings: z.array(FindingSchema),
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
  };
}

/** Merge source records deterministically, retaining the first id and unioning source labels. */
export function merge(records: readonly FindingsRecord[]): FindingsRecord {
  const first = records[0];
  if (first === undefined) throw new Error('findings.merge requires at least one record');
  const sources = new Map<string, ReviewSource>();
  const findings = new Map<string, Finding>();
  for (const record of records) {
    if (record.branch !== first.branch || record.head !== first.head)
      throw new Error('findings records must describe the same branch and head');
    for (const source of record.sources)
      sources.set(`${source.kind}\0${source.cycleId ?? ''}`, source);
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
    sources: [...sources.values()],
    findings: [...findings.values()],
  };
}

/** Blocked is visible evidence, but does not satisfy source completion. */
export function isComplete(
  record: FindingsRecord,
  configured: readonly ReviewSource['kind'][],
): boolean {
  return configured.every((kind) =>
    record.sources.some((source) => source.kind === kind && source.status === 'terminal'),
  );
}

export function openBlocking(
  record: FindingsRecord,
  severities: readonly string[] = ['critical', 'major'],
): Finding[] {
  const blocking = new Set(severities.map((severity) => severity.toLowerCase()));
  return record.findings.filter(
    (finding) => finding.status === 'open' && blocking.has(finding.severity.toLowerCase()),
  );
}
