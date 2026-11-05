// Split provenance: test/e2e/merge/live.test.ts was split by subject into
// live.test.ts (the gated describe and the single sequenced drill test) and
// this module (the drill's constants, typed exec/json helpers, synthetic
// evidence candidate builder, scripted conflict agent, and the drill's local
// non-assertion steps: clone-bound git helpers, PR creation, the branch
// seeder, head observation, the convergence predicate and the first-parent
// rev-list reader). This module declares no tests.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { RoutingTable } from '../../../src/driver/claude-code/routing.js';
import type { ExecutionReport } from '../../../src/ops/merge/executeMerges.js';
import type { MergePrsCandidate } from '../../../src/ops/merge/runPrs.js';
import type { ReviewSummary } from '../../../src/ops/review/threads.js';

// ---------------------------------------------------------------------------
// Gate + drill constants
// ---------------------------------------------------------------------------

/** The suite runs ONLY when the caller explicitly asked for the live drill. */
export const LIVE = process.env.LIVE_GH === '1';

/** The scratch repo's owner (the drill creates repos only under it) —
 * environment-overridable so a fork operator can run the drill under their
 * own account; the default is this repository's owner. */
export const OWNER = process.env.CQ_DRILL_OWNER ?? 'camerontaylor';

/** The drill's branch names — conservative refnames by design (they must
 * pass resolveConflict's refname gate and the composition's dispatch
 * screening; names like 'f5-a' are exactly the admitted shape). */
export const BRANCH_A = 'f5-a';
export const BRANCH_B = 'f5-b';
export const BRANCH_C = 'f5-c';
export const DRILL_BRANCHES = [BRANCH_A, BRANCH_B, BRANCH_C];

/** Base seed content; each stack rung rewrites only the first line. */
export const SEED_BASE = 'alpha\nbeta\n';
export const seedWith = (firstLine: string): string => `${firstLine}\nbeta\n`;

/** Per-test budget: a live drill crosses the network many times. */
export const DRILL_TIMEOUT_MS = 20 * 60_000;

/** The mergeability poll: mergeability computes asynchronously on the
 * forge; ~30s is generous for a fresh 4-commit repo. */
export const MERGEABILITY_POLL_ATTEMPTS = 30;
export const MERGEABILITY_POLL_INTERVAL_MS = 1_000;

/** The inter-iteration settle wait for the convergence loop: GitHub
 * recomputes mergeability ASYNCHRONOUSLY, and an iteration whose whole
 * candidate view read the forge's stale `unknown` classifies everything
 * ineligible and dispatches nothing — rapid back-to-back API polls would
 * burn the 8-iteration cap against a forge that never got the chance to
 * update. A work-free iteration waits this out once before the next poll
 * (~15s, far inside the per-test budget); an iteration that dispatched
 * work (merges, retargets, resolutions) already changed live state and
 * never waits. */
export const MERGE_RECOMPUTE_SETTLE_MS = 15_000;

export const log = (line: string): void => {
  console.error(`[f5-live-drill] ${line}`);
};

// ---------------------------------------------------------------------------
// Small typed exec + json helpers (every spawn is execFile, never a shell)
// ---------------------------------------------------------------------------

/** A resolved process run: exit code plus captured streams (the GhFn
 * philosophy — resolve with the code, let the caller fail closed). */
export interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export const exec = (
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<ExecOutcome> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        ...(cwd !== undefined ? { cwd } : {}),
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
  });

export const failOutcome = (what: string, outcome: ExecOutcome): Error =>
  new Error(
    `${what} failed (exit ${String(outcome.code)}): ${outcome.stderr.trim() || outcome.stdout.trim()}`,
  );

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const parseJsonText = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** One `gh api` call returning a JSON object (GH_TOKEN rides the env; the
 * response never contains it). */
