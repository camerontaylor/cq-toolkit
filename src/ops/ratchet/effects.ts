// BaselinePrEffects over the `gh` + `git` subprocesses — the DEFAULT binding
// the `ratchet.proposeBaselineUpdate` registry importer constructs per
// dispatch (the sweep/merge input-driven precedent: nothing is wired at
// registry module scope, and construction is closure-only — no subprocess
// runs until an effect is called).
//
// TOKEN DOCTRINE (inherited from proposeBaselineUpdate's header, load-bearing
// for I4): `gh` authenticates with `CQ_AUTOMATION_TOKEN` mapped to `GH_TOKEN`.
// An ambient `GITHUB_TOKEN` or `GH_TOKEN` is NEVER inherited or used — a
// GITHUB_TOKEN-authored PR suppresses workflow runs, so its required ratchet
// check would never run (an uncheckable-baseline bypass) — and the effects
// throw loudly when `CQ_AUTOMATION_TOKEN` is absent, exactly like
// scripts/ratchet-propose.mjs's token gate. The token travels only in the
// child env; it is never echoed, and it never appears in a URL or in git
// state. `git` uses the ambient credential configuration (the stage-2
// propose workflow wires the token through GIT_ASKPASS at the script layer).
//
// PAIR CONTRACT: the effects capture the proposal's `base` at construction so
// {@link BaselinePrEffects.findOpenPrByHead} can disambiguate the
// (head, base) pair — GitHub allows one head with several open PRs against
// different bases.
//
// Every fault THROWS: the op's own containment maps a thrown effect to an
// honest `failed` (never a fabricated ok), so this adapter never invents a
// result. Re-runs are IDEMPOTENT: the existing REMOTE head is fetched and
// checked out before the commit, so a fresh CI checkout updates the branch in
// place (a fast-forward no-op for byte-identical files) instead of recreating
// it from the base and failing the push non-fast-forward. The checkout is
// restored to its original branch in a `finally`.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BaselinePrEffects } from './proposeBaselineUpdate.js';

/** Captured child output can be large (a full diff/PR body) — never truncate. */
const MAX_BUFFER = 64 * 1024 * 1024;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** One subprocess, never rejecting: the caller decides what a non-zero exit means. */
function exec(
  file: string,
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout, stderr });
      },
    );
  });
}

/** The gh binary: CQ_GH_BIN (the review/merge family seam), else `gh`. */
function ghBin(): string {
  return process.env['CQ_GH_BIN'] ?? 'gh';
}

/**
 * The gh child env: `CQ_AUTOMATION_TOKEN` as `GH_TOKEN`, with BOTH the
 * ambient `GITHUB_TOKEN` and any ambient `GH_TOKEN` scrubbed. Throws loudly
 * when `CQ_AUTOMATION_TOKEN` is absent — there is no ambient-token fallback
 * (scripts/ratchet-propose.mjs's token gate, mirrored).
 */
