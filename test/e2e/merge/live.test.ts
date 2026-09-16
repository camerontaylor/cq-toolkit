// live — the F5 LIVE integration drill (ws-f acceptance check, scope item
// "Integration (dispatch-gated scratch repo)"): a 3-PR stack with one
// seeded conflict lands via merge commits only, and the branch history
// shows no squash and no force. This file exercises the REAL composition —
// runMergePrs (classify → plan → execute → resolve → re-plan) over the
// REAL forge (github.com) and a REAL clone — so everything here is gated:
//
//   LIVE_GH=1  +  GH_TOKEN in the environment
//
// Plain `npm run test` SKIPS the whole suite (describe.skip); the skip is
// the default gate's contract. One top-level test runs the drill as a
// sequenced log (every step asserts and logs via console.error so the
// output reads as a drill log), with a generous per-test timeout.
//
// THE DRILL, in order:
//   0. PREFLIGHT   — GH_TOKEN present (never logged), `gh auth status` ok,
//                    a git identity exists (local commits need one).
//   1. SCRATCH     — `gh repo create camerontaylor/cq-scratch-f5-p3f-<run>`
//                    (private, unique per run). The run token has NO
//                    delete_repo scope and the drill NEVER attempts
//                    deletion: the repo is LEFT IN PLACE for the owner to
//                    delete, and the evidence line records its URL.
//                    process.env.GH_REPO is pointed at the scratch repo so
//                    the effects layer's repo-less `gh pr merge/edit` argv
//                    (spawned without a repo cwd) hit the SCRATCH repo and
//                    never this repository.
//   2. SEED        — a throwaway local clone (mkdtemp), local identity +
//                    a gh-backed credential helper (the token rides
//                    GH_TOKEN at push time; it never appears in argv or
//                    logs), a README and seed.txt ('alpha'/'beta') on main.
//   3. STACK       — f5-a rewords 'alpha'→'alpha-A' (PR 1 onto main);
//                    f5-b branches from the SAME pre-a commit and rewords
//                    'alpha'→'alpha-B' (PR 2 onto f5-a — the SEEDED
//                    CONFLICT); f5-c adds c.txt (PR 3 onto f5-b). The
//                    branch names are deliberately conservative refnames —
//                    they must pass resolveConflict's refname gate. The
//                    drill polls PR 2's mergeable_state to DIRTY (the one
//                    sanctioned wait: mergeability computes asynchronously)
//                    and fails loudly otherwise.
//   4. CANDIDATES  — MergePrsCandidate rows built from real `gh api` pull
//                    data (closed pulls included — a merged rung must stay
//                    resolvable as the stack anchor for the retarget-self
//                    rule), plus a SYNTHETIC review overlay. THE OVERLAY IS
//                    A RECORDED DEVIATION: this run has ONE GitHub
//                    identity, so a genuine non-author review is
//                    impossible; and the overlay body must match the
//                    frozen allClearPattern ('lgtm'), because the brief's
//                    prose body would leave the clean PRs on the settle row
//                    (row 9, REVIEW_ACCEPT_SETTLE_MS = ten real minutes a
//                    no-sleep live drill cannot traverse). Row 7's
//                    review-of-the-last-commit requirement still holds in
//                    full: APPROVED, external (null author — the house
//                    rule: null is never the author), submitted strictly
//                    after the head commit. The tail rung's (pr 3) overlay
//                    is GATED on its parent rung reporting closed — a
//                    reviewer approves the tail of a stack after the parent
//                    landed — which pins the drill deterministically to the
//                    retarget path (pr 3 is never eligible while pr 2 is
//                    open, so it can only land after the retarget, on the
//                    trunk; forge mergeability-recompute races can delay
//                    passes but never change the landing shape). I2's table
//                    itself is exhaustively unit-tested in F1; the conflict
//                    path needs NO synthetic evidence (DIRTY is decided at
//                    row 2 before any review row).
//   5. THE AGENT   — a scripted POSIX-sh fake worker (chmod 0o755, path
//                    passed as the SubprocessDriver binary): in the merge
//                    worktree the driver gives it (cwd = the prepared
//                    worktree via the session workspace), it performs a
//                    REAL union resolution of PR 2 — fetch f5-a, merge
//                    --no-commit, three-way union of seed.txt through
//                    git merge-file --union, commit a NORMAL merge commit,
//                    push HEAD:f5-b — then prints the driver-protocol
//                    events (system init + result success carrying
//                    structured_output), copied from the driver's stream
//                    fixtures. The driver gets a fake RoutingTable
//                    (provider 'f5fake', model 'f5fake-model') whose
//                    keyEnv F5_FAKE_KEY the suite sets to a dummy value in
//                    beforeAll — the script ignores env and network
//                    entirely.
//   6. CONVERGE    — up to 8 outer iterations: candidates are REFETCHED
//                    from the live forge (real refetch), runMergePrs runs
//                    with realMergeEffects and the scripted resolve op,
//                    every report is logged; the loop stops when all three
//                    pulls report merged via gh api (REST has no 'merged'
//                    state — merged:true + state:'closed' is its spelling).
//   7. ASSERTIONS  — (a) all three PRs merged; (b) every commit MADE ONTO
//                    origin/main by the drill — main's FIRST-PARENT chain
//                    since the seed (the PR branch commits legitimately ride
//                    the merges as second parents; a full rev-list walk
//                    would list them too) — is a MERGE commit
//                    (rev-list --first-parent --no-merges over the drill
//                    range is empty);
//                    (c) each PR's merge_commit_sha has the PR head as an
//                    ANCESTOR (a squash would not), and every head sha ever
//                    observed for each branch remains an ancestor of the
//                    branch's final tip (a force-push would have rewritten
//                    history out from under an observed sha); (d) the
//                    retarget-self machinery provably ran (some report's
//                    retargeted is non-empty over the drill's prs), PR 3's
//                    base at merge time is main or a — never the closed b —
//                    and the stack's tail content plus BOTH sides of the
//                    union resolution are proven present on the trunk.
//   8. EVIDENCE    — one JSON drill-summary line (scratch repo URL, per-PR
//                    merge commits, run count, retargeted set, seeded
//                    conflict) for the drill doc to consume.
//
// DISCIPLINE: every spawn is execFile (no shell interpolation); the only
// test-level sleep is the mergeability poll (plus the scripted AGENT's own
// bounded wait for the forge to propagate refs/pull/<n>/head to the sha it
// just pushed — a worker reporting acted owes the caller an observable
// push, and an instantaneous verification read a stale ref live);
// GH_TOKEN is asserted, never logged; `git push --force` appears nowhere;
// cleanup removes the LOCAL tmp tree only — never the remote scratch repo.
// TOKEN NOTE: the run token needs the scopes `gh pr merge/edit` demand —
// on classic tokens `gh pr edit`'s GraphQL lookup wants read:org (a token
// without it fails every retarget-self action; found live).
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SubprocessDriver } from '../../../src/driver/subprocess/index.js';
import type { RoutingTable } from '../../../src/driver/subprocess/routing.js';
import { realMergeEffects } from '../../../src/ops/merge/effects.js';
import type { ExecutionReport } from '../../../src/ops/merge/executeMerges.js';
import {
  MergeConflictDecisionSchema,
  makeResolveConflictOp,
} from '../../../src/ops/merge/resolveConflict.js';
import { runMergePrs } from '../../../src/ops/merge/runPrs.js';
import type { MergePrsCandidate } from '../../../src/ops/merge/runPrs.js';
import type { ReviewSummary } from '../../../src/ops/review/threads.js';

