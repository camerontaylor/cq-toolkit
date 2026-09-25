// selfhost/settle-state — the PURE settle ledger (task W1.2 slice A, the
// RS-3 decision): how long a PR's exact code has sat still, measured from
// OUR OWN durable observations instead of anything the PR author controls.
//
// WHY NOT COMMIT TIMESTAMPS: committer/author dates are author-supplied and
// trivially spoofed (`GIT_COMMITTER_DATE`), and GitHub exposes no push
// timestamp. So settle is measured from observations our automation makes
// of a TUPLE `(head SHA, base SHA, force-push epoch)` and persists durably
// (state-branch.ts owns the persistence; this module owns only the rules).
//
// THE RULE: a PR is settled iff two observations of the IDENTICAL tuple
// exist spaced >= settleMs apart — the second being the pre-merge recheck
// the caller appends immediately before asking. ANY new tuple (head change,
// base change, or a force-push epoch bump — e.g. force-push away and back
// to the same head SHA) invalidates every prior observation: the record is
// REPLACED, never merged.
//
// FAIL-CLOSED: every judgment here can only DELAY a merge. A malformed or
// foreign persisted record is DROPPED (resetting settle — never granting
// it); an observation stamped later than the caller's clock is a skewed or
// tampered fact and refuses settle outright. Parsing never throws — a
// corrupt ledger degrades to "no observations yet".
//
// PURE: no I/O, no ambient clock — every `nowMs` is injected by the caller,
// and no function mutates its input (each returns a fresh state).

/** The on-disk schema version; any other version is discarded wholesale. */
export const SETTLE_STATE_VERSION = 1;

/**
 * Per-PR observation cap. Compaction keeps the FIRST observation (it
 * anchors settle) plus the newest ones, so the bound never moves the
 * settle anchor forward and never loses the latest recheck.
 */
export const MAX_OBSERVATIONS_PER_PR = 8;

/** The identity of "the code that would merge" at one observation. */
export interface SettleTuple {
  /** PR head commit SHA — 40 lowercase hex characters. */
  head: string;
  /** Base branch tip SHA — 40 lowercase hex characters. */
  base: string;
  /**
   * Force-push epoch — a non-negative safe integer bumped by the caller on
   * every observed force-push, so a force-push away and back to the SAME
   * head SHA still reads as a new tuple.
   */
  forcePushEpoch: number;
}

/** One durable observation of a tuple by our automation. */
export interface SettleObservation {
  /** When the observation was made — canonical ISO 8601 (`toISOString`). */
  observedAt: string;
  /** Stable short label of the observer, e.g. `'self-merge-prs:recheck'`. */
  by: string;
}

/** One PR's ledger entry: the current tuple and its observations (oldest first). */
export interface SettleRecord {
  /** The tuple every observation in this record saw. */
  tuple: SettleTuple;
  /** Observations of `tuple`, oldest first; index 0 anchors settle. */
  observations: SettleObservation[];
}

/** The whole persisted ledger for one repository. */
export interface SettleState {
  /** Schema version — always SETTLE_STATE_VERSION. */
  version: 1;
  /** `owner/name` the ledger belongs to; a mismatch discards the ledger. */
  repo: string;
  /** Records keyed by decimal PR number (`"42"`). */
  prs: Record<string, SettleRecord>;
}

/** Why a tuple is not (yet) settled. */
export type SettleNotSettledReason =
  | 'no_observation'
  | 'tuple_changed'
  | 'single_observation'
  | 'settle_pending'
  | 'observation_in_future';

/** settleStatus's verdict. */
export type SettleVerdict =
  | { settled: true; firstObservedAt: string; elapsedMs: number }
  | { settled: false; reason: SettleNotSettledReason };

// -- validation helpers -------------------------------------------------------

const SHA_RE = /^[0-9a-f]{40}$/;
const PR_KEY_RE = /^[1-9][0-9]*$/;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const isRecord = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Log-safe rendering of a wire value (JSON, or `undefined`), capped. */
const show = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value).slice(0, 80);

const isEpoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Canonical-ISO timestamp → epoch ms, or NaN when not canonical. */
const isoMs = (value: string): number => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return Number.NaN;
  return new Date(ms).toISOString() === value ? ms : Number.NaN;
};

const tupleProblem = (tuple: SettleTuple): string | null => {
  if (!SHA_RE.test(tuple.head)) return 'head is not a 40-hex lowercase sha';
  if (!SHA_RE.test(tuple.base)) return 'base is not a 40-hex lowercase sha';
  if (!isEpoch(tuple.forcePushEpoch)) return 'forcePushEpoch is not a non-negative safe integer';
  return null;
};

const copyRecord = (record: SettleRecord): SettleRecord => ({
  tuple: { ...record.tuple },
  observations: record.observations.map((o) => ({ ...o })),
});

// -- API ------------------------------------------------------------------

/** A fresh ledger for `repo` (`owner/name`) with no records. */
export function emptySettleState(repo: string): SettleState {
  return { version: SETTLE_STATE_VERSION, repo, prs: {} };
}

