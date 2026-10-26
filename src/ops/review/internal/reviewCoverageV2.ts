import { z } from 'zod';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Count = z.number().int().nonnegative();
const DeliverySchema = z
  .object({ component: z.string().min(1), start: Count, end: Count, sha256: Hash })
  .strict();

/**
 * Engine evidence, never model attestation. Each original scan component stays
 * visible even when excluded or never sent. Split partitions record their
 * original UTF-16 ranges on sessions, so completion cannot hide a missing slice.
 * Repeated wire attempts/repair inside one session record each range only once.
 * There are no retries across sessions in v2: failed deliveries remain evidence.
 */
export const ReviewCoverageV2Schema = z
  .object({
    version: z.literal(2),
    head: z.string(),
    base: z.string(),
    scope: z.enum(['full', 'uncommitted']),
    mode: z.enum(['session', 'partitioned']),
    modeReason: z.string().min(1),
    pieces: z.array(
      z
        .object({
          component: z.string().min(1),
          path: z.string(),
          sha256: Hash,
          chars: Count,
          bytes: Count,
          state: z.enum(['planned', 'delivered', 'completed', 'excluded']),
          sessionId: z.string().min(1).optional(),
          exclusion: z
            .object({
              rule: z.string().min(1),
              assuredBy: z.string().min(1).optional(),
              limitation: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    sessions: z.array(
      z
        .object({
          id: z.string().min(1),
          /** complete also requires schema-valid final output in the producer. */
          status: z.enum(['complete', 'budget', 'error', 'aborted']),
          usage: z
            .object({
              input: Count,
              output: Count,
              cacheRead: Count,
              cacheWrite: Count,
              reasoning: Count.optional(),
            })
            .strict(),
          steps: Count.optional(),
          /** Actual driver transcript ID, for tool-result/truncation audit evidence. */
          driverSessionId: z.string().min(1).optional(),
          /** Recoverable tool denials are visible evidence, not a completeness input. */
          denials: Count.optional(),
          /** Host capability evidence only; missing search never changes coverage completeness. */
          capabilities: z
            .object({
              rg: z
                .object({
                  available: z.boolean(),
                  version: z.string().min(1).optional(),
                  found: z.string().min(1).optional(),
                  minimum: z.string().min(1),
                  probe: z.enum(['ok', 'absent', 'old']),
                })
                .strict()
                .optional(),
            })
            .strict()
            .optional(),
          deliveries: z.array(DeliverySchema),
          /** Clean model-send hooks; refused scans and tool-output guards are not sends. */
          requests: z.array(z.object({ serializedChars: Count, decodedChars: Count }).strict()),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((coverage, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    const pieces = new Map(coverage.pieces.map((piece) => [piece.component, piece]));
    if (pieces.size !== coverage.pieces.length || pieces.size === 0)
      invalid('review coverage needs unique original components');
    if (new Set(coverage.sessions.map((session) => session.id)).size !== coverage.sessions.length)
      invalid('review coverage session ids must be unique');
    const byComponent = new Map<
      string,
      { delivery: z.infer<typeof DeliverySchema>; session: (typeof coverage.sessions)[number] }[]
    >();
    for (const session of coverage.sessions) {
      if (session.status === 'complete' && session.deliveries.length === 0)
        invalid('a complete review session must deliver content');
      if (session.deliveries.length > 0 && session.requests.length === 0)
        invalid('review delivery needs a scanned request');
      for (const delivery of session.deliveries) {
        const piece = pieces.get(delivery.component);
        if (
          !piece ||
          delivery.start > delivery.end ||
          delivery.end > piece.chars ||
          (piece.chars > 0 && delivery.start === delivery.end)
        ) {
          invalid('invalid review delivery range');
          continue;
        }
        // A split-range hash is engine audit data; without the original bytes
        // the schema can check its format, but cannot reconstruct its content.
        if (
          delivery.start === 0 &&
          delivery.end === piece.chars &&
          delivery.sha256 !== piece.sha256
        )
          invalid('whole-component delivery hash does not match its plan');
        const rows = byComponent.get(delivery.component) ?? [];
        rows.push({ delivery, session });
        byComponent.set(delivery.component, rows);
      }
    }
    for (const piece of coverage.pieces) {
      if (
        piece.chars === 0 &&
        (piece.bytes !== 0 ||
          piece.sha256 !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
      )
        invalid('empty component must have the empty-content identity');
      const rows = (byComponent.get(piece.component) ?? []).sort(
        (a, b) => a.delivery.start - b.delivery.start,
      );
      let end = 0;
      let contiguous = true;
      for (const [index, { delivery }] of rows.entries()) {
        if (delivery.start < end || (index > 0 && piece.chars === 0))
          invalid('review deliveries overlap or repeat');
        if (delivery.start !== end) contiguous = false;
        end = delivery.end;
      }
      const sessionIds = [...new Set(rows.map(({ session }) => session.id))];
      const expectedSession = sessionIds.length === 1 ? sessionIds[0] : undefined;
      if (piece.sessionId !== expectedSession)
        invalid('piece sessionId must reflect its delivering sessions');
      if (piece.state === 'excluded') {
        if (rows.length > 0 || !piece.exclusion)
          invalid('excluded component must have an exclusion and no deliveries');
        if (!piece.exclusion?.assuredBy && !piece.exclusion?.limitation)
          invalid('unassured exclusion must state its limitation');
      } else {
        if (piece.exclusion) invalid('only excluded components may have exclusions');
        if ((piece.state === 'planned') !== (rows.length === 0))
          invalid('planned components have no deliveries; delivered components need evidence');
        if (
          piece.state === 'completed' &&
          (!contiguous ||
            end !== piece.chars ||
            rows.some(({ session }) => session.status !== 'complete'))
        )
          invalid('completed component needs complete, contiguous session coverage');
      }
    }
  });

export type ReviewCoverageV2 = z.infer<typeof ReviewCoverageV2Schema>;

/** Validate settled evidence before admitting a review as complete. */
export function isCoverageV2Complete(coverage: ReviewCoverageV2): boolean {
  return (
    ReviewCoverageV2Schema.safeParse(coverage).success &&
    coverage.pieces.every((piece) => piece.state === 'completed' || piece.state === 'excluded') &&
    coverage.sessions.every((session) => session.status === 'complete')
  );
}
