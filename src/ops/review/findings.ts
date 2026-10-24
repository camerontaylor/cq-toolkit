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
      else
        findings.set(id, {
          ...previous,
          source: [...new Set(`${previous.source},${finding.source}`.split(','))].join(','),
        });
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
