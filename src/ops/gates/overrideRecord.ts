// D11 override-label record (W1.9, ADR-0004 D-G.4): whether a `cq-override`
// label on a PR is a valid owner override of a needs-human policy verdict.
//
// WHY SO STRICT: the label is the one human signal that can turn needs-human
// into pass, so everything about it is judged from API-reported facts, never
// from anything the head authors. The CURRENT application must have been made
// by the repository owner's own user account (id match, `type: 'User'`), not
// through a GitHub App (an App-token label — our own automation's included —
// is `performed_via_github_app` non-null: the A14 regression), and strictly
// AFTER our first durable observation of the exact head being judged. That
// epoch is the RS-3/W1.2 settle-ledger observation on `cq-state`, never a
// commit timestamp (author-supplied and trivially spoofed), so a label
// applied before a later push cannot bless the new code.
//
// DORMANT UNTIL C3: a valid record is only HONOURED once the ADR-0004 D-H.3
// C3 attestation (`policy/attestations/c3.json`) is on the trust ref. Until
// then it is logged as `dormant` with every field checked, so the record is
// auditable before it has any effect. The APPROVED-review record form is
// W1.10's.
//
// FAIL-CLOSED AND PURE: a malformed current application is `invalid`; nothing
// here throws, performs I/O, or reads an ambient clock.
import { z } from 'zod';
import type { SettleState } from '../../selfhost/settle-state.js';

/** The label whose current application is the override record. */
export const OVERRIDE_LABEL = 'cq-override';

/** The trust-ref file whose presence activates honoured overrides (ADR-0004 D-H.3). */
export const C3_ATTESTATION_PATH = 'policy/attestations/c3.json';

/** The fields of the current label application that the evaluation checked. */
export interface OverrideEvent {
  actorLogin: string;
  actorId: number;
  actorType: string;
  /** The App slug the label was applied through, or null for a direct user action. */
  viaApp: string | null;
  createdAt: string;
}

/** The override record's verdict, reasons for any failure, and the event judged. */
export interface OverrideEvaluation {
  status: 'absent' | 'invalid' | 'dormant' | 'honoured';
  reasons: string[];
  event?: OverrideEvent;
}

/** Canonical second-precision ISO 8601 UTC, as the GitHub REST API emits it. */
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** True when `value` is canonical and names a real instant (rejects `02-30`). */
const isCanonicalUtc = (value: string): boolean => {
  if (!CANONICAL_UTC.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value.replace('Z', '.000Z');
};

/**
 * The C3 attestation file (ADR-0004 D-H.3 C3): the one switch that lets an
 * override record turn needs-human into pass, so presence alone never arms
 * it. Only this exact shape does; a stray, empty or placeholder file stays
 * dormant.
 */
const C3AttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    attests: z.literal('C3'),
    attestedAt: z.string().refine(isCanonicalUtc, 'attestedAt is not canonical ISO 8601 UTC'),
    note: z.string().exactOptional(),
  })
  .strict();

/** Whether attestation text arms D-G.4 records; `reason` says why not. */
export function parseC3Attestation(
  text: string,
): { armed: true } | { armed: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { armed: false, reason: 'not valid JSON' };
  }
  const parsed = C3AttestationSchema.safeParse(data);
  if (parsed.success) return { armed: true };
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { armed: false, reason: `schema violation — ${issues}` };
}

/**
 * The shape the current application must have. Unknown extra keys (the API
 * returns many) are ignored; a MISSING `performed_via_github_app` is
 * malformed, not "no App", so an absent field can never read as a user action.
 */
