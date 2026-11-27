/**
 * Resume selection follows the established worktree ownership contract, pinned
 * offline.
 *
 * Python's `resume_worktree` (apps/crq-python/crq_repair.py) adopts the recorded
 * `worktree` only when it resolves differently, is owned by this job, is a
 * directory and holds a `.git` entry. Ownership is the rule two established
 * contracts already apply:
 *
 * - `crq_repair/recovery.py:70-72`: the resolved tree must sit directly under the
 *   resolved `WT_ROOT` and be named `crq-repair-<item>-<job>` or `...-A2`;
 * - `crq_repair/retain.py:29` (`cleanup_harvested`), ported as the
 *   `worktree-not-owned` refusal of `decideRepairCleanup`.
 *
 * (The harvest validator additionally tolerates the legacy `crq-repair-<item>`
 * name; resume does not, matching recovery and cleanup.)
 *
 * No Git-registration contract exists anywhere in Python: nothing runs
 * `git worktree list`, and `.git` existence is the only registration evidence
 * the selector uses. A registration flag below is therefore SYNTHETIC fixture
 * data, carried only to show it changes nothing.
 *
 * `decideRepairCleanup` is the ownership oracle (no new policy is written) and
 * the same synthetic recorded worktrees go to `decideResumeCandidate`, so the two
 * agree on every record: owned base and `-A2` controls are adopted, and every
 * foreign, outside-root, nested, legacy or `-A2-A2` record is not, and is refused
 * for a pending stage rather than judged or verified in its place.
 * Fully synthetic: no filesystem, Git, queue, judge, provider or network.
 */
import { describe, expect, it } from 'vitest';
import {
  decideRepairCleanup,
  type RepairCleanupProbes,
  type RepairCleanupRefusal,
} from '../../src/queue-runner/repairCleanup.js';
import {
  decideResumeCandidate,
  type RepairResumeOwner,
  type RepairResumeProbes,
} from '../../src/queue-runner/repairResume.js';

const ROOT = '/wt';
const ITEM = 'pr1-merged';
const JOB = 'crq-R-F1';
const OWNER: RepairResumeOwner = { worktreeRoot: ROOT, itemId: ITEM, jobId: JOB };
const BASE = `${ROOT}/crq-repair-${ITEM}-${JOB}`;
const A2 = `${BASE}-A2`;

interface Record_ {
  readonly name: string;
  readonly path: string;
  /** Does the established ownership contract (recovery.py / cleanup) accept it? */
  readonly owned: boolean;
  /** SYNTHETIC `git worktree list` membership; no contract reads it. */
  readonly registered: boolean;
}

const rec = (name: string, path: string, owned: boolean, registered = true): Record_ => ({
  name,
  path,
  owned,
  registered,
});

const RECORDS: readonly Record_[] = [
  rec('owned base', BASE, true),
  rec('owned -A2', A2, true),
  rec('owned base, unregistered', BASE, true, false),
  rec('owned -A2, unregistered', A2, true, false),
  rec('foreign job id', `${ROOT}/crq-repair-${ITEM}-crq-R-F2`, false),
  rec('foreign item id', `${ROOT}/crq-repair-pr2-merged-${JOB}`, false),
  rec('legacy name (harvest accepts, cleanup refuses)', `${ROOT}/crq-repair-${ITEM}`, false),
  rec('unrelated name under WT_ROOT', `${ROOT}/scratch`, false),
  rec('-A2 of -A2', `${A2}-A2`, false),
  rec('owned name outside WT_ROOT', `/elsewhere/crq-repair-${ITEM}-${JOB}`, false),
  rec('owned name nested below WT_ROOT', `${ROOT}/sub/crq-repair-${ITEM}-${JOB}`, false),
  rec('WT_ROOT itself', ROOT, false),
  rec('foreign, unregistered', `${ROOT}/scratch`, false, false),
];

/** A fully answering tree: every path resolves to itself and is a clean directory. */
const cleanupProbes = (): RepairCleanupProbes => ({
  resolve: (p) => Promise.resolve(p),
  isSymlink: () => Promise.resolve(false),
  isDirectory: () => Promise.resolve(true),
  status: () => Promise.resolve({ failed: false, stdout: '' }),
  head: () => Promise.resolve('a'.repeat(40)),
  retainedManifests: () => Promise.resolve([]),
});

/**
 * The ownership oracle: `decideRepairCleanup` refuses `worktree-not-owned`
 * before it asks anything else, and with no retained snapshot an owned tree stops
 * one step later at `no-matching-retention`. Either answer is a pure verdict.
 */
async function cleanupVerdict(path: string): Promise<RepairCleanupRefusal | 'removable'> {
  const decision = await decideRepairCleanup(
    {
      worktreeRoot: ROOT,
      directory: `/state/repair/${JOB}`,
      itemId: ITEM,
      jobId: JOB,
      result: { verdict: 'FIXED', worktree: path },
      alternate: false,
    },
    cleanupProbes(),
  );
  return decision.remove ? 'removable' : decision.reason;
}