export const ghApiObject = async (path: string): Promise<Record<string, unknown>> => {
  const outcome = await exec('gh', ['api', path]);
  if (outcome.code !== 0) throw failOutcome(`gh api ${path}`, outcome);
  const parsed = asRecord(parseJsonText(outcome.stdout));
  if (Object.keys(parsed).length === 0) {
    throw new Error(`gh api ${path}: expected a JSON object, got none`);
  }
  return parsed;
};

/** The REST mergeable_state → the GraphQL-style uppercase union classify
 * consumes. An unrecognized value fails closed to 'UNKNOWN'. */
const MERGE_STATES = ['DIRTY', 'BEHIND', 'CLEAN', 'UNKNOWN', 'HAS_HOOKS', 'BLOCKED'] as const;
type MergeState = (typeof MERGE_STATES)[number];
export const toMergeState = (raw: unknown): MergeState => {
  const upper = asString(raw).toUpperCase();
  return (MERGE_STATES as readonly string[]).includes(upper) ? (upper as MergeState) : 'UNKNOWN';
};

// ---------------------------------------------------------------------------
// The synthetic evidence overlay + the candidate builder (step 4)
// ---------------------------------------------------------------------------

/**
 * The synthetic eligibility row. RECORDED DEVIATION (see the module doc):
 * the body must match the frozen allClearPattern for row 8 to fire —
 * 'lgtm' is the minimal pattern-matching all-clear. Everything else is the
 * briefed shape: APPROVED, null author (external — counts, per the house
 * rule that null is never the PR author), submitted strictly after the
 * head commit so the row-7 temporal qualifier holds.
 */
const overlayReview = (pr: number, lastCommitAt: string | null): ReviewSummary => {
  const commitMs = lastCommitAt === null ? Number.NaN : Date.parse(lastCommitAt);
  const submittedMs = Number.isNaN(commitMs) ? Date.now() : Math.max(Date.now(), commitMs + 1);
  return {
    id: `r${String(pr)}`,
    authorLogin: null,
    state: 'APPROVED',
    body: 'lgtm',
    submittedAt: new Date(submittedMs).toISOString(),
  };
};

/** One drill PR as the drill tracks it: the number and the head branch the
 * drill itself created (asserted against the live pull on every fetch). */
export interface DrillPr {
  number: number;
  headBranch: string;
}

/**
 * Build MergePrsCandidate rows from REAL `gh api` pull state for the
 * drill's prs — closed pulls included (a merged rung must remain
 * resolvable: it anchors the retarget-self rule for its stacked child).
 * Every head sha seen lands in `observe` (the no-force history evidence).
 *
 * THE OVERLAY GATE (recorded deviation, extends the overlay note above):
 * the tail rung (pr 3) earns its synthetic all-clear only once its parent
 * rung (pr 2) reports closed — a reviewer approves the tail of a stack
 * after the parent landed. This pins the drill deterministically to the
 * mission's expected retarget path (pr 3 retargets onto the trunk AFTER pr
 * 2 merged, then merges into main) independent of the forge's
 * mergeability-recompute races: while pr 2 is open, pr 3 honestly carries
 * NO acceptable review (empty reviews → row 7 awaiting) and is never
 * ordered alongside it. Everything the pipeline decides still comes from
 * the real pull state plus this drill-owned evidence layer.
 */