// ---------------------------------------------------------------------------
// Gate + drill constants
// ---------------------------------------------------------------------------

/** The suite runs ONLY when the caller explicitly asked for the live drill. */
const LIVE = process.env.LIVE_GH === '1';

/** The scratch repo's owner (the drill creates repos only under it). */
const OWNER = 'camerontaylor';

/** The drill's branch names — conservative refnames by design (they must
 * pass resolveConflict's refname gate and the composition's dispatch
 * screening; names like 'f5-a' are exactly the admitted shape). */
const BRANCH_A = 'f5-a';
const BRANCH_B = 'f5-b';
const BRANCH_C = 'f5-c';
const DRILL_BRANCHES = [BRANCH_A, BRANCH_B, BRANCH_C];

/** Base seed content; each stack rung rewrites only the first line. */
const SEED_BASE = 'alpha\nbeta\n';
const seedWith = (firstLine: string): string => `${firstLine}\nbeta\n`;

/** Per-test budget: a live drill crosses the network many times. */
const DRILL_TIMEOUT_MS = 20 * 60_000;

/** The mergeability poll: mergeability computes asynchronously on the
 * forge; ~30s is generous for a fresh 4-commit repo. The ONLY sleep. */
const MERGEABILITY_POLL_ATTEMPTS = 30;
const MERGEABILITY_POLL_INTERVAL_MS = 1_000;

