// ratchet-propose — the ratchet-propose.yml workhorse (lane H, goal H4
// slice 2). Post-merge, this driver measures the live ratchets and — for each
// committed baseline the measurement TIGHTENS — proposes the corresponding
// baseline change as exactly ONE pull request, by invoking the H3 op
// createProposeBaselineUpdate with a REAL BaselinePrEffects implementation
// over gh CLI + git.
//
// ONE BRAIN: the driver only collects readings (exactly like ratchet-check)
// and enumerates committed baselines; every decision the op owns — grouping,
// the tighten gate, deterministic head branch, idempotent find-then-upsert,
// I5 skips — stays in the op. The effects below are the impure seam the op's
// docs reserve for H4: they shell out to gh/git and never judge metrics.
//
// TOKEN DOCTRINE (proposeBaselineUpdate.ts header — load-bearing): the
// effects authenticate with CQ_AUTOMATION_TOKEN and NEVER with GITHUB_TOKEN.
// GitHub suppresses workflow runs on PRs created with GITHUB_TOKEN, so a
// GITHUB_TOKEN-authored proposal would never run the required I4 check (the
// diff monotonicity guard) — an uncheckable ratchet bypass. When both vars
// are present we warn and proceed with CQ_AUTOMATION_TOKEN only. The token
// is never echoed: every subprocess result is redacted before printing, and
// the authed push URL is written to .git/config only for the duration of the
// push (best-effort restored in a finally).
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ROOT,
  fail,
  loadEngine,
  runCoverageRaw,
  runTypecheckRaw,
  typecheckEvidence,
} from './ratchet-lib.mjs';

/** The proposal target branch (the op validates it as a git ref). */
const BASE = 'main';
const MAX_BUFFER = 64 * 1024 * 1024;

if (process.argv.length > 2) {
  fail(`unknown arguments: ${process.argv.slice(2).join(' ')} — this script takes none`);
}

// ---- TOKEN DOCTRINE gate (belt-and-braces: the workflow's job-level if ----
// guards the same condition; a manual workflow_dispatch run may not have it).
const token = process.env.CQ_AUTOMATION_TOKEN;
if (!token || token === '') {
  console.error('ratchet-propose: CQ_AUTOMATION_TOKEN not set; skipping proposal');
  process.exit(0);
}
if (process.env.GITHUB_TOKEN) {
  console.error(
    'ratchet-propose: warning — GITHUB_TOKEN is also set. A PR authored with GITHUB_TOKEN ' +
      'suppresses workflow runs, so its required I4 ratchet check would never run (I4 bypass). ' +
      'Proceeding with CQ_AUTOMATION_TOKEN only.',
  );
}

// ---- worktree guard: the effects checkout/commit/push THIS checkout ----
// A dirty tree would ride the branch switch into the proposal commit. CI
// checkouts are clean; a local run with a token is refused here.
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
if (status.error || status.status !== 0) {
  fail(`cannot inspect the worktree: ${status.error ? status.error.message : `exit ${status.status}`}`);
}
if ((status.stdout ?? '').trim() !== '') {
  fail(
    'refusing to run on a dirty worktree — the proposal effects switch branches and commit in ' +
      'this checkout; commit or stash first',
  );
}

// ---- engine (built fresh, adapters registered — same wiring as the check runners) ----
const engine = await loadEngine();
engine.registerAdapter(engine.adapters.typecheckCount);
engine.registerAdapter(engine.adapters.coverage);

// ---- live readings, exactly like ratchet-check's two legs ----
const tcRun = runTypecheckRaw();
const { evidence: tcEvidence, rawText: tcRaw } = typecheckEvidence(
  engine.adapters.typecheckCount,
  tcRun,
);
const tcValue =
  tcEvidence === null
    ? null
    : (engine.adapters.typecheckCount.extract(tcEvidence)?.value ?? null);
