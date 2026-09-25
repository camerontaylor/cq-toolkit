// ratchet-propose — the PRIVILEGED half of baseline-tightening proposals
// (ADR-0004 D-B "ratchet-propose"; W1.7). For each committed baseline a
// measurement TIGHTENS, it proposes the baseline change as exactly ONE pull
// request by invoking the H3 op createProposeBaselineUpdate with a REAL
// BaselinePrEffects implementation over gh CLI + git.
//
// TWO-JOB SPLIT: measurement no longer happens here. The credential-free
// `ratchet-propose-measure` workflow installs, runs the suite and recomputes
// typecheck-count, then uploads a numbers-only artifact. The privileged
// `ratchet-propose` workflow (`workflow_run`, environment `automation`)
// builds the TRUSTED toolkit from the default branch (`npm ci
// --ignore-scripts && npm run build`), downloads that artifact and runs
//
//   node scripts/ratchet-propose.mjs --measurement=<path>
//
// This script runs no tests, no tsc and nothing from the repo beyond the
// prebuilt dist/ engine. Usage: exactly one `--measurement=<path>`; anything
// else fails. The token gate runs FIRST, so a tokenless invocation is a
// green no-op (exit 0) whatever its arguments.
//
// ARTIFACT AS DATA: the measurement file is untrusted (the leg that wrote it
// executed the repo's tests). It is opened without following symlinks, must
// be a regular file of at most 64 KiB, and must match the strict schema in
// ratchet-lib's parseProposeMeasurement — `{schemaVersion: 1, metrics:
// {coverage?, typecheck-count?}}`, nothing else. Any violation fails the run
// BEFORE any git or gh call; an unknown metric is refused, never ignored. A
// metric absent from the artifact is noted and proposes nothing (I5). The
// coverage reading is rounded with the engine's roundCoveragePct (one
// decimal place) before any comparison. Worst case for a forged reading is a
// too-tight proposal — a visible PR judged by the same checks as any other.
//
// TARGET merge-queue: the proposal PR is opened against `merge-queue`, cut
// from the merge-queue tip and judged against THAT tip's committed
// baselines — not the checkout's (the checkout is main, the trust ref for
// the code that runs here). Proposals previously targeted main and so
// bypassed the merge-queue checks (ADR-0004 D-B). The tip is fetched, pinned
// to a SHA. A temporary worktree is created with --no-checkout: read-tree
// loads its index, while only canonical baseline blobs are materialized as
// data for the op. Proposal bytes enter the index through hash-object
// --no-filters + update-index, then write-tree/commit-tree/update-ref commit
// the index without a worktree scan. No head tree is checked out, and no
// head attribute can run a Git filter in the
// credential-bearing job. The worktree is removed in a finally, and ROOT
// is never switched (the dirty-tree guard on ROOT remains for local runs).
//
// ONE BRAIN: the driver only collects readings and enumerates committed
// baselines; every decision the op owns — grouping, the tighten gate,
// deterministic head branch, idempotent find-then-upsert, I5 skips — stays
// in the op. The effects below are the impure seam: they shell out to
// gh/git and never judge metrics.
//
// TOKEN DOCTRINE (proposeBaselineUpdate.ts header — load-bearing, unchanged):
// the effects authenticate with CQ_AUTOMATION_TOKEN and NEVER with
// GITHUB_TOKEN. GitHub suppresses workflow runs on PRs created with
// GITHUB_TOKEN, so a GITHUB_TOKEN-authored proposal would never run its
// required checks — an uncheckable ratchet bypass. When both vars are
// present we warn and proceed with CQ_AUTOMATION_TOKEN only. The token is
// never echoed (every subprocess result is redacted before printing) and
// never lands on disk or in git state: git authenticates through a temp
// GIT_ASKPASS script whose bytes contain no token (it echoes the token from
// ITS environment) and which is removed in a finally — no authed URL ever
// touches argv or .git/config.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PROPOSE_MEASUREMENT_MAX_BYTES,
  ROOT,
  fail,
  loadEngine,
  parseGhJson,
  parseProposeMeasurement,
  upsertProposalPr,
  withGitAskpass,
} from './ratchet-lib.mjs';

/** The proposal target branch (the op validates it as a git ref). */
const BASE = 'merge-queue';
const MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Hardened git prefix for EVERY git call. The subject cannot reinterpret
 * paths, start a pager/fsmonitor/hook/signer, or reshape quoted output.
 */
const GIT_HARDEN = [
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=true',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
];
const MEASUREMENT_FLAG = '--measurement=';

