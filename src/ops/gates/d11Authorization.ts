// D11 authorization (ADR-0004 D-C.3, D-G.4; docs/d11-decisive-authorization.md):
// whether the owner's D11 records authorize the changes a push subject's
// `main..subject` range makes. The ONE predicate the promotion gate's policy
// pass and the ratchet verifier share.
//
// ATTRIBUTION BY MERGE STEP: each admitted first-parent merge M contributes
// `diff(M^1, M)`. The gate has proved every such merge clean, so that diff is
// exactly what the PR brought into the queue, and the step diffs together
// cover the range. A path is authorized iff some admitted contribution
// changes it and EVERY contribution that changes it carries an honoured
// record — one label never authorizes another PR's change.
//
// PURE AND FAIL-CLOSED: callers read the label events, the attestation at
// the trust ref and the settle-ledger epoch, and pass them in as data.
// Nothing here throws or performs I/O; every doubt leaves a path
// unauthorized, and a record is honoured only when the C3 attestation parsed.
import {
  C3_ATTESTATION_PATH,
  evaluateOverrideLabel,
  formatOverride,
  parseC3Attestation,
  type OverrideEvaluation,
} from './overrideRecord.js';

/** The C3 attestation as read at the TRUST ref (never the head or tip). */
export type C3AttestationRead =
  | { state: 'absent' }
  | { state: 'present'; text: string }
  | { state: 'unreadable'; reason: string };

/** What the caller read for one admitted PR. */
export interface D11PrEvidence {
  pr: number;
  /** The PR's first-parent merge commit M. */
  merge: string;
  /** The merged head (M's second parent): the head the record must bind to. */
  head: string;
  /** Paths `diff(M^1, M)` changes: the PR's contribution to the range. */
  paths: readonly string[];
  /** Timeline label events in API order, or why they could not be read. */
  events: readonly unknown[] | { unreadable: string };
  /** The durable head-observation epoch for (pr, head), if the ledger has one. */
  headObservedAt: string | undefined;
}

/** One admitted PR's contribution and its evaluated record. */
export interface D11Contribution {
  pr: number;
  merge: string;
  head: string;
  paths: ReadonlySet<string>;
  record: OverrideEvaluation;
}

/** The bound authorization: the attestation state and every contribution. */
export interface D11Authorization {
  attested: boolean;
  contributions: readonly D11Contribution[];
  /** Run-report lines: the attestation and every record, whatever its status. */
  report: string[];
}

/** One path no record authorizes, and why. */
export interface D11Unauthorized {
  path: string;
  why: string;
}

export interface D11Decision {
  authorized: boolean;
  unauthorized: D11Unauthorized[];
  lines: string[];
}

/** Bind the evidence into the authorization object. Never throws. */
export function bindD11Authorization(input: {
  ownerId: number | null;
  attestation: C3AttestationRead;
  prs: readonly D11PrEvidence[];
}): D11Authorization {
  const report: string[] = [];
  let attested = false;
  if (input.attestation.state === 'absent') {
    report.push(`attestation: ${C3_ATTESTATION_PATH} absent at the trust ref — records dormant`);
  } else if (input.attestation.state === 'unreadable') {
    report.push(
      `attestation: ${C3_ATTESTATION_PATH} unreadable at the trust ref (${input.attestation.reason}) — records dormant`,
    );
  } else {
    const check = parseC3Attestation(input.attestation.text);
    attested = check.armed;
    report.push(
      check.armed
        ? `attestation: ${C3_ATTESTATION_PATH} valid at the trust ref — records honoured`
        : `attestation: ${C3_ATTESTATION_PATH} present but invalid (${check.reason}) — records dormant`,
    );
  }

  const count = (key: (e: D11PrEvidence) => string): Map<string, number> => {
    const seen = new Map<string, number>();
    for (const e of input.prs) seen.set(key(e), (seen.get(key(e)) ?? 0) + 1);
    return seen;
  };
  const merges = count((e) => e.merge);
  const numbers = count((e) => String(e.pr));

  const contributions = input.prs.map((e): D11Contribution => {
    let record: OverrideEvaluation;
    if ((merges.get(e.merge) ?? 0) > 1 || (numbers.get(String(e.pr)) ?? 0) > 1) {
      record = {
        status: 'invalid',
        reasons: [`ambiguous: PR #${String(e.pr)} / merge ${e.merge} is claimed more than once`],
      };
    } else if (input.ownerId === null) {
      record = { status: 'invalid', reasons: ['repository owner id unreadable'] };
    } else if ('unreadable' in e.events) {
      record = { status: 'invalid', reasons: [`label events unreadable: ${e.events.unreadable}`] };
    } else {
      record = evaluateOverrideLabel({
        events: e.events,
        ownerId: input.ownerId,
        subject: e.head,
        headObservedAt: e.headObservedAt,
        attested,
      });
    }
    report.push(`override PR #${String(e.pr)} (merge ${e.merge}, head ${e.head}):`);
    for (const line of formatOverride(record)) report.push(`  ${line}`);
    return { pr: e.pr, merge: e.merge, head: e.head, paths: new Set(e.paths), record };
  });
  return { attested, contributions, report };
}

/**
 * Whether `auth` authorizes every one of `paths`. A path is authorized iff
 * some contribution changes it and every contribution changing it carries an
 * honoured record. An empty path list is authorized (nothing needs a human).
 */
export function authorizePaths(auth: D11Authorization, paths: readonly string[]): D11Decision {
  const unauthorized: D11Unauthorized[] = [];
  const lines: string[] = [];
  for (const path of new Set(paths)) {
    const touching = auth.contributions.filter((c) => c.paths.has(path));
    if (touching.length === 0) {
      unauthorized.push({ path, why: 'not contributed by any admitted PR in the closure' });
      continue;
    }
    const failing = touching.filter((c) => c.record.status !== 'honoured');
    for (const c of failing) {
      unauthorized.push({
        path,
        why: `PR #${String(c.pr)} (merge ${c.merge}) changes it and its D11 record is ${c.record.status}`,
      });
    }
    if (failing.length === 0) {
      lines.push(
        `d11: ${path} authorized by ${touching.map((c) => `PR #${String(c.pr)}`).join(', ')}`,
      );
    }
  }
  for (const u of unauthorized) lines.push(`d11: ${u.path} unauthorized — ${u.why}`);
  return { authorized: unauthorized.length === 0, unauthorized, lines };
}
