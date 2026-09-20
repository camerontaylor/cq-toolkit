// BaselinePrEffects over the `gh` + `git` subprocesses — the DEFAULT binding
// the `ratchet.proposeBaselineUpdate` registry importer constructs per
// dispatch (the sweep/merge input-driven precedent: nothing is wired at
// registry module scope, and construction is closure-only — no subprocess
// runs until an effect is called).
//
// TOKEN DOCTRINE (inherited from proposeBaselineUpdate's header, load-bearing
// for I4): `gh` authenticates with `CQ_AUTOMATION_TOKEN` mapped to `GH_TOKEN`,
// and `GITHUB_TOKEN` is scrubbed from the child environment — a
// GITHUB_TOKEN-authored PR suppresses workflow runs, so its required ratchet
// check would never run (an uncheckable-baseline bypass). The token travels
// only in the child env; it is never echoed, and it never appears in a URL or
// in git state. `git` uses the ambient credential configuration (the
// stage-2 propose workflow wires the token through GIT_ASKPASS at the script
// layer).
//
// Every fault THROWS: the op's own containment maps a thrown effect to an
// honest `failed` (never a fabricated ok), so this adapter never invents a
// result. The checkout is restored to its original branch in a `finally`.
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

/** The gh child env: CQ_AUTOMATION_TOKEN as GH_TOKEN, GITHUB_TOKEN scrubbed. */
function ghEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['GITHUB_TOKEN'];
  const token = process.env['CQ_AUTOMATION_TOKEN'];
  if (token !== undefined && token !== '') env['GH_TOKEN'] = token;
  return env;
}

/** One `gh` invocation, throwing on a non-zero exit (the op contains the throw). */
async function runGh(repoRoot: string, args: readonly string[]): Promise<string> {
  const res = await exec('gh', args, { cwd: repoRoot, env: ghEnv() });
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
 * Build the real BaselinePrEffects over the checkout at `repoRoot`. Inert at
 * construction: subprocesses spawn only when an effect is called.
 */
export function makeSubprocessBaselinePrEffects(repoRoot: string): BaselinePrEffects {
  const findOpenPrByHead: BaselinePrEffects['findOpenPrByHead'] = async (head) => {
    const out = await runGh(repoRoot, [
      'pr',
      'list',
      '--head',
      head,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,url',
    ]);
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0] as { number?: unknown; url?: unknown };
    if (typeof first.number !== 'number' || typeof first.url !== 'string') return null;
    return { number: first.number, url: first.url };
  };

  const commitAndUpsertPr: BaselinePrEffects['commitAndUpsertPr'] = async (input) => {
    const original = (await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    try {
      await runGit(repoRoot, ['fetch', 'origin', input.base]);
      const localHead = await runGit(
        repoRoot,
        ['rev-parse', '--verify', '--quiet', `refs/heads/${input.head}`],
        true,
      );
      if (localHead.ok && localHead.stdout.trim() !== '') {
        await runGit(repoRoot, ['checkout', input.head]);
      } else {
        await runGit(repoRoot, ['checkout', '-b', input.head, `origin/${input.base}`]);
      }
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
      await runGit(repoRoot, ['push', 'origin', `${input.head}:refs/heads/${input.head}`]);
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