// ---- TOKEN DOCTRINE gate (FIRST: the workflow carries no job-level if; ----
// THIS script is the gate — a tokenless run is a green no-op, whatever its
// arguments, so a fork or a token-less environment never goes red).
const token = process.env.CQ_AUTOMATION_TOKEN;
if (!token || token === '') {
  console.error('ratchet-propose: CQ_AUTOMATION_TOKEN not set; skipping proposal');
  process.exit(0);
}

// ---- arguments: exactly one --measurement=<path> ----
const argv = process.argv.slice(2);
if (
  argv.length !== 1 ||
  argv[0].startsWith(MEASUREMENT_FLAG) === false ||
  argv[0].length === MEASUREMENT_FLAG.length
) {
  fail(
    `usage: ratchet-propose.mjs --measurement=<path> (got: ${
      argv.length === 0 ? 'no arguments' : argv.join(' ')
    })`,
  );
}
const measurementPath = argv[0].slice(MEASUREMENT_FLAG.length);

if (process.env.GITHUB_TOKEN) {
  console.error(
    'ratchet-propose: warning — GITHUB_TOKEN is also set. A PR authored with GITHUB_TOKEN ' +
      'suppresses workflow runs, so its required ratchet checks would never run (bypass). ' +
      'Proceeding with CQ_AUTOMATION_TOKEN only.',
  );
}
// The token's only legitimate consumers below are the git askpass env (set
// explicitly from the local const) and the gh subprocess env (GH_TOKEN) —
// so scrub it from the process env NOW: no other child may inherit it.
delete process.env.CQ_AUTOMATION_TOKEN;

/** Keep the askpass variables supplied by withGitAskpass, but refuse Git redirections. */
function safeGitEnv(source = process.env) {
  const env = { ...source };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_REPLACE_REF_BASE',
    'GIT_EXTERNAL_DIFF',
    'GIT_PAGER',
    'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
  ]) {
    delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

// ---- the measurement artifact: UNTRUSTED DATA, validated before any git/gh ----
/**
 * lstat (a symlink is refused, never followed), then open with O_NOFOLLOW and
 * re-check the OPENED file (closing the swap race), read at most cap+1 bytes,
 * decode as strict UTF-8, and hand the text to the strict schema check.
 */
function readMeasurement(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    fail(`cannot read the measurement '${path}': ${err.message}`);
  }
  if (st.isFile() === false) {
    fail(`measurement '${path}' is not a regular file (symlinks and special files are refused)`);
  }
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    fail(`cannot open the measurement '${path}': ${err.message}`);
  }
  let text;
  let size;
  try {
    const opened = fstatSync(fd);
    if (opened.isFile() === false) {
      fail(`measurement '${path}' is not a regular file`);
    }
    if (opened.size > PROPOSE_MEASUREMENT_MAX_BYTES) {
      fail(
        `invalid measurement '${path}': ${opened.size} bytes — over the ` +
          `${PROPOSE_MEASUREMENT_MAX_BYTES}-byte cap`,
      );
    }
    const buf = Buffer.alloc(PROPOSE_MEASUREMENT_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n === buf.length) break; // grew past the cap mid-read — size check refuses it
    }
    size = n;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n));
    } catch {
      fail(`invalid measurement '${path}': not valid UTF-8`);
    }
  } finally {
    closeSync(fd);
  }
  try {
    return parseProposeMeasurement(text, size);
  } catch (err) {
    fail(`invalid measurement '${path}': ${err.message}`);
  }
}

const measured = readMeasurement(measurementPath);

// ---- worktree guard (ROOT is the trust-ref checkout; never switched) ----
// The effects run in a temporary worktree, but a dirty ROOT still means a
// local run over unreviewed state — refused, as before.
const status = spawnSync('git', [...GIT_HARDEN, 'status', '--porcelain'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: safeGitEnv(),
});
if (status.error || status.status !== 0) {
  fail(
    `cannot inspect the worktree: ${status.error ? status.error.message : `exit ${status.status}`}`,
  );
}
if ((status.stdout ?? '').trim() !== '') {
  fail('refusing to run on a dirty worktree — commit or stash first');
}

// ---- engine: the PREBUILT trusted dist/ (no adapters needed: no measuring here) ----
const engine = await loadEngine();

// ---- readings: ONLY from the artifact; coverage at one decimal place ----
const live = {
  coverage: measured.coverage === undefined ? null : engine.roundCoveragePct(measured.coverage),
  'typecheck-count': measured['typecheck-count'] === undefined ? null : measured['typecheck-count'],
};
for (const [metric, value] of Object.entries(live)) {
  if (value === null) {
    console.error(
      `ratchet-propose: note — the measurement carries no '${metric}' reading; ` +
        'nothing proposed from it (I5)',
    );
  }
}

