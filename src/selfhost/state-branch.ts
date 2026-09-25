// selfhost/state-branch — the DURABLE settle-ledger store (task W1.2 slice
// A, the RS-3 decision): settle-state.ts's ledger persisted as ONE file
// (`.cq/settle-state.json`) on a dedicated git STATE BRANCH (`cq-state`),
// read and written through the GitHub git-data REST API over the gh CLI
// transport (gh.ts's GhFn seam).
//
// WHY A STATE BRANCH: settle observations must outlive any one workflow
// run. The Actions cache is EVICTABLE (an eviction would silently reset —
// or, worse, a poisoned entry could fabricate — settle) and PR content is
// author-controlled. A branch in the base repository is durable, audited
// (every write is a commit), and writable only by our automation's token.
// The branch IS the persistence: this module never touches the local
// filesystem (the workflow's `.selfhost/journal`, which DOES live in the
// Actions cache, plays no part in settle).
//
// CONSISTENT READS: the tip is read first, then the file is read PINNED TO
// THAT COMMIT (`contents?ref=<sha>`), so the returned state and the
// returned parentCommit always describe the same snapshot even if another
// writer moves the tip in between.
//
// COMPARE-AND-SWAP WRITES: a write builds a fresh one-file tree and a
// commit whose parent is the snapshot's parentCommit, then moves the ref
// with `force=false` (fast-forward only). A concurrent writer that moved
// the tip makes the PATCH fail (HTTP 422) and the write returns
// `{ ok: false }` — the caller re-reads and retries or refuses the merge.
// Bootstrap (no branch yet) creates a ROOT commit and the ref; a concurrent
// bootstrap loses with "Reference already exists". Never force-pushes,
// never deletes the branch.
//
// FAIL-CLOSED: a missing branch/file or an unparseable ledger reads as the
// EMPTY ledger (settle resets — never granted); any OTHER transport
// failure on read THROWS so the caller can refuse the merge with an honest
// reason instead of pretending the forge answered "no observations". A
// 404 from an inaccessible repository also reads as empty — harmless for
// settle, and the subsequent write fails loudly.
import { GhError, ghJson, ghNameOk } from '../ops/review/gh.js';
import type { GhFn } from '../ops/review/gh.js';
import { emptySettleState, parseSettleState, serializeSettleState } from './settle-state.js';
import type { SettleState } from './settle-state.js';

/** The dedicated state branch holding the settle ledger (and nothing else). */
export const STATE_BRANCH = 'cq-state';

/** The ledger's path on the state branch. */
export const SETTLE_STATE_PATH = '.cq/settle-state.json';

/** Cap for a one-line failure reason (candidates.ts's FETCH_REASON_MAX convention). */
const REASON_MAX = 500;

const SHA_RE = /^[0-9a-f]{40}$/;

/** The injected seams and repo coordinates. Plain data; no ambient access. */
export interface StateBranchDeps {
  /** The gh transport — every read and write goes through it. */
  gh: GhFn;
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
}

/** One consistent read of the state branch. */
export interface StateBranchSnapshot {
  /** The parsed ledger (empty when absent, missing, or discarded). */
  state: SettleState;
  /** The cq-state tip the state was read from; null when the branch does not exist yet. */
  parentCommit: string | null;
  /** Why (parts of) the persisted ledger were discarded — the audit trail. */
  discarded: string[];
}

/** A write's outcome — a forge refusal is a RESULT, never a throw. */
export type StateBranchWriteResult = { ok: true; commit: string } | { ok: false; reason: string };

// -- JSON-boundary helpers (structural casts, the e2e tests' pattern) -------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** First line of a message, capped — a reason is a LOG FACT, not an error dump. */
const oneLine = (text: string): string => {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > REASON_MAX ? line.slice(0, REASON_MAX) : line;
};

/**
 * A failure's log line: for a GhError, the exit code and gh's first stderr
 * line (the argv is omitted — it carries the whole serialized ledger);
 * otherwise the message. The caller caps it via oneLine.
 */
const describe = (err: unknown): string => {
  if (err instanceof GhError) {
    const stderr = err.stderr.trim().split('\n', 1)[0] ?? '';
    return `gh exit ${String(err.code)}${stderr === '' ? '' : `: ${stderr}`}`;
  }
  return err instanceof Error ? err.message : String(err);
};

/** True for a gh failure that is the forge's 404 (resource absent). */
const isNotFound = (err: unknown): boolean =>
  err instanceof GhError && (err.stderr.includes('Not Found') || err.stderr.includes('HTTP 404'));

/** True for a gh failure that is the forge's 422 (validation refusal). */
const isUnprocessable = (err: unknown): boolean =>
  err instanceof GhError && err.stderr.includes('HTTP 422');

/** Validate owner/repo with the shared transport guard; THROWS on a bad spelling. */
const repoPath = (deps: StateBranchDeps): string => {
  if (!ghNameOk(deps.owner) || !ghNameOk(deps.repo)) {
    throw new Error(
      `selfhost state-branch: owner/repo must match the gh name charset (never "." or "..") — got owner ${JSON.stringify(deps.owner)}, repo ${JSON.stringify(deps.repo)}`,
    );
  }
  return `repos/${deps.owner}/${deps.repo}`;
};

/**
 * Read the settle ledger from the cq-state tip. Absent branch → empty
 * ledger, parentCommit null; branch present but file missing → empty
 * ledger at that tip; unparseable/foreign content → empty ledger plus a
 * discarded reason. The file is read PINNED to the tip commit just read.
 * THROWS on an invalid owner/repo, on any non-404 transport failure, and
 * on a tip that is not a 40-hex commit sha (the forge did not answer
 * honestly — the caller refuses rather than guessing).
 */
