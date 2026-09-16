// review-live helpers — E5 (goal E5; ws-e acceptance: the live, dispatch-
// gated e2e of the shipped review loop). Everything here is FIXTURE
// machinery for test/e2e/review/live.test.ts: a scratch GitHub repo seeded
// through the real `gh` CLI, the fake fixer agent the SubprocessDriver
// spawns as `node <script>`, and a recording gh proxy for the run-2
// zero-mutation assertion. Inert at import: no I/O and no env reads at
// module scope — the live test only calls into this module from inside its
// LIVE_GH-gated beforeAll.
//
// THE SINGLE-IDENTITY DEVIATION (recorded, ws-e): the seeded review thread
// is created through the REST API under the SAME token identity that
// authored the PR — a stand-in reviewer, not a second account (the drill
// holds exactly one GitHub identity).
// {@link REVIEWER_ROLE_SIMULATED} is the machine-readable fixture flag;
// docs/drills/2026-09-e5.md carries the human-readable deviation record.
// What the drill still proves is the market-gap scenario: the loop CLOSES
// (reply + resolve) with that arbitrary non-privileged reviewer identity,
// riding plain gh REST/GraphQL — no admin surface anywhere.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoutingTable } from '../../../src/driver/subprocess/routing.js';
import { ghJson, makeGhRunner } from '../../../src/ops/review/gh.js';
import type { GhFn } from '../../../src/ops/review/gh.js';

/**
 * The recorded single-identity deviation flag (module doc): true means the
 * seeded reviewer threads were authored by the same identity as the PR, via
 * the REST API, instead of a second privileged or unprivileged account.
 */
export const REVIEWER_ROLE_SIMULATED = true;

/** Host env var the fixture routing table names as the fake endpoint's key. */
export const FIXTURE_KEY_ENV = 'E5_FIXTURE_FAKE_KEY';

/** The routing endpoint the fake agent's SubprocessDriver resolves (provider handle). */
export const FIXTURE_ENDPOINT = 'e5-fake-fixer';

/** The model id on the fixture endpoint's allowlist (never served — no endpoint is contacted). */
export const FIXTURE_MODEL = 'e5-fake-fixer';

/**
 * Prefix of the RUN-SCOPED PR head branch: `e5-fixtures-<runId>-<Date.now(36)>`.
 * Unique per drill invocation — same or different E5_RUN_ID — so a fresh run's
 * seed push can never collide (non-fast-forward) with a left-behind branch.
 */
export const HEAD_REF_PREFIX = 'e5-fixtures';

/** The file the seeded thread anchors on, its marker line, and the fixed spelling. */
export const MARKER_FILE = 'reviewed.txt';
export const MARKER_LINE = 3;
export const MARKER_TEXT = 'typo-target: applee';
export const FIXED_TEXT = 'typo-target: apple';

/** The fake agent's summary — the loop composes the reply body from it. */
export const FAKE_SUMMARY = 'fixed the fruit';