// ---- subprocess plumbing (token redacted from every captured line) ----
const redact = (text) => String(text).split(token).join('[redacted]');
const ghEnv = () => {
  const e = { ...process.env, GH_TOKEN: token };
  delete e.GITHUB_TOKEN; // doctrine: CQ_AUTOMATION_TOKEN only, no silent fallback
  return e;
};

function runGit(args, { cwd = ROOT, allowFail = false, env = process.env } = {}) {
  const res = spawnSync('git', [...GIT_HARDEN, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: safeGitEnv(env),
  });
  if (!allowFail && (res.error || res.status !== 0)) {
    throw new Error(
      `git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]} failed: ${
        res.error ? res.error.message : `exit ${res.status}`
      }\n` + redact(`${res.stdout ?? ''}${res.stderr ?? ''}`).trim(),
    );
  }
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status,
    error: res.error,
  };
}

function runGh(args) {
  const res = spawnSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: ghEnv(),
    maxBuffer: MAX_BUFFER,
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `gh ${args[0]} failed: ${res.error ? res.error.message : `exit ${res.status}`}\n` +
        redact(`${res.stdout ?? ''}${res.stderr ?? ''}`).trim(),
    );
  }
  return res.stdout ?? '';
}

// `-c credential.helper=` clears any inherited helper so the askpass path is
// the only credential source (withGitAskpass: token in the child ENV only).
const CRED = ['-c', 'credential.helper='];