if (tcValue === null) {
  console.error(
    `ratchet-propose: note — typecheck-count has no usable reading ` +
      `(exit ${tcRun.status}); non-passing evidence, nothing proposed from it (I5). ` +
      `Output tail:\n${tcRaw.slice(-1500).trim()}`,
  );
}

const covRun = runCoverageRaw();
const covValue =
  covRun.error || covRun.status !== 0 || covRun.summary === null
    ? null
    : (engine.adapters.coverage.extract(covRun.summary)?.value ?? null);
if (covValue === null) {
  console.error(
    `ratchet-propose: note — coverage has no usable reading ` +
      `(${covRun.error ? covRun.error.message : `exit ${covRun.status}`}); ` +
      'non-passing evidence, nothing proposed from it (I5). Output tail:\n' +
      `${`${covRun.stdout}${covRun.stderr}`.slice(-1500).trim()}`,
  );
}

// ---- committed baselines: parse each with the engine's own parser ----
const baselinesDir = join(ROOT, 'baselines');
const committed = [];
for (const name of readdirSync(baselinesDir).filter((n) => n.endsWith('.json')).sort()) {
  const abs = join(baselinesDir, name);
  // lstat BEFORE read (mirror the engine's leaf discipline): a non-regular
  // entry is refused as evidence, never followed.
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    continue; // raced away — nothing to propose from
  }
  if (stat.isFile() === false) {
    console.error(`ratchet-propose: note — baselines/${name} is not a regular file; skipped`);
    continue;
  }
  let parsed;
  try {
    parsed = engine.parseBaseline(readFileSync(abs, 'utf8'));
  } catch (err) {
    // A corrupt baseline yields no improvement (the ratchet CHECK is the
    // enforcement point; this script only proposes tightenings).
    console.error(`ratchet-propose: note — baselines/${name} is corrupt; skipped — ${err.message}`);
    continue;
  }
  committed.push(parsed);
}

// ---- improvements: only genuine TIGHTENs, judged by the engine's own comparator ----
const improvements = [];
for (const b of committed) {
  const live =
    b.metric === 'typecheck-count' ? tcValue : b.metric === 'coverage' ? covValue : undefined;
  if (live === undefined) {
    console.error(
      `ratchet-propose: note — metric '${b.metric}' (${b.target}) has no live runner wired; skipped`,
    );
    continue;
  }
  if (live === null) {
    continue; // note already emitted above
  }
  if (engine.tightens(b.value, live, b.direction)) {
    improvements.push({ target: b.target, metric: b.metric, value: live });
  } else {
    console.error(
      `ratchet-propose: ${b.target}/${b.metric} ${b.value} → ${live} is not a tightening ` +
        `(${b.direction}) — nothing to propose`,
    );
  }
}

if (improvements.length === 0) {
  console.error('ratchet-propose: no tightening to propose');
  process.exit(0);
}

// ---- BaselinePrEffects over gh CLI + git ----
// The token rides ONLY in the gh subprocess env (GH_TOKEN wins over
// GITHUB_TOKEN inside gh) and in the push URL inside .git/config — never in
// an echoed line (redact() scrubs any captured output), never in a log.
const redact = (text) => (token ? String(text).split(token).join('[redacted]') : String(text));
const ghEnv = () => {
  const e = { ...process.env, GH_TOKEN: token };
  delete e.GITHUB_TOKEN; // doctrine: CQ_AUTOMATION_TOKEN only, no silent fallback
  return e;
};

function runGit(args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (!allowFail && (res.error || res.status !== 0)) {
    throw new Error(
      `git ${args[0]} failed: ${res.error ? res.error.message : `exit ${res.status}`}\n` +
        redact(`${res.stdout ?? ''}${res.stderr ?? ''}`).trim(),
    );
  }
  return { stdout: res.stdout ?? '', status: res.status, error: res.error };
}