export const makeCandidateFetcher = (
  repo: string,
  drillPrs: DrillPr[],
  observe: (branch: string, sha: string) => void,
): (() => Promise<MergePrsCandidate[]>) => {
  const fetchOne = async (
    drillPr: DrillPr,
    overlayUnlocked: boolean,
  ): Promise<MergePrsCandidate> => {
    const pull = await ghApiObject(`repos/${repo}/pulls/${String(drillPr.number)}`);
    const head = asRecord(pull['head']);
    const base = asRecord(pull['base']);
    const user = asRecord(pull['user']);
    const headRefName = asString(head['ref']);
    const headSha = asString(head['sha']);
    const baseRefName = asString(base['ref']);
    expect(headRefName, `pr ${String(drillPr.number)} head ref drifted`).toBe(drillPr.headBranch);
    observe(headRefName, headSha);
    const commit = asRecord(await ghApiObject(`repos/${repo}/commits/${headSha}`))['commit'];
    const committer = asRecord(asRecord(commit)['committer']);
    const lastCommitAt: string | null = asString(committer['date']) || null;
    const authorLogin = asString(user['login']);
    const state = asString(pull['state']) === 'open' ? 'open' : 'closed';
    return {
      pr: drillPr.number,
      authorLogin: authorLogin === '' ? null : authorLogin,
      draft: pull['draft'] === true,
      mergeState: toMergeState(pull['mergeable_state']),
      truncated: false,
      threads: [],
      reviews: overlayUnlocked ? [overlayReview(drillPr.number, lastCommitAt)] : [],
      issueComments: [],
      lastCommitAt,
      headRefName,
      baseRefName,
      state,
    };
  };
  return async (): Promise<MergePrsCandidate[]> => {
    const rows: MergePrsCandidate[] = [];
    let parentRungClosed = true; // the root (pr 1) has no parent rung to wait for
    for (const drillPr of drillPrs) {
      const row = await fetchOne(drillPr, parentRungClosed);
      rows.push(row);
      // The NEXT rung's overlay unlocks only when THIS rung has closed
      // (merged or closed — the drill closes prs by merging only).
      parentRungClosed = row.state === 'closed';
    }
    return rows;
  };
};

// ---------------------------------------------------------------------------
// The scripted conflict agent (step 5) — driver-protocol events copied from
// the stream-json fixtures the claude-code driver parses (system init +
// result success carrying structured_output; see src/driver/claude-code and
// test/fixtures/fake-agent-cli.mjs for the shapes).
// ---------------------------------------------------------------------------

export const FAKE_ROUTING_TABLE: RoutingTable = {
  endpoints: {
    f5fake: {
      baseUrlEnv: 'F5_FAKE_BASE_URL',
      baseUrlDefault: 'http://127.0.0.1:9/v1',
      keyEnv: 'F5_FAKE_KEY',
      models: ['f5fake-model'],
      notes: 'F5 live drill fake endpoint — the scripted agent ignores env and network entirely.',
    },
  },
};

/**
 * The fake worker's whole text. The driver runs it with cwd = the prepared
 * merge worktree (the session workspace the resolve op created there), so
 * the plain git commands below operate on the conflicted PR-2 worktree.
 * The stack topology (fetch f5-a, push f5-b) is baked in here — the test
 * owns the topology. On any real failure it exits nonzero WITHOUT a result
 * event, so the driver's verdict is an honest 'error' (never a guessed
 * success); on success it prints the init + result events whose
 * structured_output satisfies MergeConflictDecisionSchema.
 */