// ---- pin the merge-queue tip: the proposal's base AND its comparison point ----
let baseSha;
try {
  baseSha = await withGitAskpass(token, async (gitEnv) => {
    runGit([...CRED, 'fetch', 'origin', `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`], {
      env: gitEnv,
    });
    return runGit([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${BASE}^{commit}`,
    ]).stdout.trim();
  });
} catch (err) {
  fail(`cannot fetch origin/${BASE}: ${err.message}`);
}
if (/^[0-9a-f]{40,64}$/.test(baseSha ?? '') === false) {
  fail(`origin/${BASE} did not resolve to a commit`);
}

// ---- committed baselines AT THE MERGE-QUEUE TIP, parsed by the engine ----
const committed = [];
const baselineBlobs = [];
const tree = runGit(['ls-tree', '-z', baseSha, '--', 'baselines/']).stdout;
for (const entry of tree
  .split('\0')
  .filter((e) => e !== '')
  .sort()) {
  const tab = entry.indexOf('\t');
  const [mode, type] = entry.slice(0, tab).split(' ');
  const path = entry.slice(tab + 1);
  if (path.endsWith('.json') === false) continue;
  // The definition manifest, not a baseline.
  if (path === 'baselines/ratchets.json') continue;
  // Mirror the engine's leaf discipline: only a regular blob is evidence
  // (a symlink/submodule/subtree entry is refused, never followed).
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
    console.error(`ratchet-propose: note — ${path} is not a regular file at ${BASE}; skipped`);
    continue;
  }
  let parsed;
  let content;
  try {
    content = runGit(['cat-file', 'blob', `${baseSha}:${path}`]).stdout;
    parsed = engine.parseBaseline(content);
  } catch (err) {
    // A corrupt baseline yields no improvement (the ratchet CHECK is the
    // enforcement point; this script only proposes tightenings).
    console.error(`ratchet-propose: note — ${path} is corrupt; skipped — ${err.message}`);
    continue;
  }
  // Only the canonical direct-child path is used by the proposal op. A
  // mismatched path cannot supply another ratchet's baseline, and cannot
  // become a filesystem path for materialization below.
  if (path !== engine.baselineRelPath(parsed.target, parsed.metric)) {
    console.error(`ratchet-propose: note — ${path} does not match its baseline identity; skipped`);
    continue;
  }
  committed.push(parsed);
  baselineBlobs.push({ path, content });
}

// ---- improvements: only genuine TIGHTENs, judged by the engine's own comparator ----
const improvements = [];
for (const b of committed) {
  const value = Object.hasOwn(live, b.metric) ? live[b.metric] : undefined;
  if (value === undefined) {
    console.error(
      `ratchet-propose: note — metric '${b.metric}' (${b.target}) has no measured reading wired; skipped`,
    );
    continue;
  }
  if (value === null) continue; // note already emitted above
  const committedValue = b.metric === 'coverage' ? engine.roundCoveragePct(b.value) : b.value;
  if (engine.tightens(committedValue, value, b.direction)) {
    improvements.push({ target: b.target, metric: b.metric, value });
  } else {
    console.error(
      `ratchet-propose: ${b.target}/${b.metric} ${b.value} → ${value} is not a tightening ` +
        `(${b.direction}) against ${BASE} — nothing to propose`,
    );
  }
}

if (improvements.length === 0) {
  console.error('ratchet-propose: no tightening to propose');
  process.exit(0);
}

// `gh repo view --json nameWithOwner -q .nameWithOwner` prints a BARE
// STRING (the -q template's result) — parse it as exactly that, never as
// JSON (PR-105 round-1 finding: JSON.parse of it threw on every happy path).
const repoSlug = runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
if (repoSlug === '') {
  fail('gh returned an empty repo slug (nameWithOwner) — cannot address the remote');
}

// gh pr-list scoping + state recheck (review-debt #120): GitHub allows one
// head with MULTIPLE open PRs against different bases, so a head-only list
// can return the wrong PR — every list is scoped to (head, base), and a
// listed PR is RE-CHECKED via pr view before it is treated as open (a PR
// closed between the list and the edit still lists-editable; the state is
// the truth, and a non-open PR routes to the fresh-create path).
function listOpenProposalPrs(head, base) {
  const list = parseGhJson(
    runGh([
      'pr',
      'list',
      '--head',
      head,
      '--base',
      base,
      '--state',
      'open',
      '--json',
      'number,url',
    ]),
    [],
  );
  return list.filter((pr) => {
    // Full --json object (never -q: parseGhJson handles JSON, and -q prints
    // a bare string — review-debt #120's own PR-105 finding shape).
    const viewed = parseGhJson(runGh(['pr', 'view', String(pr.number), '--json', 'state']), {});
    return viewed?.state === 'OPEN';
  });
}

// ---- index-only merge-queue workspace: no head checkout or filters ----
const wsParent = mkdtempSync(join(tmpdir(), 'ratchet-propose-mq-'));
const ws = join(wsParent, 'ws');

/** BaselinePrEffects over gh CLI + git, operating inside `ws` (never ROOT). */
const effects = {
  async findOpenPrByHead(head) {
    const list = listOpenProposalPrs(head, BASE);
    return list.length > 0 ? { number: list[0].number, url: list[0].url } : null;
  },

  async commitAndUpsertPr({ head, base, title, body, commitMessage, files }) {
    const existing = listOpenProposalPrs(head, base);
    await withGitAskpass(token, async (gitEnv) => {
      // Missing-ref probes are ALLOWED to fail: `rev-parse --verify --quiet`
      // exits nonzero with empty stdout exactly when the ref does not exist —
      // the fresh case for the local head, and the FIRST-push case for the
      // remote-tracking ref (PR-105 round-2 finding 3).
      const localHead = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${head}`], {
        cwd: ws,
        allowFail: true,
      }).stdout.trim();
      if (localHead !== '') {
        // Reuse the local proposal branch without checking out its tree.
        runGit(['read-tree', localHead], { cwd: ws });
      } else {
        // Cut from the PINNED merge-queue tip, changing only a ref.
        runGit(['branch', head, baseSha], { cwd: ws });
      }
      const parent = localHead === '' ? baseSha : localHead;
      for (const f of files) {
        mkdirSync(dirname(join(ws, f.path)), { recursive: true });
        // Full renderBaseline bytes from the op — written verbatim.
        writeFileSync(join(ws, f.path), f.content);
        // git add would consult the head's .gitattributes from the index and
        // could run a configured clean filter. Hash the bytes as-is instead.
        const oid = runGit(['hash-object', '--no-filters', '-w', '--', f.path], {
          cwd: ws,
        }).stdout.trim();
        if (/^[0-9a-f]{40,64}$/.test(oid) === false) {
          throw new Error(`git hash-object returned no blob oid for ${f.path}`);
        }
        runGit(['update-index', '--add', '--cacheinfo', `100644,${oid},${f.path}`], {
          cwd: ws,
        });
      }
      // write-tree and commit-tree consume only the index/git objects. A
      // regular `git commit` may inspect the sparse worktree and consult
      // head-controlled .gitattributes, so it is deliberately not used.
      const treeOid = runGit(['write-tree'], { cwd: ws }).stdout.trim();
      const parentTree = runGit(['rev-parse', `${parent}^{tree}`], { cwd: ws }).stdout.trim();
      if (treeOid !== parentTree) {
        const commitOid = runGit(
          [
            '-c',
            'user.name=cq-toolkit ratchet',
            '-c',
            'user.email=ratchet@cq-toolkit.local',
            'commit-tree',
            treeOid,
            '-p',
            parent,
            '-m',
            commitMessage,
          ],
          { cwd: ws },
        ).stdout.trim();
        if (/^[0-9a-f]{40,64}$/.test(commitOid) === false) {
          throw new Error('git commit-tree returned no commit oid');
        }
        runGit(['update-ref', `refs/heads/${head}`, commitOid, parent], { cwd: ws });
      }
      // Lease push: a TRUE lease against the remote head when it exists
      // (idempotent re-push), a plain create when it does not (first push —
      // the tracking ref probe below fails on exactly that).
      runGit([...CRED, 'fetch', 'origin', `+refs/heads/${head}:refs/remotes/origin/${head}`], {
        cwd: ws,
        allowFail: true,
        env: gitEnv,
      });
      const expected = runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${head}`], {
        cwd: ws,
        allowFail: true,
      }).stdout.trim();
      if (expected !== '') {
        runGit(
          [
            ...CRED,
            'push',
            `--force-with-lease=refs/heads/${head}:${expected}`,
            'origin',
            `${head}:refs/heads/${head}`,
          ],
          { cwd: ws, env: gitEnv },
        );
      } else {
        runGit([...CRED, 'push', 'origin', `${head}:refs/heads/${head}`], {
          cwd: ws,
          env: gitEnv,
        });
      }
    });
    // Edit-then-create with recovery (upsertProposalPr): a PR found open can
    // be closed/merged between the list and the edit — a FAILED edit falls
    // back to a FRESH proposal PR (created: true, failure narrated at the
    // moment it happened), never an indeterminate surfacing.
    let fresh = null;
    const upsert = await upsertProposalPr({
      existing: existing.length > 0 ? { number: existing[0].number, url: existing[0].url } : null,
      edit: async () => {
        runGh(['pr', 'edit', String(existing[0].number), '--title', title, '--body', body]);
      },
      create: async () => {
        const out = runGh([
          'pr',
          'create',
          '--base',
          base,
          '--head',
          head,
          '--title',
          title,
          '--body',
          body,
        ]);
        const url =
          out
            .trim()
            .split('\n')
            .filter((l) => l.startsWith('http'))
            .pop() ?? null;
        const m = /\/pull\/(\d+)/.exec(url ?? '');
        fresh = { number: m === null ? null : Number(m[1]), url };
      },
    });
    if (upsert.recovered) {
      console.error(
        'ratchet-propose: note — outcome is a NEW proposal PR after the edit failure; ' +
          'the reported number/url are the fresh PR',
      );
    }
    if (upsert.created === false) {
      return { created: false, number: existing[0].number, url: existing[0].url };
    }
    return {
      created: true,
      number: fresh === null ? null : fresh.number,
      url: fresh === null ? null : fresh.url,
    };
  },
};

// ---- the op owns every remaining decision; ws has only baseline data ----
let result;
try {
  runGit(['worktree', 'add', '--no-checkout', '--detach', ws, baseSha]);
  // --no-checkout leaves the index empty. Populate it from the pinned tree
  // without touching the filesystem, so a later commit retains every file
  // outside the selected baseline updates.
  runGit(['read-tree', baseSha], { cwd: ws });
  for (const blob of baselineBlobs) {
    mkdirSync(dirname(join(ws, blob.path)), { recursive: true });
    writeFileSync(join(ws, blob.path), blob.content);
  }
  const propose = engine.createProposeBaselineUpdate(effects);
  result = await propose({ ws, base: BASE, improvements });
} catch (err) {
  console.error(`ratchet-propose: ${redact(err?.message ?? err)}`);
  result = null;
} finally {
  runGit(['worktree', 'remove', '--force', ws], { allowFail: true });
  rmSync(wsParent, { recursive: true, force: true });
  runGit(['worktree', 'prune'], { allowFail: true });
}
if (result === null) process.exit(1);
if (result.status !== 'ok') {
  console.error(
    `ratchet-propose: proposal ${result.status} — ${redact(result.error ?? result.detail)}`,
  );
  process.exit(1);
}
const outcome = result.value;
for (const s of outcome.skipped) {
  console.error(`ratchet-propose: skipped ${s.target}/${s.metric} — ${s.reason}`);
}
if (outcome.proposal === 'none') {
  console.error('ratchet-propose: no tightening to propose');
  process.exit(0);
}
for (const a of outcome.applied) {
  console.error(`ratchet-propose: applied ${a.path}: ${a.oldValue} → ${a.newValue}`);
}
console.error(
  `ratchet-propose: proposal ${outcome.proposal} — ${outcome.prUrl} (head ${outcome.head}, base ${BASE})`,
);
console.log(String(outcome.prUrl ?? ''));
