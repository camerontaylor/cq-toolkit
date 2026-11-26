/**
 * Scratch git repositories for the `process()`-helpers differential tests.
 *
 * `runSteps` interprets the SAME declarative step list that
 * apps/crq-python/repair_process_helpers_vectors.py interprets, under the same
 * pinned git identity and dates and with no user/system git config, so commit
 * SHAs are identical on both sides and the fixture can name them symbolically
 * (`{c1}`). Everything lives under a temporary directory the caller removes.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type Step = readonly string[];

export const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Vector',
  GIT_AUTHOR_EMAIL: 'vector@example.invalid',
  GIT_COMMITTER_NAME: 'Vector',
  GIT_COMMITTER_EMAIL: 'vector@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
  LANGUAGE: 'C',
};

/** Pin the git environment for a describe block; returns the restore function. */
export function pinGitEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString('utf8');
}

export interface Scratch {
  readonly root: string;
  readonly repo: string;
  readonly marks: Record<string, string>;
  dispose(): void;
}

function applyStep(root: string, repo: string, marks: Record<string, string>, step: Step): void {
  const [op = '', a = '', b = ''] = step;
  switch (op) {
    case 'git':
      git(repo, ...step.slice(1));
      break;
    case 'write':
    case 'write_b64': {
      const path = join(repo, a);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, op === 'write' ? b : Buffer.from(b, 'base64'));
      chmodSync(path, 0o644);
      break;
    }
    case 'chmod':
      chmodSync(join(repo, a), parseInt(b, 8));
      break;
    case 'rm':
      unlinkSync(join(repo, a));
      break;
    case 'symlink':
      mkdirSync(dirname(join(repo, a)), { recursive: true });
      symlinkSync(b, join(repo, a));
      break;
    case 'link':
      linkSync(join(repo, a), join(repo, b));
      break;
    case 'mkfifo':
      execFileSync('mkfifo', [join(repo, a)]);
      break;
    case 'mark':
      marks[a] = git(repo, 'rev-parse', 'HEAD').trim();
      break;
    case 'commit_all':
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', a);
      break;
    case 'commit_bytes': {
      const message = join(root, 'message.bin');
      writeFileSync(message, Buffer.from(a, 'base64'));
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-F', message);
      break;
    }
    default:
      throw new Error(`unknown step ${String(op)}`);
  }
}

/** Build the first scratch repository from `steps`. */
export function runSteps(steps: readonly Step[]): Scratch {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cq-process-helpers-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const marks: Record<string, string> = {};
  for (const step of steps) applyStep(root, repo, marks, step);
  return { root, repo, marks, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** Follow-up rounds only use `git` and `write` steps (as the Python emitter). */
export function runMore(scratch: Scratch, steps: readonly Step[]): void {
  for (const step of steps) {
    if (step[0] !== 'git' && step[0] !== 'write') {
      throw new Error(`unsupported step ${String(step[0])}`);
    }
    applyStep(scratch.root, scratch.repo, scratch.marks, step);
  }
}

/** Replace `{name}` with the mark's SHA (`sub` in the emitter). */
export function substitute(value: string, marks: Record<string, string>): string {
  let out = value;
  for (const [name, sha] of Object.entries(marks)) out = out.split(`{${name}}`).join(sha);
  return out;
}

/** Mask the temporary root and turn SHAs back into `{name}` (longest first). */
export function scrubber(root: string, marks: Record<string, string>): (text: string) => string {
  const pairs = Object.entries(marks).sort((x, y) => y[1].length - x[1].length);
  return (text) => {
    let out = text.split(root).join('<root>');
    for (const [name, sha] of pairs) out = out.split(sha).join(`{${name}}`);
    return out;
  };
}

/** `git status --porcelain --ignored -z`, NUL shown as `|`, scrubbed. */
export function statusOf(repo: string, scrub: (text: string) => string): string {
  return scrub(git(repo, 'status', '--porcelain', '--ignored', '-z').split('\0').join('|'));
}

/** Every file or symlink below `dir` (symlinked directories are not followed). */
export function walkFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const relative = prefix === '' ? entry : `${prefix}/${entry}`;
    const stat = lstatSync(path);
    if (stat.isDirectory()) out.push(...walkFiles(path, relative));
    else out.push(relative);
  }
  return out;
}

/** A recorded mark's SHA; a missing mark is a fixture bug. */
export function markOf(scratch: Scratch, name: string): string {
  const sha = scratch.marks[name];
  if (sha === undefined) throw new Error(`no mark ${name}`);
  return sha;
}