export const agentScript = (
  baseBranch: string,
  headBranch: string,
  pr: number,
): string => `#!/bin/sh
# F5 live drill scripted conflict agent: a REAL union resolution of the
# seeded conflict (${baseBranch} into ${headBranch}), committed as a normal
# merge commit and pushed. Never force, never squash, never main.
set -u
fail() {
  echo "f5-agent: $1" >&2
  exit 1
}
git fetch origin ${baseBranch} || fail 'git fetch origin ${baseBranch} failed'
git merge --no-commit FETCH_HEAD || true
git show :2:seed.txt > .f5-ours || fail 'conflict stage :2: (ours) missing — the merge was not conflicted'
git show :3:seed.txt > .f5-theirs || fail 'conflict stage :3: (theirs) missing'
git show :1:seed.txt > .f5-base || fail 'conflict stage :1: (base) missing'
git merge-file --union .f5-ours .f5-base .f5-theirs || fail 'git merge-file --union failed'
cp .f5-ours seed.txt || fail 'cp union result failed'
rm -f .f5-ours .f5-base .f5-theirs
git add seed.txt || fail 'git add seed.txt failed'
git commit -m 'merge: union resolution of ${baseBranch} into ${headBranch}' || fail 'git commit failed'
git push origin HEAD:${headBranch} || fail 'git push origin HEAD:${headBranch} failed'
# The push moved refs/heads/${headBranch}, but the forge propagates
# refs/pull/${pr}/head (the ref the caller's acted-verification fetches)
# ASYNCHRONOUSLY — found live: an instantaneous verification read the stale
# sha and turned a good 'acted' into a false indeterminate. A worker that
# reports acted owes the caller an OBSERVABLE push, so wait (bounded) until
# the pull ref carries the pushed sha, then — and only then — emit the
# driver-protocol events.
PUSHED=$(git rev-parse HEAD)
REMOTE_SHA=''
i=0
while [ "$i" -lt 60 ]; do
  REMOTE_SHA=$(git ls-remote origin refs/pull/${pr}/head | cut -f1)
  if [ "$REMOTE_SHA" = "$PUSHED" ]; then
    break
  fi
  sleep 1
  i=$((i+1))
done
if [ "$REMOTE_SHA" != "$PUSHED" ]; then
  fail "refs/pull/${pr}/head never advanced to the pushed sha \${PUSHED}"
fi
echo '{"type":"system","subtype":"init","session_id":"f5-live-agent","model":"f5fake-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"union resolution of ${baseBranch} pushed to ${headBranch}"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}'
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"f5-live-agent","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":3},"model":"f5fake-model","structured_output":{"decision":"acted","summary":"union merge pushed"}}'
`;

// ---------------------------------------------------------------------------
// Report logging (the drill log's run summaries)
// ---------------------------------------------------------------------------

export const reportSummary = (report: ExecutionReport): string =>
  `merged=[${report.merged.map(String).join(',')}] retargeted=[${report.retargeted.map(String).join(',')}]` +
  ` stale=[${report.stale.map((entry) => String(entry.pr)).join(',')}]` +
  ` failed=[${report.failed.map((entry) => String(entry.pr)).join(',')}]` +
  ` blocked=[${report.blocked.map((entry) => String(entry.pr)).join(',')}]`;

// ---------------------------------------------------------------------------
// The drill's local steps (steps 2-7): each is a factory over the drill's
// per-run bindings (cloneDir, repo, drillPrs, the observed-head map). No
// assertion lives here — the drill owns every expect() — and every failure is
// still failOutcome-based.
// ---------------------------------------------------------------------------

interface CloneTools {
  gitInClone: (args: readonly string[]) => Promise<ExecOutcome>;
  gitOk: (what: string, args: readonly string[]) => Promise<string>;
  revParse: (ref: string) => Promise<string>;
  writeInClone: (relPath: string, content: string) => Promise<void>;
}

/** Git reads/writes bound to one clone (step 2): every spawn is execFile. */
export const makeCloneTools = (cloneDir: string): CloneTools => {
  const gitInClone = async (args: readonly string[]): Promise<ExecOutcome> =>
    exec('git', ['-C', cloneDir, ...args]);
  const gitOk = async (what: string, args: readonly string[]): Promise<string> => {
    const outcome = await gitInClone(args);
    if (outcome.code !== 0) throw failOutcome(what, outcome);
    return outcome.stdout.trim();
  };
  const revParse = async (ref: string): Promise<string> =>
    gitOk(`rev-parse ${ref}`, ['rev-parse', ref]);
  const writeInClone = async (relPath: string, content: string): Promise<void> => {
    await writeFile(join(cloneDir, relPath), content, 'utf8');
  };
  return { gitInClone, gitOk, revParse, writeInClone };
};