function ghEnv(): NodeJS.ProcessEnv {
  const token = process.env['CQ_AUTOMATION_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      'ratchet: CQ_AUTOMATION_TOKEN is required for gh effects — GITHUB_TOKEN/GH_TOKEN are never ' +
        'inherited (a GITHUB_TOKEN-authored PR suppresses its own required workflow run)',
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['GITHUB_TOKEN'];
  delete env['GH_TOKEN'];
  env['GH_TOKEN'] = token;
  return env;
}

/** One `gh` invocation, throwing on a non-zero exit (the op contains the throw). */
async function runGh(repoRoot: string, args: readonly string[]): Promise<string> {
  const res = await exec(ghBin(), args, { cwd: repoRoot, env: ghEnv() });
  if (!res.ok) {
    throw new Error(`gh ${args[0] ?? ''} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

/** One `git` invocation; `allowFail` opts into the non-zero-exit probe shape. */
async function runGit(
  repoRoot: string,
  args: readonly string[],
  allowFail = false,
): Promise<ExecResult> {
  const res = await exec('git', args, { cwd: repoRoot });
  if (!res.ok && !allowFail) {
    throw new Error(`git ${args[0] ?? ''} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res;
}

/** The `/pull/<n>` identity of a created PR URL, or a throw (never a fabricated number). */
function prIdentity(url: string): { number: number; url: string } {
  const match = /\/pull\/(\d+)/.exec(url);
  const number = match?.[1];
  if (number === undefined)
    throw new Error(`gh pr create returned no PR identity: '${url.trim()}'`);
  return { number: Number(number), url: url.trim() };
}

/**
 * Build the real BaselinePrEffects over the checkout at `repoRoot`, scoped to
 * the proposal's `base`. Inert at construction: subprocesses spawn only when
 * an effect is called.
 */
export function makeSubprocessBaselinePrEffects(repoRoot: string, base: string): BaselinePrEffects {
  const findOpenPrByHead: BaselinePrEffects['findOpenPrByHead'] = async (head) => {
    const out = await runGh(repoRoot, [
      'pr',
      'list',
      '--head',
      head,
      '--base',
      base,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,url,baseRefName',
    ]);
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    // The (head, base) PAIR is the identity: GitHub allows one head with
    // several open PRs against DIFFERENT bases, so the base request is
    // filtered locally too (belt) on top of the server-side `--base` (braces).
    const matching = parsed.find((candidate) => {
      const pr = candidate as { number?: unknown; url?: unknown; baseRefName?: unknown };
      return typeof pr.number === 'number' && typeof pr.url === 'string' && pr.baseRefName === base;
    }) as { number: number; url: string } | undefined;
    return matching === undefined ? null : { number: matching.number, url: matching.url };
  };

  const commitAndUpsertPr: BaselinePrEffects['commitAndUpsertPr'] = async (input) => {
    const original = (await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    try {
      await runGit(repoRoot, ['fetch', 'origin', input.base]);
      // Reuse the REMOTE head when it exists. A fresh CI checkout has no
      // local refs/heads/<head>, and the old create-from-base path
      // re-committed the byte-identical files on a divergent root — the push
      // was then rejected non-fast-forward, so the documented "an open PR is
      // UPDATED in place" contradicted the observed outcome. Fetching the
      // head and checking IT out keeps a re-run a fast-forward no-op.
      const remoteHead = await runGit(
        repoRoot,
        ['fetch', 'origin', `+refs/heads/${input.head}:refs/remotes/origin/${input.head}`],
        true,
      );
      const start = remoteHead.ok ? `refs/remotes/origin/${input.head}` : `origin/${input.base}`;
      await runGit(repoRoot, ['checkout', '-B', input.head, start]);
      for (const file of input.files) {
        const path = join(repoRoot, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, 'utf8');
      }
      await runGit(repoRoot, ['add', '--', ...input.files.map((file) => file.path)]);
      const commit = await runGit(
        repoRoot,
        [
          '-c',
          'user.name=cq-toolkit ratchet',
          '-c',
          'user.email=ratchet@cq-toolkit.local',
          'commit',
          '-m',
          input.commitMessage,
        ],
        true,
      );
      // A re-run whose bytes are identical commits nothing — that is success,
      // not a fault (the op's idempotency contract).
      const combined = `${commit.stdout}${commit.stderr}`;
      if (!commit.ok && /nothing to commit/.test(combined) === false) {
        throw new Error(`git commit failed: ${combined.trim() || commit.stderr.trim()}`);
      }
      await runGit(repoRoot, [
        'push',
        'origin',
        `refs/heads/${input.head}:refs/heads/${input.head}`,
      ]);
    } finally {
      // Restore the checkout unless this run never switched (already on the
      // proposal head, or a detached HEAD).
      if (original !== '' && original !== 'HEAD' && original !== input.head) {
        await runGit(repoRoot, ['checkout', original], true);
      }
    }
    const existing = await findOpenPrByHead(input.head);
    if (existing !== null) {
      await runGh(repoRoot, [
        'pr',
        'edit',
        String(existing.number),
        '--title',
        input.title,
        '--body',
        input.body,
      ]);
      return { created: false, number: existing.number, url: existing.url };
    }
    const created = await runGh(repoRoot, [
      'pr',
      'create',
      '--base',
      input.base,
      '--head',
      input.head,
      '--title',
      input.title,
      '--body',
      input.body,
    ]);
    const url = created
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('http'))
      .pop();
    if (url === undefined) throw new Error('gh pr create returned no URL');
    const identity = prIdentity(url);
    return { created: true, number: identity.number, url: identity.url };
  };

  return { findOpenPrByHead, commitAndUpsertPr };
}