/** True iff the two tuples name the identical head, base, and force-push epoch. */
export function sameTuple(a: SettleTuple, b: SettleTuple): boolean {
  return a.head === b.head && a.base === b.base && a.forcePushEpoch === b.forcePushEpoch;
}

/**
 * Validate one raw per-PR record. Returns the typed record or the reason it
 * is dropped (drop = settle reset, never a grant).
 */
const parseRecord = (raw: unknown): SettleRecord | string => {
  if (!isRecord(raw)) return 'record is not an object';
  const rec = asRecord(raw);
  if (!isRecord(rec['tuple'])) return 'tuple is not an object';
  const rawTuple = asRecord(rec['tuple']);
  const epoch = rawTuple['forcePushEpoch'];
  if (!isEpoch(epoch)) return 'forcePushEpoch is not a non-negative safe integer';
  const tuple: SettleTuple = {
    head: asString(rawTuple['head']),
    base: asString(rawTuple['base']),
    forcePushEpoch: epoch,
  };
  const problem = tupleProblem(tuple);
  if (problem !== null) return problem;
  const rawObs = rec['observations'];
  if (!Array.isArray(rawObs)) return 'observations is not an array';
  if (rawObs.length === 0) return 'observations is empty';
  if (rawObs.length > MAX_OBSERVATIONS_PER_PR) {
    return `observations exceed the cap of ${String(MAX_OBSERVATIONS_PER_PR)}`;
  }
  const observations: SettleObservation[] = [];
  let previousMs = Number.NEGATIVE_INFINITY;
  for (const entry of rawObs as unknown[]) {
    const obs = asRecord(entry);
    const observedAt = asString(obs['observedAt']);
    const by = asString(obs['by']);
    const ms = isoMs(observedAt);
    if (Number.isNaN(ms)) return 'observation has an unparseable observedAt';
    if (by.trim() === '') return 'observation has an empty by';
    // Out-of-order stamps cannot be produced by observe() on a monotonic
    // clock; a ledger carrying them is edited or skewed → reset.
    if (ms < previousMs) return 'observations are not in chronological order';
    previousMs = ms;
    observations.push({ observedAt, by });
  }
  return { tuple, observations };
};

/**
 * Strictly validate a persisted ledger. A non-object, wrong version, repo
 * mismatch, or non-object `prs` yields an EMPTY state for `repo` with one
 * discarded reason; each malformed per-PR record (bad key, bad sha, bad
 * epoch, non-array/empty/over-cap observations, non-canonical or
 * out-of-order observedAt, empty `by`) is dropped individually with a
 * reason. Never throws. Dropping only ever resets settle — never grants it.
 */
export function parseSettleState(
  raw: unknown,
  repo: string,
): { state: SettleState; discarded: string[] } {
  const empty = (why: string) => ({ state: emptySettleState(repo), discarded: [why] });
  if (!isRecord(raw)) return empty('settle state is not a JSON object');
  const top = asRecord(raw);
  if (top['version'] !== SETTLE_STATE_VERSION) {
    return empty(
      `settle state version ${show(top['version'])} is not ${String(SETTLE_STATE_VERSION)}`,
    );
  }
  if (top['repo'] !== repo) {
    return empty(`settle state repo ${show(top['repo'])} does not match ${JSON.stringify(repo)}`);
  }
  if (!isRecord(top['prs'])) return empty('settle state prs is not an object');
  const state = emptySettleState(repo);
  const discarded: string[] = [];
  for (const [key, value] of Object.entries(asRecord(top['prs']))) {
    if (!PR_KEY_RE.test(key) || !Number.isSafeInteger(Number(key))) {
      discarded.push(`pr key ${JSON.stringify(key)} is not a decimal PR number`);
      continue;
    }
    const parsed = parseRecord(value);
    if (typeof parsed === 'string') {
      discarded.push(`pr ${key}: ${parsed}`);
      continue;
    }
    state.prs[key] = parsed;
  }
  return { state, discarded };
}

/** How one observation changed the ledger (observeWithChange's report). */
export type ObservationChange = 'created' | 'reset' | 'appended';

/**
 * Record one observation of `tuple` for `pr` at `nowMs`, returning a NEW
 * state (the input is never mutated) plus how the PR's record changed:
 * 'created' (no prior record), 'reset' (the prior record held a different
 * tuple and is REPLACED — every prior observation is invalidated), or
 * 'appended' (same tuple; the observation joins the record). Over
 * MAX_OBSERVATIONS_PER_PR, the first observation (the settle anchor) is
 * kept plus the newest ones. The change kind is what lets a caller skip
 * durable writes that carry no new anchor (every state-branch push costs
 * repo CI). THROWS on caller bugs: a non-positive PR number, a malformed
 * tuple, a non-finite clock, or an empty `by` — persisting such a record
 * would only be dropped on the next parse.
 */