/** PR creation (step 3): `gh pr create` against the drill's scratch repo. */
export const makePrCreator = (repo: string) => {
  const createPr = async (base: string, head: string, title: string): Promise<number> => {
    const outcome = await exec('gh', [
      'pr',
      'create',
      '--repo',
      repo,
      '--base',
      base,
      '--head',
      head,
      '--title',
      title,
      '--body',
      'F5 live drill scratch PR — the scratch repo is left in place for the owner to delete.',
    ]);
    if (outcome.code !== 0) throw failOutcome(`gh pr create ${head} -> ${base}`, outcome);
    const url =
      outcome.stdout
        .split('\n')
        .map((line) => line.trim())
        .findLast((line) => line.includes('/pull/')) ?? '';
    const match = /\/pull\/(\d+)$/.exec(url);
    if (match === null) throw new Error(`gh pr create printed no pull URL: ${outcome.stdout}`);
    return Number(match[1]);
  };
  return createPr;
};

/** One stack rung (step 3): branch from `from`, reword the seed line, push. */
export const makeBranchSeeder = (cloneDir: string) => {
  const { gitInClone, revParse, writeInClone } = makeCloneTools(cloneDir);
  const commitBranchSeed = async (
    branch: string,
    from: string,
    firstLine: string,
    message: string,
  ): Promise<string> => {
    const checkout = await gitInClone(['checkout', '-b', branch, from]);
    if (checkout.code !== 0) throw failOutcome(`git checkout -b ${branch} ${from}`, checkout);
    await writeInClone('seed.txt', seedWith(firstLine));
    const add = await gitInClone(['add', 'seed.txt']);
    if (add.code !== 0) throw failOutcome(`git add (seed.txt on ${branch})`, add);
    const commit = await gitInClone(['commit', '-m', message]);
    if (commit.code !== 0) throw failOutcome(`git commit (${branch})`, commit);
    const push = await gitInClone(['push', 'origin', branch]);
    if (push.code !== 0) throw failOutcome(`git push origin ${branch}`, push);
    return revParse(branch);
  };
  return commitBranchSeed;
};

interface HeadObservation {
  observedHeads: Map<string, Set<string>>;
  observeHead: (branch: string, sha: string) => void;
}

/** The no-force evidence (7c): every head sha ever observed per branch. */
export const makeHeadObserver = (): HeadObservation => {
  const observedHeads = new Map<string, Set<string>>();
  const observeHead = (branch: string, sha: string): void => {
    let seen = observedHeads.get(branch);
    if (seen === undefined) {
      seen = new Set<string>();
      observedHeads.set(branch, seen);
    }
    seen.add(sha);
  };
  return { observedHeads, observeHead };
};

/** Step 6's stop predicate: every drill PR reports merged on the live forge. */
export const makeAllThreeMerged = (
  repo: string,
  drillPrs: DrillPr[],
  observeHead: (branch: string, sha: string) => void,
) => {
  const allThreeMerged = async (): Promise<boolean> => {
    for (const drillPr of drillPrs) {
      const pull = await ghApiObject(`repos/${repo}/pulls/${String(drillPr.number)}`);
      observeHead(drillPr.headBranch, asString(asRecord(pull['head'])['sha']));
      // REST has no 'MERGED' state: merged:true + state:'closed' is its
      // spelling of GraphQL's MERGED.
      if (!(pull['merged'] === true && asString(pull['state']) === 'closed')) return false;
    }
    return true;
  };
  return allThreeMerged;
};

/** Step 7b's first-parent rev-list reader over the drill range. */
export const makeRevList = (
  gitOk: (what: string, args: readonly string[]) => Promise<string>,
  drillRange: readonly string[],
) => {
  const revList = async (extra: readonly string[]): Promise<string[]> =>
    (
      await gitOk(`rev-list ${extra.join(' ')}`, [
        'rev-list',
        '--first-parent',
        ...extra,
        ...drillRange,
      ])
    )
      .split('\n')
      .filter((line) => line !== '');
  return revList;
};