/** Everything the live test needs to know about the seeded scratch repo. */
export interface LiveScratchRepo {
  /** Repository owner (the authenticated user's login). */
  owner: string;
  /** Repository name (`cq-scratch-e5-<runId>`). */
  repo: string;
  /** The repo as "owner/name" (gh -R / REST paths). */
  fullName: string;
  /** The repo's web URL (printed as the drill-doc pointer). */
  repoUrl: string;
  /** The tmp root holding the clone, worktrees, registry, and dispatch log. */
  root: string;
  /** The local clone (the loop's repoRoot). */
  cloneDir: string;
  /** The repo's default branch (the PR base). */
  defaultBranch: string;
  /** The run-scoped seeded PR head branch (origin truth the loop's worktree/push rides). */
  headRefName: string;
  /** The seeded head sha (the review comment's commit anchor). */
  headSha: string;
  /** The opened pull request's number. */
  pr: number;
  /** The seeded thread ROOT comment's REST id (the reply anchor). */
  threadRestId: number;
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const REVIEWED_TXT = [
  'reviewed fixture line one',
  'reviewed fixture line two',
  MARKER_TEXT,
  'reviewed fixture line four',
  '',
].join('\n');

const NOTES_MD = ['# E5 live drill fixture', '', 'Scratch content — safe to ignore.', ''].join(
  '\n',
);

const APP_JS = ['// fixture module', 'export const fruit = "apple";', ''].join('\n');

/**
 * The seeded review thread's body — an actionable misspelling report a real
 * arbitrary reviewer could have left on line {@link MARKER_LINE}.
 */
const THREAD_BODY = 'Fix the misspelled fruit on this line. It should read "apple".';

/** The GraphQL document the setup poll (and the test's fresh assert) reads. */
const THREADS_QUERY = `query ($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50) {
        nodes { id isResolved path comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

/** Minimal shape of the GraphQL reviewThreads payload the setup poll reads. */
interface ThreadsPayload {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            comments?: { nodes?: Array<{ databaseId?: unknown }> };
          }>;
        } | null;
      } | null;
    } | null;
  };
}

/**
 * Seed the E5 scratch repo end to end (the LIVE_GH-gated beforeAll's body):
 * create `cq-scratch-e5-<runId>` under the authenticated user (idempotent —
 * an already-exists response falls through to the GET below, which fails
 * loudly if the repo truly is not there), clone it via `gh repo clone`,
 * seed a per-run `e5-fixtures-<runId>-<Date.now(36)>` branch with the
 * fixture files (reviewed.txt carries {@link MARKER_TEXT} on line
 * {@link MARKER_LINE}), open a PR from it back to the default branch (each
 * invocation seeds its OWN branch + PR — the unique head makes an
 * already-exists PR impossible, so a create failure is fatal), and seed ONE
 * top-level review comment via REST — a review thread — anchored on the
 * marker line. Returns once the PR head is visible over REST and the thread
 * is visible over GraphQL (GitHub's two indexes converge eventually; the
 * loop's first fetch must see both or it would refuse on lag).
 *
 * The scratch repo is LEFT BEHIND on purpose (the run token holds no
 * delete_repo scope; the drill doc records the URL) — the tmp ROOT is the
 * caller's to clean up.
 */
export async function setupScratchRepo(opts: { runId: string }): Promise<LiveScratchRepo> {
  const gh = makeGhRunner();
  const runId = opts.runId.replace(/[^A-Za-z0-9._-]/g, '-');
  const repo = `cq-scratch-e5-${runId}`;

  const user = await ghJson<{ login?: unknown }>(gh, ['api', 'user']);
  if (typeof user.login !== 'string' || user.login === '') {
    throw new Error(`gh api user returned no usable login: ${JSON.stringify(user)}`);
  }
  const owner: string = user.login;
  const fullName = `${owner}/${repo}`;

  // Create idempotently: an already-exists failure (HTTP 409/422 → gh exit
  // nonzero) is fine — the GET below is the arbiter and throws GhError if
  // the repo is genuinely missing (bad token, bad scope).
  await gh([
    'api',
    '-X',
    'POST',
    'user/repos',
    '-f',
    `name=${repo}`,
    '-f',
    'private=true',
    '-f',
    'auto_init=true',
  ]);
  const created = await ghJson<{ default_branch?: unknown }>(gh, ['api', `repos/${fullName}`]);
  if (typeof created.default_branch !== 'string' || created.default_branch === '') {
    throw new Error(`gh api repos/${fullName} returned no default_branch`);
  }
  const defaultBranch: string = created.default_branch;

  const root = await mkdtemp(join(tmpdir(), 'cq-e5-live-'));
  const cloneDir = join(root, 'clone');
  const clone = await gh(['repo', 'clone', fullName, cloneDir]);
  if (clone.code !== 0) {
    throw new Error(`gh repo clone ${fullName} failed: ${clone.stderr}`);
  }
  const git = makeGhRunner({ bin: 'git' });
  const g = async (args: string[]): Promise<string> => {
    const result = await git(['-C', cloneDir, ...args]);
    if (result.code !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed (exit ${String(result.code)}): ${result.stderr}`,
      );
    }
    return result.stdout.trim();
  };
  // gh repo clone usually wires the credential helper already; pin it so the
  // loop's pushes authenticate in CI too (the helper reads GH_TOKEN).
  await g(['config', 'credential.helper', '!gh auth git-credential']);
  await g(['config', 'user.email', 'e5-live-fixture@example.invalid']);
  await g(['config', 'user.name', 'e5-live-fixture']);
  // The branch is RUN-SCOPED and unique: every invocation (same or different
  // run id) seeds a fresh branch/PR with zero cross-run coupling — the
  // left-behind repo accumulating one branch + PR + thread per run is by
  // design (it is left behind and deleted by the owner).
  const headRefName = `${HEAD_REF_PREFIX}-${runId}-${Date.now().toString(36)}`;
  await g(['checkout', '-b', headRefName]);
  await mkdir(join(cloneDir, 'src'), { recursive: true });
  await writeFile(join(cloneDir, MARKER_FILE), REVIEWED_TXT, 'utf8');
  await writeFile(join(cloneDir, 'notes.md'), NOTES_MD, 'utf8');
  await writeFile(join(cloneDir, 'src', 'app.js'), APP_JS, 'utf8');
  await g(['add', '-A']);
  await g(['commit', '-m', 'seed: review fixtures for the E5 live drill']);
  await g(['push', '-u', 'origin', headRefName]);
  const headSha = await g(['rev-parse', 'HEAD']);

  // Each run creates its OWN PR from its own unique branch: an
  // already-exists case cannot happen, so any create failure is fatal with
  // gh's own message (no reuse/fallback of a prior run's PR).
  const prCreate = await gh([
    'pr',
    'create',
    '-R',
    fullName,
    '--base',
    defaultBranch,
    '--head',
    headRefName,
    '--title',
    'E5 live drill: review fixtures',
    '--body',
    'Scratch PR for the live review-loop drill. Safe to close; the repo is left behind.',
  ]);
  if (prCreate.code !== 0) {
    throw new Error(`gh pr create failed: ${prCreate.stderr}`);
  }
  const match = /\/pull\/(\d+)/.exec(prCreate.stdout);
  if (match === null) {
    throw new Error(`gh pr create printed no PR URL: ${prCreate.stdout}`);
  }
  const pr = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error(`unusable PR number ${String(pr)}`);
  }

  // Seed ONE review thread: a top-level PR review comment via REST, anchored
  // on the marker line at the seeded head. SAME-IDENTITY by construction —
  // the recorded deviation (REVIEWER_ROLE_SIMULATED).
  //
  // The I11-class argv trap — BOTH anchoring shapes were tried LIVE, and
  // the create-review-comment oneOf is not symmetric across them:
  //   - drill run 1 — raw `-f` strings: HTTP 422 "For 'properties/line',
  //     \"3\" is not an integer" (`-f` never coerces);
  //   - drill run 3 — typed `-F line=3` + `-f side=RIGHT` + `-f
  //     subject_type=line`: HTTP 422 again, a DIFFERENT arm mismatch —
  //     "position wasn't supplied / in_reply_to wasn't supplied /
  //     subject_type is not a permitted key / line is not a permitted key"
  //     (the line+side+subject_type shape 422s on this endpoint,
  //     2026-09-16: the oneOf matched the REPLY arm, where line and
  //     subject_type are forbidden keys).
  // The shape used here is the LEGACY `position` anchor: numerics ride `-F`
  // (gh's typed coercion — the same flag semantics fetchReviewState
  // documents for `-F pr=`), strings stay raw `-f`. POSITION SEMANTICS:
  // `position` counts diff lines AFTER the first @@ hunk header of the
  // file's diff. Our fixtures PR adds reviewed.txt FRESH — a single hunk
  // starting at the file top (`@@ -0,0 +1,4 @@`, every file line a `+`
  // line) — so position equals the FILE LINE NUMBER: the target line is 3
  // (MARKER_LINE), hence position=3.
  const comment = await ghJson<{ id?: unknown }>(gh, [
    'api',
    '-X',
    'POST',
    `repos/${fullName}/pulls/${String(pr)}/comments`,
    '-f',
    `body=${THREAD_BODY}`,
    '-F',
    `commit_id=${headSha}`,
    '-f',
    `path=${MARKER_FILE}`,
    '-F',
    `position=${String(MARKER_LINE)}`,
  ]);
  if (typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id)) {
    throw new Error(`the seeded review comment returned no usable id: ${JSON.stringify(comment)}`);
  }
  const threadRestId: number = comment.id;

  // Wait for GitHub's two indexes to converge: the PR head over REST and the
  // thread over GraphQL (the loop's fetchReviewState reads BOTH and refuses
  // on lag — the fixture must be settled before the loop runs). Bounded.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const head = await ghJson<{ head?: { sha?: unknown } | null }>(gh, [
      'api',
      `repos/${fullName}/pulls/${String(pr)}`,
    ]);
    const threads = await ghJson<ThreadsPayload>(gh, [
      'api',
      'graphql',
      '-f',
      `query=${THREADS_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${repo}`,
      '-F',
      `pr=${pr}`,
    ]);
    const headVisible = head.head?.sha === headSha;
    const nodes = threads.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    const threadVisible = nodes.some(
      (node) => (node.comments?.nodes?.[0]?.databaseId ?? null) === threadRestId,
    );
    if (headVisible && threadVisible) {
      return {
        owner,
        repo,
        fullName,
        repoUrl: `https://github.com/${fullName}`,
        root,
        cloneDir,
        defaultBranch,
        headRefName,
        headSha,
        pr,
        threadRestId,
      };
    }
    await sleep(2_000);
  }
  throw new Error(
    `the seeded thread/PR head never became visible within the setup bound (REST head sha + GraphQL reviewThreads) — fixture setup failed`,
  );
}