export function observeWithChange(
  state: SettleState,
  pr: number,
  tuple: SettleTuple,
  nowMs: number,
  by: string,
): { state: SettleState; changed: ObservationChange } {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new RangeError(`settle-state observe: pr must be a positive integer — got ${String(pr)}`);
  }
  const problem = tupleProblem(tuple);
  if (problem !== null) throw new RangeError(`settle-state observe: ${problem}`);
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`settle-state observe: nowMs must be finite — got ${String(nowMs)}`);
  }
  if (by.trim() === '') throw new RangeError('settle-state observe: by must be non-empty');

  const key = String(pr);
  const observation: SettleObservation = { observedAt: new Date(nowMs).toISOString(), by };
  const prs: Record<string, SettleRecord> = {};
  for (const [k, record] of Object.entries(state.prs)) prs[k] = copyRecord(record);
  const prior = prs[key];
  let changed: ObservationChange;
  if (prior !== undefined && sameTuple(prior.tuple, tuple)) {
    const observations = [...prior.observations, observation];
    const [first] = observations;
    prs[key] = {
      tuple: { ...tuple },
      observations:
        observations.length > MAX_OBSERVATIONS_PER_PR && first !== undefined
          ? [first, ...observations.slice(-(MAX_OBSERVATIONS_PER_PR - 1))]
          : observations,
    };
    changed = 'appended';
  } else {
    prs[key] = { tuple: { ...tuple }, observations: [observation] };
    changed = prior === undefined ? 'created' : 'reset';
  }
  return { state: { version: state.version, repo: state.repo, prs }, changed };
}

/**
 * observeWithChange without the change report: the NEW state only. Same
 * rules, same throws.
 */
export function observe(
  state: SettleState,
  pr: number,
  tuple: SettleTuple,
  nowMs: number,
  by: string,
): SettleState {
  return observeWithChange(state, pr, tuple, nowMs, by).state;
}

/**
 * Is `tuple` settled per `record` at `nowMs`? Settled iff the record's
 * tuple equals `tuple`, it holds >= 2 observations, NO observation is later
 * than `nowMs` (or unparseable — a skewed/tampered fact fails closed as
 * `observation_in_future`), and (latest − first) observedAt >= `settleMs`.
 * The caller appends the pre-merge recheck BEFORE asking, so "latest" is
 * the recheck. THROWS on a negative or non-finite `settleMs` (a caller
 * bug that would otherwise grant settle instantly or never).
 */
export function settleStatus(
  record: SettleRecord | undefined,
  tuple: SettleTuple,
  nowMs: number,
  settleMs: number,
): SettleVerdict {
  if (!Number.isFinite(settleMs) || settleMs < 0) {
    throw new RangeError(
      `settle-state settleStatus: settleMs must be a non-negative finite number — got ${String(settleMs)}`,
    );
  }
  if (record === undefined || record.observations.length === 0) {
    return { settled: false, reason: 'no_observation' };
  }
  if (!sameTuple(record.tuple, tuple)) return { settled: false, reason: 'tuple_changed' };
  const stamps = record.observations.map((o) => Date.parse(o.observedAt));
  if (stamps.some((ms) => !Number.isFinite(ms) || ms > nowMs)) {
    return { settled: false, reason: 'observation_in_future' };
  }
  const [firstMs] = stamps;
  const latestMs = stamps[stamps.length - 1];
  const [first] = record.observations;
  if (stamps.length < 2 || firstMs === undefined || latestMs === undefined || first === undefined) {
    return { settled: false, reason: 'single_observation' };
  }
  const elapsedMs = latestMs - firstMs;
  if (elapsedMs < settleMs) return { settled: false, reason: 'settle_pending' };
  return { settled: true, firstObservedAt: first.observedAt, elapsedMs };
}

/**
 * Drop every record whose PR is not in `openPrs` (closed/merged PRs), so
 * the ledger stays bounded by the open-PR count. Returns a NEW state.
 */
export function pruneToOpen(state: SettleState, openPrs: ReadonlySet<number>): SettleState {
  const prs: Record<string, SettleRecord> = {};
  for (const [key, record] of Object.entries(state.prs)) {
    if (openPrs.has(Number(key))) prs[key] = copyRecord(record);
  }
  return { version: state.version, repo: state.repo, prs };
}

/**
 * Deterministic JSON: fixed field order, PR keys sorted numerically,
 * 2-space indent, trailing newline — identical states always serialize to
 * identical bytes (so a no-op write is a byte-identical tree).
 */
export function serializeSettleState(state: SettleState): string {
  const keys = Object.keys(state.prs).sort((a, b) => Number(a) - Number(b));
  // Built as an entry list so integer-like keys keep the numeric sort
  // (JS object key order already sorts them, but this keeps it explicit).
  const prs: Record<string, unknown> = {};
  for (const key of keys) {
    const record = state.prs[key];
    if (record === undefined) continue;
    prs[key] = {
      tuple: {
        head: record.tuple.head,
        base: record.tuple.base,
        forcePushEpoch: record.tuple.forcePushEpoch,
      },
      observations: record.observations.map((o) => ({ observedAt: o.observedAt, by: o.by })),
    };
  }
  return `${JSON.stringify({ version: state.version, repo: state.repo, prs }, null, 2)}\n`;
}