const log = (line: string): void => {
  console.error(`[f5-live-drill] ${line}`);
};

// ---------------------------------------------------------------------------
// Small typed exec + json helpers (every spawn is execFile, never a shell)
// ---------------------------------------------------------------------------

/** A resolved process run: exit code plus captured streams (the GhFn
 * philosophy — resolve with the code, let the caller fail closed). */
interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

const exec = (command: string, args: readonly string[], cwd?: string): Promise<ExecOutcome> =>
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

const failOutcome = (what: string, outcome: ExecOutcome): Error =>
  new Error(
    `${what} failed (exit ${String(outcome.code)}): ${outcome.stderr.trim() || outcome.stdout.trim()}`,
  );

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const parseJsonText = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** One `gh api` call returning a JSON object (GH_TOKEN rides the env; the
 * response never contains it). */
const ghApiObject = async (path: string): Promise<Record<string, unknown>> => {
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
const toMergeState = (raw: unknown): MergeState => {
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
interface DrillPr {
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
const makeCandidateFetcher = (
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
// the stream-json fixtures the subprocess driver parses (system init +
// result success carrying structured_output; see src/driver/subprocess and
// test/fixtures/fake-agent-cli.mjs for the shapes).
// ---------------------------------------------------------------------------

const FAKE_ROUTING_TABLE: RoutingTable = {
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
const agentScript = (baseBranch: string, headBranch: string, pr: number): string => `#!/bin/sh
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
cp .f5-ours seed.txt
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

const reportSummary = (report: ExecutionReport): string =>
  `merged=[${report.merged.map(String).join(',')}] retargeted=[${report.retargeted.map(String).join(',')}]` +
  ` stale=[${report.stale.map((entry) => String(entry.pr)).join(',')}]` +
  ` failed=[${report.failed.map((entry) => String(entry.pr)).join(',')}]` +
  ` blocked=[${report.blocked.map((entry) => String(entry.pr)).join(',')}]`;

// ---------------------------------------------------------------------------
// The drill
// ---------------------------------------------------------------------------

(LIVE ? describe : describe.skip)(
  'live merge-prs integration (dispatch-gated scratch repo)',
  () => {
    let scratchDir: string | undefined;

    beforeAll(() => {
      // The fake route's key (name-only in the table; the driver reads this
      // value at dispatch and the script ignores it). Also forbid git's
      // terminal prompt: a credential failure must fail loudly, never hang.
      process.env.F5_FAKE_KEY = 'dummy';
      process.env.GIT_TERMINAL_PROMPT = '0';
    });

    afterAll(async () => {
      // LOCAL cleanup only — the remote scratch repo is LEFT IN PLACE (the
      // run token has no delete_repo scope and the drill never attempts it).
      if (scratchDir !== undefined) {
        await rm(scratchDir, { recursive: true, force: true });
      }
    });

    test(
      'a 3-PR stack with one seeded conflict lands via merge commits only; no squash, no force',
      { timeout: DRILL_TIMEOUT_MS },
      async () => {
        // --- STEP 0: PREFLIGHT -------------------------------------------------
        if (process.env.GH_TOKEN === undefined || process.env.GH_TOKEN === '') {
          throw new Error('GH_TOKEN must be set for the live drill (it is asserted, never logged)');
        }
        const auth = await exec('gh', ['auth', 'status']);
        if (auth.code !== 0) throw failOutcome('gh auth status', auth);
        const identity = await exec('git', ['config', 'user.email']);
        if (identity.code !== 0 || identity.stdout.trim() === '') {
          throw new Error('git identity (user.email) is not configured — local commits need one');
        }
        log('step 0 preflight: GH_TOKEN present (not logged), gh auth ok, git identity ok');

        // --- STEP 1: SCRATCH REPO (never deleted) ------------------------------
        const repo = `${OWNER}/cq-scratch-f5-p3f-${Date.now().toString(36)}`;
        const created = await exec('gh', ['repo', 'create', repo, '--private']);
        if (created.code !== 0) throw failOutcome(`gh repo create ${repo}`, created);
        const repoUrl =
          created.stdout
            .split('\n')
            .map((line) => line.trim())
            .findLast((line) => line.includes('github.com')) ?? `https://github.com/${repo}`;
        log(`step 1 scratch repo created (LEFT IN PLACE for the owner to delete): ${repoUrl}`);
        // The effects layer's gh argv (`gh pr merge <n> --merge`,
        // `gh pr edit <n> --base <b>`) carries no repo and spawns without a
        // repo cwd — GH_REPO is the only honest way to aim them at the
        // scratch repo (and never at this repository).
        process.env.GH_REPO = repo;

        // --- STEP 2: LOCAL CLONE + SEED ----------------------------------------
        scratchDir = await mkdtemp(join(tmpdir(), 'f5-live-drill-'));
        const cloneDir = join(scratchDir, 'clone');
        // The credential helper list is RESET (the empty value) so ONLY gh's
        // helper answers: the token rides GH_TOKEN at push time, never argv.
        const cloned = await exec('git', [
          '-c',
          'credential.helper=',
          '-c',
          'credential.helper=!gh auth git-credential',
          'clone',
          `https://github.com/${repo}.git`,
          cloneDir,
        ]);
        if (cloned.code !== 0) throw failOutcome('git clone (scratch)', cloned);
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
        for (const [key, value] of [
          ['user.email', 'f5-live-drill@example.invalid'],
          ['user.name', 'F5 Live Drill'],
          ['credential.helper', '!gh auth git-credential'],
        ] as const) {
          const configured = await gitInClone(['config', key, value]);
          if (configured.code !== 0) throw failOutcome(`git config ${key}`, configured);
        }
        // The scratch repo is EMPTY at clone time, so the clone's HEAD is
        // UNBORN and its name is whatever the local init default (or the
        // transport) chose — never assume 'main'. Pin the unborn HEAD to
        // the trunk name BEFORE the first commit so every later ref name
        // in the drill is well-defined.
        const pinnedHead = await gitInClone(['symbolic-ref', 'HEAD', 'refs/heads/main']);
        if (pinnedHead.code !== 0)
          throw failOutcome('git symbolic-ref HEAD refs/heads/main', pinnedHead);
        await writeInClone('README.md', '# F5 live drill scratch\n');
        await writeInClone('seed.txt', SEED_BASE);
        const seededAdd = await gitInClone(['add', 'README.md', 'seed.txt']);
        if (seededAdd.code !== 0) throw failOutcome('git add (seed)', seededAdd);
        const seededCommit = await gitInClone(['commit', '-m', 'seed: readme + seed.txt']);
        if (seededCommit.code !== 0) throw failOutcome('git commit (seed)', seededCommit);
        const pushedSeed = await gitInClone(['push', 'origin', 'main']);
        if (pushedSeed.code !== 0) throw failOutcome('git push origin main (seed)', pushedSeed);
        const initialMainSha = await revParse('HEAD');
        log(`step 2 seeded main at ${initialMainSha}`);

        // --- STEP 3: STACK + SEED CONFLICT -------------------------------------
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
          if (match === null)
            throw new Error(`gh pr create printed no pull URL: ${outcome.stdout}`);
          return Number(match[1]);
        };
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

        const shaA = await commitBranchSeed(
          BRANCH_A,
          'main',
          'alpha-A',
          'a: reword the alpha line to alpha-A',
        );
        const prA = await createPr('main', BRANCH_A, 'F5 drill: a (root)');
        log(`step 3 pr ${String(prA)} (${BRANCH_A} -> main) opened at head ${shaA}`);

        const preASha = await revParse(`${BRANCH_A}~1`);
        expect(preASha, 'f5-b must branch from the SAME pre-a commit f5-a grew from').toBe(
          initialMainSha,
        );
        const shaB = await commitBranchSeed(
          BRANCH_B,
          preASha,
          'alpha-B',
          'b: reword the alpha line to alpha-B (seeded conflict with a)',
        );
        const prB = await createPr(
          BRANCH_A,
          BRANCH_B,
          'F5 drill: b (stacks on a — seeded conflict)',
        );
        log(`step 3 pr ${String(prB)} (${BRANCH_B} -> ${BRANCH_A}) opened at head ${shaB}`);

        const checkoutC = await gitInClone(['checkout', '-b', BRANCH_C, BRANCH_B]);
        if (checkoutC.code !== 0) throw failOutcome(`git checkout -b ${BRANCH_C}`, checkoutC);
        await writeInClone('c.txt', 'c: an additive, conflict-free rung\n');
        const addC = await gitInClone(['add', 'c.txt']);
        if (addC.code !== 0) throw failOutcome('git add (c.txt)', addC);
        const commitC = await gitInClone(['commit', '-m', 'c: add c.txt']);
        if (commitC.code !== 0) throw failOutcome(`git commit (${BRANCH_C})`, commitC);
        const pushC = await gitInClone(['push', 'origin', BRANCH_C]);
        if (pushC.code !== 0) throw failOutcome(`git push origin ${BRANCH_C}`, pushC);
        const shaC = await revParse(BRANCH_C);
        const prC = await createPr(BRANCH_B, BRANCH_C, 'F5 drill: c (stacks on b)');
        log(`step 3 pr ${String(prC)} (${BRANCH_C} -> ${BRANCH_B}) opened at head ${shaC}`);

        const drillPrs: DrillPr[] = [
          { number: prA, headBranch: BRANCH_A },
          { number: prB, headBranch: BRANCH_B },
          { number: prC, headBranch: BRANCH_C },
        ];
        const drillPrNumbers = drillPrs.map((drillPr) => drillPr.number);

        // Mergeability computes asynchronously — poll PR 2 to DIRTY (the one
        // sanctioned sleep), then fail loudly if the seeded conflict is not
        // visible to the forge.
        let dirtySeen = false;
        let lastState = '';
        for (let attempt = 0; attempt < MERGEABILITY_POLL_ATTEMPTS && !dirtySeen; attempt += 1) {
          const pull = await ghApiObject(`repos/${repo}/pulls/${String(prB)}`);
          lastState = asString(pull['mergeable_state']);
          if (lastState === 'dirty') {
            dirtySeen = true;
            break;
          }
          await sleep(MERGEABILITY_POLL_INTERVAL_MS);
        }
        expect(
          dirtySeen,
          `pr ${String(prB)} never reported mergeable_state=dirty (last: ${lastState})`,
        ).toBe(true);
        log(`step 3 seeded conflict confirmed: pr ${String(prB)} mergeable_state=dirty`);

        // --- STEPS 4+5: CANDIDATE BUILDER + THE SCRIPTED CONFLICT AGENT --------
        // Every head sha ever observed per branch — the no-force evidence (7c).
        const observedHeads = new Map<string, Set<string>>();
        const observeHead = (branch: string, sha: string): void => {
          let seen = observedHeads.get(branch);
          if (seen === undefined) {
            seen = new Set<string>();
            observedHeads.set(branch, seen);
          }
          seen.add(sha);
        };
        for (const [branch, sha] of [
          [BRANCH_A, shaA],
          [BRANCH_B, shaB],
          [BRANCH_C, shaC],
        ] as const) {
          observeHead(branch, sha);
        }
        const fetchCandidates = makeCandidateFetcher(repo, drillPrs, observeHead);

        const agentDir = join(scratchDir, 'agent');
        await mkdir(agentDir, { recursive: true });
        const agentPath = join(agentDir, 'f5-fake-agent.sh');
        await writeFile(agentPath, agentScript(BRANCH_A, BRANCH_B, prB), 'utf8');
        await chmod(agentPath, 0o755);
        const sessionsDir = join(scratchDir, 'sessions');
        await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
        const driver = new SubprocessDriver({
          binary: agentPath,
          outputSchema: MergeConflictDecisionSchema,
          sessionsDir,
          routingTable: FAKE_ROUTING_TABLE,
        });
        const resolveOp = makeResolveConflictOp({ driver, sessionsDir });
        log('step 5 scripted conflict agent + SubprocessDriver wired (fake f5fake route)');

        // --- STEP 6: RUN THE PLAN TO CONVERGENCE --------------------------------
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

        const collectedRetargeted = new Set<number>();
        let runs = 0;
        let converged = false;
        for (let iteration = 0; iteration < 8 && !converged; iteration += 1) {
          converged = await allThreeMerged();
          if (converged) break;
          runs += 1;
          const candidates = await fetchCandidates();
          const outcome = await runMergePrs(
            {
              baseBranch: 'main',
              repoRoot: cloneDir,
              prs: candidates,
              resolveConcurrency: 2,
              nowMs: Date.now(),
              modelSpec: { model: 'f5fake-model', provider: 'f5fake' },
              sessionsDir,
            },
            {
              effects: realMergeEffects({ repoRoot: cloneDir }),
              resolve: resolveOp,
              refetch: () => fetchCandidates(),
            },
          );
          log(`run ${String(runs)} firstPass ${reportSummary(outcome.firstPass)}`);
          if (outcome.secondPass !== null) {
            log(`run ${String(runs)} secondPass ${reportSummary(outcome.secondPass)}`);
          }
          for (const resolution of outcome.resolutions) {
            log(
              `run ${String(runs)} resolution pr ${String(resolution.pr)}: ${resolution.decision} (${resolution.summary})`,
            );
          }
          if (outcome.needsHuman.length > 0) {
            log(`run ${String(runs)} needsHuman ${JSON.stringify(outcome.needsHuman)}`);
          }
          for (const report of outcome.secondPass === null
            ? [outcome.firstPass]
            : [outcome.firstPass, outcome.secondPass]) {
            for (const pr of report.retargeted) collectedRetargeted.add(pr);
          }
        }
        log(`step 6 convergence after ${String(runs)} run(s)`);

        // --- STEP 7: THE ASSERTIONS ---------------------------------------------
        const fetched = await gitOk('git fetch --prune origin', ['fetch', '--prune', 'origin']);

        // (a) ALL THREE PRS MERGED — re-read the final live state once for the
        // rest of the assertions.
        const finals = new Map<number, Record<string, unknown>>();
        for (const drillPr of drillPrs) {
          finals.set(
            drillPr.number,
            await ghApiObject(`repos/${repo}/pulls/${String(drillPr.number)}`),
          );
        }
        const finalPull = (pr: number): Record<string, unknown> => {
          const pull = finals.get(pr);
          if (pull === undefined)
            throw new Error(`no final pull state recorded for pr ${String(pr)}`);
          return pull;
        };
        for (const pr of drillPrNumbers) {
          const pull = finalPull(pr);
          expect(pull['merged'], `pr ${String(pr)} must be merged`).toBe(true);
          expect(asString(pull['state']), `pr ${String(pr)} must be closed`).toBe('closed');
        }
        log(`step 7a all three prs merged: ${drillPrNumbers.map(String).join(', ')}`);

        // (b) MERGE COMMITS ONLY on main: the commits MADE ONTO main by the
        // drill — main's FIRST-PARENT chain since the seed (a full rev-list
        // walk would also list the PR branch commits, which legitimately
        // ride the merge commits as second parents) — must ALL be merge
        // commits: `rev-list --first-parent --no-merges` over the range is
        // empty, the --first-parent --merges count equals the whole
        // first-parent range, and every first-parent commit has >= 2
        // parents. A squash, rebase, or fast-forward landing would put a
        // non-merge commit on this chain.
        const drillRange = [`^${initialMainSha}`, 'origin/main'];
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
        const allDrillCommits = await revList([]);
        const mergeCommits = await revList(['--merges']);
        const nonMergeCommits = await revList(['--no-merges']);
        expect(
          nonMergeCommits,
          'every commit made onto origin/main must be a merge commit — squash/fast-forward landings would appear here',
        ).toEqual([]);
        expect(mergeCommits.length, 'rev-list --merges must equal the drill commit count').toBe(
          allDrillCommits.length,
        );
        expect(
          allDrillCommits.length,
          'main must carry the root merge and the stacked rung merge (the tail rung merges below main in the expected flow)',
        ).toBeGreaterThanOrEqual(2);
        for (const sha of allDrillCommits) {
          const parents = (
            await gitOk(`rev-list --parents ${sha}`, ['rev-list', '--parents', '-n', '1', sha])
          ).split(/\s+/);
          expect(
            parents.length - 1,
            `commit ${sha} on main must have >= 2 parents`,
          ).toBeGreaterThanOrEqual(2);
        }
        log(
          `step 7b main gained ${String(allDrillCommits.length)} drill commit(s), all merge commits`,
        );

        // (c) NO SQUASH: each PR's merge_commit_sha has the PR head as an
        // ancestor (squashed content severs that edge). NO FORCE: every head
        // sha EVER observed for each branch is still an ancestor of the
        // branch's final tip — a force-push would have rewritten history out
        // from under an earlier observed sha.
        for (const drillPr of drillPrs) {
          const pull = finalPull(drillPr.number);
          const mergeSha = asString(pull['merge_commit_sha']);
          expect(mergeSha, `pr ${String(drillPr.number)} merge_commit_sha missing`).not.toBe('');
          const seen = observedHeads.get(drillPr.headBranch);
          const lastObserved = seen === undefined ? undefined : [...seen].at(-1);
          expect(
            lastObserved,
            `no observed head sha for branch ${drillPr.headBranch}`,
          ).toBeDefined();
          const ancestry = await gitInClone([
            'merge-base',
            '--is-ancestor',
            lastObserved ?? '',
            mergeSha,
          ]);
          expect(
            ancestry.code,
            `pr ${String(drillPr.number)}: head ${String(lastObserved)} must be an ancestor of merge commit ${mergeSha} (a squash would not be)`,
          ).toBe(0);
        }
        log('step 7c no squash: every PR head is an ancestor of its merge commit');
        expect(
          fetched,
          'git fetch --prune origin must succeed before the tip checks',
        ).toBeDefined();
        for (const branch of DRILL_BRANCHES) {
          const tip = await revParse(`origin/${branch}`);
          const seen = observedHeads.get(branch);
          if (seen !== undefined) {
            for (const earlier of seen) {
              const contained = await gitInClone(['merge-base', '--is-ancestor', earlier, tip]);
              expect(
                contained.code,
                `branch ${branch}: observed sha ${earlier} is no longer an ancestor of final tip ${tip} — history was rewritten (force)`,
              ).toBe(0);
            }
          }
        }
        log('step 7c no force: every observed head sha survives in its branch final history');

        // (d) DESCENDANTS RETARGETED: the closed-ancestor retarget-self action
        // must have provably run somewhere in the collected outcomes.
        expect(
          collectedRetargeted.size,
          'at least one retarget-self action must have run (a closed rung re-anchors its child onto the trunk)',
        ).toBeGreaterThanOrEqual(1);
        for (const pr of collectedRetargeted) {
          expect(
            drillPrNumbers.includes(pr),
            `retargeted pr ${String(pr)} is not one of the drill's prs`,
          ).toBe(true);
        }
        log(
          `step 7d retargeted across outcomes: ${[...collectedRetargeted]
            .sort((a, b) => a - b)
            .map(String)
            .join(', ')}`,
        );
        // The mission's 7d base assertion, as written: at merge time PR 3's
        // base is main or a — NEVER the closed b. The gated overlay pins the
        // flow to the retarget path (pr 3 is never eligible while pr 2 is
        // open, so it can only merge after the retarget, onto the trunk);
        // the merged_at ordering holds with it.
        const prThreeBase = asString(asRecord(finalPull(prC)['base'])['ref']);
        const prThreeMergedAt = Date.parse(asString(finalPull(prC)['merged_at']));
        const prTwoMergedAt = Date.parse(asString(finalPull(prB)['merged_at']));
        expect(
          prThreeBase === 'main' || prThreeBase === BRANCH_A,
          `pr 3's base at merge time must be main or ${BRANCH_A} — never the closed rung ${BRANCH_B} (got ${prThreeBase})`,
        ).toBe(true);
        expect(
          prThreeMergedAt >= prTwoMergedAt,
          'pr 3 landed only after its rung (pr 2) had merged',
        ).toBe(true);
        log(`step 7d pr 3 base at merge time: ${prThreeBase}`);
        // The stack's tail content and BOTH sides of the union resolution
        // must have reached the trunk through merge commits.
        const cOnMain = await gitInClone(['show', 'origin/main:c.txt']);
        expect(
          cOnMain.code,
          'c.txt must exist on origin/main — the stacked tail content landed',
        ).toBe(0);
        const seedOnMain = await gitOk('git show origin/main:seed.txt', [
          'show',
          'origin/main:seed.txt',
        ]);
        expect(seedOnMain, 'the union resolution must preserve BOTH sides (alpha-A)').toContain(
          'alpha-A',
        );
        expect(seedOnMain, 'the union resolution must preserve BOTH sides (alpha-B)').toContain(
          'alpha-B',
        );
        expect(seedOnMain, 'the untouched beta line must survive the union').toContain('beta');
        log(
          'step 7d trunk content verified: c.txt present; seed.txt carries alpha-A + alpha-B + beta',
        );

        // --- STEP 8: EVIDENCE ----------------------------------------------------
        const evidence = {
          scratchRepo: repoUrl,
          prs: drillPrNumbers.map((pr) => ({
            n: pr,
            mergeCommitSha: asString(finalPull(pr)['merge_commit_sha']),
          })),
          runs,
          retargeted: [...collectedRetargeted].sort((a, b) => a - b),
          seedConflict: `PR ${String(prB)} dirty`,
        };
        log(`DRILL SUMMARY ${JSON.stringify(evidence)}`);
      },
    );
  },
);