/** Resume probes over a tree where every recorded path exists with a `.git` entry. */
function resumeProbes(): { probes: RepairResumeProbes; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    probes: {
      resolve: (p) => {
        calls.push(`resolve ${p}`);
        return Promise.resolve(p);
      },
      isDirectory: (p) => {
        calls.push(`is_dir ${p}`);
        return Promise.resolve(true);
      },
      exists: (p) => {
        calls.push(`exists ${p}`);
        return Promise.resolve(true);
      },
    },
  };
}

describe('resume selection against the established worktree ownership contract', () => {
  it('uses a coherent oracle: only the job-owned base and -A2 trees pass ownership', async () => {
    for (const r of RECORDS) {
      const verdict = await cleanupVerdict(r.path);
      expect(verdict === 'worktree-not-owned', r.name).toBe(!r.owned);
      if (r.owned) expect(verdict, r.name).toBe('no-matching-retention');
    }
  });

  it.each(RECORDS.map((r) => [r.name, r] as const))(
    'selects %s exactly when the ownership contract says it is owned',
    async (_name, r) => {
      const { probes, calls } = resumeProbes();
      // The caller's tree is the owned base tree: the control the recorded
      // `worktree` is compared against.
      const decision = await decideResumeCandidate(
        { pending_judge: true, worktree: r.path },
        BASE,
        probes,
        OWNER,
      );
      if (r.owned) {
        expect(decision).toEqual({ kind: 'proceed', worktree: r.path, adopted: r.path !== BASE });
      } else {
        expect(decision).toEqual({
          kind: 'refuse-missing-candidate',
          pending: 'judge',
          reason: 'pending judge worktree unavailable; needs human',
        });
      }
      // Selection asks only filesystem questions: there is no `git worktree
      // list` or registration probe to ask.
      expect(calls.every((c) => /^(resolve|is_dir|exists) /.test(c))).toBe(true);
      // A foreign tree is refused before it is asked about as a directory.
      if (!r.owned) expect(calls.some((c) => /^(is_dir|exists) /.test(c))).toBe(false);
    },
  );

  it.each(RECORDS.map((r) => [r.name, r] as const))(
    'keeps the tree in hand for %s under dispatch_pending alone, adopting only owned',
    async (_name, r) => {
      const { probes } = resumeProbes();
      const decision = await decideResumeCandidate(
        { dispatch_pending: true, worktree: r.path },
        A2,
        probes,
        OWNER,
      );
      const expected = r.owned && r.path !== A2 ? r.path : A2;
      expect(decision).toEqual({ kind: 'proceed', worktree: expected, adopted: expected !== A2 });
    },
  );

  it('is blind to registration: the decision is a function of the path alone', async () => {
    const byPath = new Map<string, string>();
    for (const r of RECORDS) {
      const { probes } = resumeProbes();
      const seen = JSON.stringify(
        await decideResumeCandidate({ pending_judge: true, worktree: r.path }, BASE, probes, OWNER),
      );
      const prior = byPath.get(r.path);
      if (prior !== undefined) expect(seen, `${r.name} vs same path`).toBe(prior);
      byPath.set(r.path, seen);
    }
    // 'foreign, unregistered' and 'unrelated name under WT_ROOT' share a path;
    // so do the registered and unregistered owned controls.
    expect(byPath.size).toBeLessThan(RECORDS.length);
  });

  it('no longer diverges from ownership: every adopted record is owned', async () => {
    const divergent: string[] = [];
    for (const r of RECORDS) {
      const { probes } = resumeProbes();
      const decision = await decideResumeCandidate(
        { pending_mechanical: true, worktree: r.path },
        BASE,
        probes,
        OWNER,
      );
      const adopts = decision.kind === 'proceed' && decision.worktree === r.path;
      if (adopts !== r.owned) divergent.push(r.name);
    }
    expect(divergent).toEqual([]);
  });

  it('refuses an owned tree that is missing and a foreign tree alike', async () => {
    const probes: RepairResumeProbes = {
      resolve: (p) => Promise.resolve(p),
      isDirectory: (p) => Promise.resolve(p !== A2),
      exists: () => Promise.resolve(true),
    };
    const owned = await decideResumeCandidate(
      { pending_judge: true, worktree: A2 },
      BASE,
      probes,
      OWNER,
    );
    expect(owned).toMatchObject({ kind: 'refuse-missing-candidate', pending: 'judge' });
    const foreign = await decideResumeCandidate(
      { pending_judge: true, worktree: `${ROOT}/scratch` },
      BASE,
      probes,
      OWNER,
    );
    expect(foreign).toMatchObject({ kind: 'refuse-missing-candidate', pending: 'judge' });
  });

  it('rejects a recorded tree owned by another item or job even when it is the sibling -A2', async () => {
    const { probes } = resumeProbes();
    const otherItem = await decideResumeCandidate(
      { pending_mechanical: true, worktree: `${ROOT}/crq-repair-pr2-merged-${JOB}-A2` },
      BASE,
      probes,
      OWNER,
    );
    expect(otherItem).toMatchObject({ kind: 'refuse-missing-candidate', pending: 'mechanical' });
    const otherJob = await decideResumeCandidate(
      { pending_mechanical: true, worktree: `${ROOT}/crq-repair-${ITEM}-crq-R-F2-A2` },
      BASE,
      probes,
      OWNER,
    );
    expect(otherJob).toMatchObject({ kind: 'refuse-missing-candidate', pending: 'mechanical' });
  });
});