export async function readSettleState(deps: StateBranchDeps): Promise<StateBranchSnapshot> {
  const base = repoPath(deps);
  const fullName = `${deps.owner}/${deps.repo}`;
  let refWire: unknown;
  try {
    refWire = await ghJson<unknown>(deps.gh, ['api', `${base}/git/ref/heads/${STATE_BRANCH}`]);
  } catch (err) {
    if (isNotFound(err)) {
      return { state: emptySettleState(fullName), parentCommit: null, discarded: [] };
    }
    throw err;
  }
  const tip = asString(asRecord(asRecord(refWire)['object'])['sha']);
  if (!SHA_RE.test(tip)) {
    throw new Error(
      `selfhost state-branch: ${STATE_BRANCH} ref did not carry a 40-hex commit sha — got ${JSON.stringify(tip.slice(0, 80))}`,
    );
  }

  let fileWire: unknown;
  try {
    fileWire = await ghJson<unknown>(deps.gh, [
      'api',
      `${base}/contents/${SETTLE_STATE_PATH}?ref=${tip}`,
    ]);
  } catch (err) {
    if (isNotFound(err)) {
      return { state: emptySettleState(fullName), parentCommit: tip, discarded: [] };
    }
    throw err;
  }
  const file = asRecord(fileWire);
  const discardedEmpty = (why: string): StateBranchSnapshot => ({
    state: emptySettleState(fullName),
    parentCommit: tip,
    discarded: [why],
  });
  if (asString(file['encoding']) !== 'base64' || typeof file['content'] !== 'string') {
    return discardedEmpty(`${SETTLE_STATE_PATH} at ${tip} is not a base64 file payload`);
  }
  const text = Buffer.from(asString(file['content']).replace(/\s/g, ''), 'base64').toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return discardedEmpty(`${SETTLE_STATE_PATH} at ${tip} is not valid JSON`);
  }
  const { state, discarded } = parseSettleState(raw, fullName);
  return { state, parentCommit: tip, discarded };
}

/**
 * Persist `snapshot.state` as the next cq-state commit: a fresh one-file
 * tree (no base_tree — the branch holds exactly the ledger), a commit
 * parented on `snapshot.parentCommit` (a root commit when null), then a
 * fast-forward-only ref move (compare-and-swap) or, for bootstrap, the ref
 * creation. Every forge refusal or transport failure resolves
 * `{ ok: false, reason }` (one line, capped) — never a throw. THROWS only
 * on caller bugs: an invalid owner/repo, or a parentCommit that is not a
 * 40-hex sha.
 */
export async function writeSettleState(
  deps: StateBranchDeps,
  snapshot: { state: SettleState; parentCommit: string | null },
  message: string,
): Promise<StateBranchWriteResult> {
  const base = repoPath(deps);
  const { parentCommit } = snapshot;
  if (parentCommit !== null && !SHA_RE.test(parentCommit)) {
    throw new Error(
      `selfhost state-branch: parentCommit must be a 40-hex sha or null — got ${JSON.stringify(parentCommit)}`,
    );
  }
  try {
    const treeWire = await ghJson<unknown>(deps.gh, [
      'api',
      '-X',
      'POST',
      `${base}/git/trees`,
      '-f',
      `tree[][path]=${SETTLE_STATE_PATH}`,
      '-f',
      'tree[][mode]=100644',
      '-f',
      'tree[][type]=blob',
      '-f',
      `tree[][content]=${serializeSettleState(snapshot.state)}`,
    ]);
    const treeSha = asString(asRecord(treeWire)['sha']);
    if (!SHA_RE.test(treeSha)) {
      return { ok: false, reason: 'state branch write: tree create returned no 40-hex sha' };
    }

    const commitWire = await ghJson<unknown>(deps.gh, [
      'api',
      '-X',
      'POST',
      `${base}/git/commits`,
      '-f',
      `message=${message}`,
      '-f',
      `tree=${treeSha}`,
      ...(parentCommit === null ? [] : ['-f', `parents[]=${parentCommit}`]),
    ]);
    const commit = asString(asRecord(commitWire)['sha']);
    if (!SHA_RE.test(commit)) {
      return { ok: false, reason: 'state branch write: commit create returned no 40-hex sha' };
    }

    if (parentCommit === null) {
      try {
        await ghJson<unknown>(deps.gh, [
          'api',
          '-X',
          'POST',
          `${base}/git/refs`,
          '-f',
          `ref=refs/heads/${STATE_BRANCH}`,
          '-f',
          `sha=${commit}`,
        ]);
      } catch (err) {
        if (isUnprocessable(err)) {
          return {
            ok: false,
            reason: oneLine(
              `state branch already exists (concurrent bootstrap) — ${describe(err)}`,
            ),
          };
        }
        throw err;
      }
    } else {
      try {
        await ghJson<unknown>(deps.gh, [
          'api',
          '-X',
          'PATCH',
          `${base}/git/refs/heads/${STATE_BRANCH}`,
          '-f',
          `sha=${commit}`,
          '-F',
          'force=false',
        ]);
      } catch (err) {
        if (isUnprocessable(err)) {
          return {
            ok: false,
            reason: oneLine(`state branch moved (concurrent writer) — ${describe(err)}`),
          };
        }
        throw err;
      }
    }
    return { ok: true, commit };
  } catch (err) {
    return {
      ok: false,
      reason: oneLine(`state branch write failed: ${describe(err)}`),
    };
  }
}
