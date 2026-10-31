// selfhost/state-branch — the DURABLE settle-ledger store (task W1.2 slice
// A, the RS-3 decision): the settle ledger (policy/queue/settle-state.ts,
// the pure schema) persisted as ONE file (`SETTLE_STATE_PATH`, selfhost
// config) on a dedicated git STATE BRANCH (`cq-state`),
// read and written through the GitHub git-data REST API over the gh CLI
// transport (gh.ts's GhFn seam).
//
// WHY A STATE BRANCH: settle observations must outlive any one workflow
// run. The Actions cache is EVICTABLE (an eviction would silently reset —
// or, worse, a poisoned entry could fabricate — settle) and PR content is
// author-controlled. A branch in the base repository is durable and audited
// (every write is a commit). It is NOT yet writable only by our automation:
// that holds once W1.10's ruleset restricts `cq-state`; until then any
// holder of Contents write can push it. A forged, back-dated anchor could
// shorten settle, but can never forge SHA-bound acceptance (the recheck
// reads reviews from the forge, never from this branch).
//
// EVERY WRITE IS A PUSH: each ref move runs the repo's unfiltered `push:`
// workflows on this branch, so callers write only on material change (see
// merge-recheck.ts).
//
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
// reason instead of pretending the forge answered "no observations". Only
// gh's status form (`HTTP 404`) is a 404 — bare "Not Found" text is a
// transport failure. A 404 from an inaccessible repository also reads as
// empty — harmless for settle, and the subsequent write fails loudly.
import { GhError, ghJson, ghNameOk } from '../adapters/forge-github/gh.js';
import type { GhFn } from '../adapters/forge-github/gh.js';
import {
  emptySettleState,
  parseSettleState,
  serializeSettleState,
} from '../policy/queue/settle-state.js';
import type { SettleState } from '../policy/queue/settle-state.js';
import { SETTLE_STATE_PATH } from './config.js';

/** The dedicated state branch holding the settle ledger (and nothing else). */
export const STATE_BRANCH = 'cq-state';

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

/**
 * True for a gh failure that is the forge's 404 (resource absent) — gh's
 * status form `HTTP 404` ONLY. Bare "Not Found" text is NOT a 404: a proxy
 * or gateway page can say it on any failure, and reading that as "no
 * ledger" would silently reset settle, so it stays a transport failure.
 */
const isNotFound = (err: unknown): boolean =>
  err instanceof GhError && /\bHTTP 404\b/.test(err.stderr);

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

  return { ...(await readLedgerAt(deps, base, fullName, tip)), parentCommit: tip };
}

/** The ledger file at one cq-state commit (404 → empty); other failures throw. */
async function readLedgerAt(
  deps: StateBranchDeps,
  base: string,
  fullName: string,
  commit: string,
  missingIsDiscarded = false,
): Promise<{ state: SettleState; discarded: string[] }> {
  let fileWire: unknown;
  try {
    fileWire = await ghJson<unknown>(deps.gh, [
      'api',
      `${base}/contents/${SETTLE_STATE_PATH}?ref=${commit}`,
    ]);
  } catch (err) {
    if (isNotFound(err)) {
      // At the tip, a missing file is an empty ledger. At a commit the
      // history listed as touching it, missing is an anomaly (a barrier).
      return {
        state: emptySettleState(fullName),
        discarded: missingIsDiscarded
          ? [`${SETTLE_STATE_PATH} missing at listed history commit ${commit}`]
          : [],
      };
    }
    throw err;
  }
  const file = asRecord(fileWire);
  const discardedEmpty = (why: string): { state: SettleState; discarded: string[] } => ({
    state: emptySettleState(fullName),
    discarded: [why],
  });
  if (asString(file['encoding']) !== 'base64' || typeof file['content'] !== 'string') {
    return discardedEmpty(`${SETTLE_STATE_PATH} at ${commit} is not a base64 file payload`);
  }
  const text = Buffer.from(asString(file['content']).replace(/\s/g, ''), 'base64').toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return discardedEmpty(`${SETTLE_STATE_PATH} at ${commit} is not valid JSON`);
  }
  return parseSettleState(raw, fullName);
}

/**
 * The ledger's versions, newest first, in pages of `pageSize` commits
 * that touched the ledger file, read lazily until `enough` holds for the
 * versions read so far. The observer prunes merged PRs from the tip, so a
 * merged PR's last record lives only in this history (the D11 epoch reads
 * it). `exhausted`: the history ran out before `enough` held. An absent
 * branch is an empty history. A version with ANY discarded content (an
 * unreadable or malformed ledger, or a dropped record) is a lookup BARRIER:
 * it is kept and reading stops there (`barrier`); a listed commit whose
 * ledger file is missing counts as discarded. A PR the barrier may have held
 * never falls through to an older, possibly stale observation — the PR gets
 * no epoch and its D11 record is invalid (fail closed). THROWS on any
 * non-404 transport failure or a listed commit that is not a 40-hex sha.
 * Page 2 onward is pinned to the first listed commit, so concurrent ledger
 * writes cannot shift the pagination. The fixed page budget bounds API work;
 * `limited` distinguishes that stop from genuine history exhaustion.
 */
export const SETTLE_HISTORY_MAX_PAGES = 20;

export async function readSettleHistory(
  deps: StateBranchDeps,
  pageSize: number,
  enough: (versions: readonly SettleState[]) => boolean,
): Promise<{
  versions: SettleState[];
  discarded: string[];
  exhausted: boolean;
  barrier: boolean;
  limited: boolean;
}> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('settle history page size must be an integer from 1 to 100');
  }
  const base = repoPath(deps);
  const fullName = `${deps.owner}/${deps.repo}`;
  const versions: SettleState[] = [];
  const discarded: string[] = [];
  const result = (exhausted: boolean, barrier = false, limited = false) => ({
    versions,
    discarded,
    exhausted,
    barrier,
    limited,
  });
  let anchor = STATE_BRANCH;
  for (let page = 1; page <= SETTLE_HISTORY_MAX_PAGES; page += 1) {
    if (enough(versions)) return result(false);
    let listWire: unknown;
    try {
      listWire = await ghJson<unknown>(deps.gh, [
        'api',
        `${base}/commits?sha=${anchor}&path=${SETTLE_STATE_PATH}&per_page=${String(pageSize)}&page=${String(page)}`,
      ]);
    } catch (err) {
      // Only an absent initial branch is an empty history. A pinned page
      // disappearing is a transport/integrity fault, never exhaustion.
      if (page === 1 && isNotFound(err)) return result(true);
      throw err;
    }
    if (!Array.isArray(listWire) || listWire.length > pageSize) {
      throw new Error(`selfhost state-branch: ${STATE_BRANCH} history is not a valid page`);
    }
    const commits = (listWire as unknown[]).map((c) => asString(asRecord(c)['sha']));
    for (const commit of commits) {
      if (enough(versions)) return result(false);
      if (!SHA_RE.test(commit)) {
        throw new Error(
          `selfhost state-branch: ${STATE_BRANCH} history listed a non-sha commit ${JSON.stringify(commit.slice(0, 80))}`,
        );
      }
      if (page === 1 && versions.length === 0) anchor = commit;
      const read = await readLedgerAt(deps, base, fullName, commit, true);
      versions.push(read.state);
      discarded.push(...read.discarded);
      if (read.discarded.length > 0) return result(false, true);
    }
    if (enough(versions)) return result(false);
    if (commits.length < pageSize) return result(true);
  }
  return result(false, false, true);
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