/**
 * Write the fake fixer agent (an executable node script) into `root` and
 * return its path. Spawned by the SubprocessDriver as `node <path>` with
 * cwd = the PR worktree (worktreeFixDriver's session record) and the fixer
 * prompt on STDIN (buildArgs `-p` print mode — the prompt rides stdin, not
 * argv). It performs the fix IN ITS CWD: rewrites the marker, `git add -A`,
 * commits with the review item id IN THE SUBJECT (the loop's per-item
 * attribution rule), and answers ONE stream-json `result` line whose
 * structured_output is the fix contract {"changed","summary","commits"}.
 * The stream-json envelope is what the driver folds: a bare contract JSON
 * line on stdout would be narration and an 'error' verdict, never a fix.
 */
export async function writeFakeFixerAgent(root: string): Promise<string> {
  const path = join(root, 'e5-fake-fixer.mjs');
  const script = `// E5 fake fixer agent — GENERATED by test/e2e/helpers/review-live.ts (do not edit by hand).
// Spawned as \`node <this file>\`: cwd = the PR worktree, prompt on stdin.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let prompt = '';
try {
  prompt = readFileSync(0, 'utf8');
} catch {
  prompt = '';
}
const match = /^Review item: (.+)$/m.exec(prompt);
const itemId = match === null ? null : match[1].trim();
const emit = (changed, summary, commits) => {
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'e5-fake-fixer',
    usage: { input_tokens: 1, output_tokens: 1 },
    structured_output: { changed, summary, commits },
  }));
};
const git = (args) =>
  execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const file = join(process.cwd(), '${MARKER_FILE}');
let content;
try {
  content = readFileSync(file, 'utf8');
} catch {
  emit(false, '${MARKER_FILE} is not in the workspace; nothing changed', []);
  process.exit(0);
}
if (!content.includes('${MARKER_TEXT}')) {
  emit(false, 'the misspelled marker is already gone; nothing to fix', []);
  process.exit(0);
}
if (itemId === null) {
  emit(false, 'no Review item id line in the prompt; refusing to commit without attribution', []);
  process.exit(0);
}
writeFileSync(file, content.split('${MARKER_TEXT}').join('${FIXED_TEXT}'));
git(['add', '-A']);
git(['-c', 'user.name=e5-fake-fixer', '-c', 'user.email=e5-fake-fixer@example.invalid',
  'commit', '-m', 'fix ' + itemId + ': apple']);
const sha = git(['rev-parse', 'HEAD']);
emit(true, '${FAKE_SUMMARY}', [sha]);
`;
  await writeFile(path, script, { encoding: 'utf8', mode: 0o755 });
  return path;
}