function runGh(args) {
  const res = spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8', env: ghEnv(), maxBuffer: MAX_BUFFER });
  if (res.error || res.status !== 0) {
    throw new Error(
      `gh ${args[0]} failed: ${res.error ? res.error.message : `exit ${res.status}`}\n` +
        redact(`${res.stdout ?? ''}${res.stderr ?? ''}`).trim(),
    );
  }
  return res.stdout ?? '';
}

const repoSlug = JSON.parse(
  runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']),
);

const effects = {
  async findOpenPrByHead(head) {
    const list = JSON.parse(runGh(['pr', 'list', '--head', head, '--state', 'open', '--json', 'number,url']));
    return list.length > 0 ? { number: list[0].number, url: list[0].url } : null;
  },

  async commitAndUpsertPr({ head, base, title, body, commitMessage, files }) {
    const existing = JSON.parse(
      runGh(['pr', 'list', '--head', head, '--state', 'open', '--json', 'number,url']),
    );
    // Authed push URL for the duration only; restored in the finally so the
    // token never lingers in .git/config after the run.
    const originalUrl = runGit(['remote', 'get-url', 'origin']).stdout.trim();
    runGit(['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repoSlug}.git`]);
    try {
      runGit(['fetch', 'origin', base]);
      const localHead = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${head}`]).stdout.trim();
      if (localHead !== '') {
        runGit(['checkout', head]); // reuse: idempotent re-run keeps its history
      } else {
        runGit(['checkout', '-b', head, `origin/${base}`]);
      }
      for (const f of files) {
        mkdirSync(dirname(join(ROOT, f.path)), { recursive: true });
        // Full renderBaseline bytes from the op — written verbatim.
        writeFileSync(join(ROOT, f.path), f.content);
      }
      runGit(['add', '--', ...files.map((f) => f.path)]);
      const commit = runGit(
        ['-c', 'user.name=cq-toolkit ratchet', '-c', 'user.email=ratchet@cq-toolkit.local', 'commit', '-m', commitMessage],
        { allowFail: true },
      );
      // Idempotency: identical bytes on a re-run commit nothing — that is
      // success, not failure.
      if (commit.status !== 0 && /nothing to commit/.test(`${commit.stdout}${commit.stderr}`) === false) {
        throw new Error(
          `git commit failed: exit ${commit.status}\n` +
            redact(`${commit.stdout}${commit.stderr}`).trim(),
        );
      }
      // Lease push: a TRUE lease against the remote head when it exists
      // (idempotent re-push), a plain create when it does not.
      runGit(['fetch', 'origin', `+refs/heads/${head}:refs/remotes/origin/${head}`], { allowFail: true });
      const expected = runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${head}`]).stdout.trim();
      if (expected !== '') {
        runGit(['push', `--force-with-lease=refs/heads/${head}:${expected}`, 'origin', `${head}:refs/heads/${head}`]);
      } else {
        runGit(['push', 'origin', `${head}:refs/heads/${head}`]);
      }
    } finally {
      spawnSync('git', ['remote', 'set-url', 'origin', originalUrl], { cwd: ROOT, encoding: 'utf8' });
    }
    if (existing.length > 0) {
      const n = existing[0].number;
      runGh(['pr', 'edit', String(n), '--title', title, '--body', body]);
      return { created: false, number: n, url: existing[0].url };
    }
    const out = runGh(['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body]);
    const url = out.trim().split('\n').filter((l) => l.startsWith('http')).pop() ?? null;
    const m = /\/pull\/(\d+)/.exec(url ?? '');
    return { created: true, number: m === null ? null : Number(m[1]), url };
  },
};

// ---- the op owns every remaining decision ----
const propose = engine.createProposeBaselineUpdate(effects);
const result = await propose({ ws: ROOT, base: BASE, improvements });
if (result.status !== 'ok') {
  console.error(
    `ratchet-propose: proposal ${result.status} — ${result.error ?? result.detail}`,
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
  `ratchet-propose: proposal ${outcome.proposal} — ${outcome.prUrl} (head ${outcome.head})`,
);
console.log(String(outcome.prUrl ?? ''));