const LabelEventSchema = z.object({
  actor: z.object({
    login: z.string(),
    id: z.number().int().positive(),
    type: z.string(),
  }),
  created_at: z.string().refine(isCanonicalUtc, 'created_at is not canonical ISO 8601 UTC'),
  performed_via_github_app: z.union([z.null(), z.object({ slug: z.string() })]),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `'labeled'`/`'unlabeled'` for a cq-override label event, else undefined. */
const overrideAction = (value: unknown): 'labeled' | 'unlabeled' | undefined => {
  if (!isObject(value)) return undefined;
  const { event, label } = value;
  if (event !== 'labeled' && event !== 'unlabeled') return undefined;
  if (!isObject(label) || label['name'] !== OVERRIDE_LABEL) return undefined;
  return event;
};

/** Log-safe rendering of an API string: printable ASCII only, capped. */
function clean(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > 100 ? `${printable.slice(0, 100)}…` : printable;
}

/**
 * The head observation epoch for `subject` on PR `pr`: the first observation
 * of the settle-ledger record whose tuple head is exactly `subject`, or
 * undefined when the ledger has no such record (the label is then invalid).
 */
export function headObservationEpoch(
  settle: SettleState,
  pr: number,
  subject: string,
): string | undefined {
  const key = String(pr);
  if (!Object.hasOwn(settle.prs, key)) return undefined;
  const record = settle.prs[key];
  if (record === undefined || record.tuple.head !== subject) return undefined;
  return record.observations[0]?.observedAt;
}

/**
 * Evaluate the current `cq-override` application from GitHub issue timeline /
 * issue-events API objects, in API (chronological) order. The current
 * application is the last `labeled` event with no later `unlabeled`; none is
 * `absent`. Every failing check adds a reason and makes the record `invalid`;
 * a record passing all checks is `honoured` when `attested`, else `dormant`.
 */
export function evaluateOverrideLabel(input: {
  events: readonly unknown[];
  ownerId: number;
  subject: string;
  headObservedAt: string | undefined;
  attested: boolean;
}): OverrideEvaluation {
  let current: unknown;
  for (const raw of input.events) {
    const action = overrideAction(raw);
    if (action === 'labeled') current = raw;
    else if (action === 'unlabeled') current = undefined;
  }
  if (current === undefined) return { status: 'absent', reasons: [] };

  const parsed = LabelEventSchema.safeParse(current);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(event)'}: ${issue.message}`,
    );
    return {
      status: 'invalid',
      reasons: [`malformed ${OVERRIDE_LABEL} labeled event (${issues.join('; ')})`],
    };
  }

  const { actor, created_at: createdAt, performed_via_github_app: app } = parsed.data;
  const event: OverrideEvent = {
    actorLogin: actor.login,
    actorId: actor.id,
    actorType: actor.type,
    viaApp: app === null ? null : app.slug,
    createdAt,
  };

  const reasons: string[] = [];
  if (actor.id !== input.ownerId) {
    reasons.push(`actor id ${actor.id} is not the repository owner id ${input.ownerId}`);
  }
  if (actor.type !== 'User') {
    reasons.push(`actor type '${clean(actor.type)}' is not 'User'`);
  }
  if (app !== null) {
    reasons.push(`label applied via GitHub App '${clean(app.slug)}', not directly by the owner`);
  }
  if (input.headObservedAt === undefined) {
    reasons.push(`no durable head observation for ${clean(input.subject)}`);
  } else {
    const epochMs = Date.parse(input.headObservedAt);
    if (!Number.isFinite(epochMs)) {
      reasons.push(`head observation epoch '${clean(input.headObservedAt)}' is not a timestamp`);
    } else if (!(Date.parse(createdAt) > epochMs)) {
      reasons.push(
        `label created_at ${createdAt} is not after the head observation epoch ${clean(input.headObservedAt)}`,
      );
    }
  }

  if (reasons.length > 0) return { status: 'invalid', reasons, event };
  return { status: input.attested ? 'honoured' : 'dormant', reasons, event };
}

/** Run-report lines for the override record; always emitted, whatever the status. */
export function formatOverride(e: OverrideEvaluation): string[] {
  if (e.status === 'absent') return [`override: absent (no ${OVERRIDE_LABEL} label)`];
  const lines = [`override: ${OVERRIDE_LABEL} label present`];
  if (e.event !== undefined) {
    lines.push(
      `  actor.login: ${clean(e.event.actorLogin)}`,
      `  actor.id: ${e.event.actorId}`,
      `  actor.type: ${clean(e.event.actorType)}`,
      `  via-app: ${e.event.viaApp === null ? 'none' : clean(e.event.viaApp)}`,
      `  created_at: ${e.event.createdAt}`,
    );
  }
  lines.push(`  verdict: ${e.status}`);
  for (const reason of e.reasons) lines.push(`  reason: ${reason}`);
  if (e.status === 'dormant') {
    lines.push(
      `  dormant: ADR-0004 D-G.4 records are honoured only once the C3 attestation (${C3_ATTESTATION_PATH}) is on the trust ref`,
    );
  }
  return lines;
}