/**
 * The fixture routing table for the fake agent's SubprocessDriver: routing
 * is pre-dispatch validation only here — the child is `node <script>`, no
 * endpoint is contacted, but routeFor must resolve and the route's key env
 * var ({@link FIXTURE_KEY_ENV}) must be set (the live test's beforeAll sets
 * a dummy value; never a secret).
 */
export const fixtureRoutingTable = (): RoutingTable => ({
  endpoints: {
    [FIXTURE_ENDPOINT]: {
      baseUrlEnv: 'E5_FIXTURE_FAKE_BASE_URL',
      baseUrlDefault: 'http://127.0.0.1:9',
      keyEnv: FIXTURE_KEY_ENV,
      models: [FIXTURE_MODEL],
      notes: 'E5 live-drill fixture route — the child is node; no endpoint is ever contacted',
    },
  },
});

/**
 * A gh proxy that records every argv it sees (the run-2 zero-mutation
 * evidence) and delegates to `run`.
 */
export const recordingGh = (run: GhFn, log: string[][]): GhFn => {
  return async (args) => {
    log.push(args);
    return run(args);
  };
};

/**
 * Gh mutation argv: a REST write (every write the review family composes
 * rides `-X POST`) or the resolveReviewThread mutation document (the only
 * GraphQL write in the family — every read document is a `query`, and this
 * substring appears in no shipped read). Mirrors the shipped smoke test's
 * isGhMutation predicate.
 */
export const isMutatingGhArgv = (args: string[]): boolean => {
  if (args.includes('-X')) {
    return true;
  }
  const query = args.find((arg) => arg.startsWith('query='));
  return query !== undefined && query.includes('resolveReviewThread');
};
