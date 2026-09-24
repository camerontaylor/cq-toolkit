// Reusable real-git test template. Seed the repository and its bare origin
// once, then copy both before any worktree is added. A copied linked-worktree
// pointer would contain an absolute path from the source checkout, so the
// helper deliberately refuses to be used as a post-worktree snapshot.
import { execFile, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GIT_NO_AUTO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
const GIT_CALL_TIMEOUT_MS = 6_000;
const GIT_CALL_ATTEMPTS = 4;

export interface GitTemplate {
  /** Temporary root containing the seeded repository and bare origin. */
  root: string;
  /** Seeded working repository. */
  repo: string;
  /** Seeded bare origin. */
  origin: string;
}

export interface ClonedGitTemplate {
  /** Fresh temporary root containing the copied repository and bare origin. */
  root: string;
  /** Copied working repository with its rewritten origin URL. */
  repo: string;
  /** Copied bare origin. */
  origin: string;
}

type SeedRepo = (repo: string) => Promise<void>;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_NO_AUTO_MAINTENANCE, ...args],
      { cwd, timeout: GIT_CALL_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function resilient<T>(step: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= GIT_CALL_ATTEMPTS; attempt += 1) {
    try {
      return await step();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** Seed one repository plus a local bare origin for later template copies. */
export async function createGitTemplate(seedRepo: SeedRepo): Promise<GitTemplate> {
  const root = mkdtempSync(join(tmpdir(), 'cq-git-template-'));
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo, { recursive: true });
  await seedRepo(repo);
  await resilient(() => git(['init', '-q', '--bare', origin], root));
  await resilient(() => git(['-C', repo, 'remote', 'add', 'origin', origin], repo));
  return { root, repo, origin };
}

/**
 * Copy a clean, pre-worktree template into a fresh root and prove that the
 * copy has no linked-worktree, hook, alternates, or core.worktree residue.
 * The origin URL is rewritten because the copied bare origin has a new path.
 */
export async function cloneTemplate(template: GitTemplate): Promise<ClonedGitTemplate> {
  const root = mkdtempSync(join(tmpdir(), 'cq-git-clone-'));
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  try {
    cpSync(template.root, root, { recursive: true });
    await resilient(() => git(['-C', repo, 'remote', 'set-url', 'origin', origin], repo));
    assertCleanClone(repo);
    return { root, repo, origin };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function assertCleanClone(repo: string): void {
  const gitDir = join(repo, '.git');
  const hooks = existsSync(join(gitDir, 'hooks'))
    ? readdirSync(join(gitDir, 'hooks')).filter((name) => !name.endsWith('.sample'))
    : [];
  if (hooks.length > 0) throw new Error(`cloned git template carried hooks: ${hooks.join(', ')}`);
  if (existsSync(join(gitDir, 'objects', 'info', 'alternates'))) {
    throw new Error('cloned git template carried an objects/info/alternates file');
  }
  if (existsSync(join(gitDir, 'worktrees'))) {
    throw new Error('cloned git template carried linked-worktree metadata');
  }
  // `core.worktree` is a linked-worktree pointer; it must not survive a copy.
  const worktree = execFileSyncSafe(['-C', repo, 'config', '--get', 'core.worktree']);
  if (worktree.trim() !== '') throw new Error('cloned git template carried core.worktree');
  const status = execFileSyncSafe(['-C', repo, 'status', '--porcelain']);
  if (status !== '') throw new Error(`cloned git template is dirty: ${status}`);
}

function execFileSyncSafe(args: string[]): string {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_CALL_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) {
    // `config --get core.worktree` exits 1 when the key is absent, which is
    // the expected clean-copy result. Other failures are still surfaced.
    if (args.includes('config') && result.status === 1) return '';
    throw new Error(String(result.error?.message ?? result.stderr ?? 'git command failed'));
  }
  return result.stdout;
}
