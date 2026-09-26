// W1.10 — hermetic tests for the commit-graph reads and the atomic push in
// src/ops/ratchet/git.ts (the promotion gate's no-shell git, methods note
// Decision 13).
//
// Real tmp git repos (no network). Pinned:
//   - gitIsAncestor answers yes/no and throws on an unknown revision;
//   - gitRangeCommits / gitFirstParentRange list exactly `from..to` (with
//     parents / the first-parent chain) and refuse non-oid ends;
//   - gitMergeTreeClean returns the ort tree on a clean merge (equal to a
//     real merge commit's tree), null on a conflict; an "evil merge" (a merge
//     commit whose tree differs from the merge-tree result) is detected by
//     comparing gitTreeOf;
//   - gitPushAtomic: a leased push (one --force-with-lease per ref, the oids
//     the caller read — leases only, never a plain force) lands both refs; a
//     lease that no longer holds is a resolved rejection (ok:false, porcelain
//     output) — including a ref REWOUND to an ancestor between read and push,
//     which a plain fast-forward push would have accepted; --atomic makes one
//     failed lease reject the other ref too (asserted from a remote where
//     the other ref WOULD move); bad url/refspec/branch/lease are refused
//     before spawn; the token never appears in the output.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  gitFirstParentRange,
  gitIsAncestor,
  gitMergeTreeClean,
  gitPushAtomic,
  gitRangeCommits,
  gitTreeOf,
} from '../../../src/ops/ratchet/git.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.test']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commitFile(dir: string, file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content, 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

let tmp: string;
let repo: string;
let base: string;
let side1: string;
let side2: string;
let merge: string;
let conflictA: string;
let conflictB: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cq-git-graph-'));
  repo = join(tmp, 'repo');
  initRepo(repo);
  base = commitFile(repo, 'a.txt', 'one\n', 'base');
  // A feature branch with two commits, merged with --no-ff onto a main that also moved.
  git(repo, ['checkout', '-q', '-b', 'feature']);
  side1 = commitFile(repo, 'b.txt', 'b1\n', 'side 1');
  side2 = commitFile(repo, 'b.txt', 'b2\n', 'side 2');
  git(repo, ['checkout', '-q', 'main']);
  commitFile(repo, 'c.txt', 'c\n', 'main moves');
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
  merge = git(repo, ['rev-parse', 'HEAD']);
  // Two branches editing the same line: a conflicting merge.
  git(repo, ['checkout', '-q', '-b', 'ca', base]);
  conflictA = commitFile(repo, 'a.txt', 'A\n', 'conflict a');
  git(repo, ['checkout', '-q', '-b', 'cb', base]);
  conflictB = commitFile(repo, 'a.txt', 'B\n', 'conflict b');
  git(repo, ['checkout', '-q', 'main']);
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('gitIsAncestor', { timeout: 30_000 }, () => {
  test('ancestor, non-ancestor, self', async () => {
    expect(await gitIsAncestor(repo, base, merge)).toBe(true);
    expect(await gitIsAncestor(repo, merge, base)).toBe(false);
    expect(await gitIsAncestor(repo, merge, merge)).toBe(true);
  });

  test('an unknown revision throws (not "false")', async () => {
    await expect(gitIsAncestor(repo, '0'.repeat(40), merge)).rejects.toThrow(/ratchet git:/);
  });

  test('an option-shaped revision is refused before spawn', async () => {
    await expect(gitIsAncestor(repo, '--output=/tmp/x', merge)).rejects.toThrow(/unsafe/);
  });
});

describe('gitRangeCommits / gitFirstParentRange', { timeout: 30_000 }, () => {
  test('every commit in from..to with its parents', async () => {
    const rows = await gitRangeCommits(repo, base, merge);
    const shas = rows.map((r) => r.sha);
    expect(shas).toHaveLength(4);
    expect(shas[0]).toBe(merge);
    expect(new Set(shas)).toEqual(
      new Set([merge, side1, side2, git(repo, ['rev-parse', `${merge}^1`])]),
    );
    const m = rows.find((r) => r.sha === merge);
    expect(m?.parents).toEqual([git(repo, ['rev-parse', `${merge}^1`]), side2]);
    expect(rows.find((r) => r.sha === side1)?.parents).toEqual([base]);
  });

  test('the first-parent chain excludes the merged side', async () => {
    const chain = await gitFirstParentRange(repo, base, merge);
    expect(chain).toEqual([merge, git(repo, ['rev-parse', `${merge}^1`])]);
  });

  test('an empty range is empty', async () => {
    expect(await gitRangeCommits(repo, merge, merge)).toEqual([]);
    expect(await gitFirstParentRange(repo, merge, base)).toEqual([]);
  });

  test('non-oid ends are refused (the ^ exclusion takes only an oid)', async () => {
    await expect(gitRangeCommits(repo, 'main', merge)).rejects.toThrow(/40-hex oid/);
    await expect(gitFirstParentRange(repo, base, '-n1')).rejects.toThrow(/40-hex oid/);
  });
});

describe('gitTreeOf / gitMergeTreeClean', { timeout: 60_000 }, () => {
  test('a clean merge: merge-tree equals the real merge commit tree', async () => {
    // Explicit oids (revision operators are refused): p1 = merge^1.
    const p1 = git(repo, ['rev-parse', `${merge}^1`]);
    const clean = await gitMergeTreeClean(repo, p1, side2);
    expect(clean).toBe(await gitTreeOf(repo, merge));
  });

  test('a conflicting merge is null', async () => {
    expect(await gitMergeTreeClean(repo, conflictA, conflictB)).toBeNull();
  });

  test('an evil merge (tree differs from the clean merge result) is detected', async () => {
    const evil = join(tmp, 'evil');
    initRepo(evil);
    const b = commitFile(evil, 'a.txt', 'x\n', 'base');
    git(evil, ['checkout', '-q', '-b', 'f']);
    const f = commitFile(evil, 'f.txt', 'f\n', 'feature');
    git(evil, ['checkout', '-q', 'main']);
    const m1 = commitFile(evil, 'm.txt', 'm\n', 'main');
    git(evil, ['merge', '-q', '--no-ff', '--no-commit', 'f']);
    writeFileSync(join(evil, 'sneaky.txt'), 'extra\n', 'utf8');
    git(evil, ['add', '-A']);
    git(evil, ['commit', '-q', '-m', 'evil merge']);
    const m = git(evil, ['rev-parse', 'HEAD']);
    expect(git(evil, ['rev-parse', `${m}^2`])).toBe(f);
    expect(b).not.toBe(m1);
    const clean = await gitMergeTreeClean(evil, m1, f);
    expect(clean).not.toBeNull();
    expect(clean).not.toBe(await gitTreeOf(evil, m));
  });

  test('bad revisions are refused before spawn; unknown oids throw', async () => {
    await expect(gitTreeOf(repo, 'HEAD~1')).rejects.toThrow(/unsafe/);
    await expect(gitMergeTreeClean(repo, '--x', side2)).rejects.toThrow(/unsafe/);
    await expect(gitMergeTreeClean(repo, '1'.repeat(40), side2)).rejects.toThrow(/merge-tree/);
    await expect(gitTreeOf(repo, '1'.repeat(40))).rejects.toThrow(/ratchet git:/);
  });
});

describe('gitPushAtomic', { timeout: 60_000 }, () => {
  const TOKEN = 'ghp_SECRETTOKENVALUE1234567890';
  let remote: string;
  let work: string;
  let c1: string;
  let c2: string;
  let c3: string;

  const remoteRef = (ref: string): string => git(remote, ['rev-parse', ref]);
  /** Set the remote refs directly (each test starts from its own state). */
  const setRemote = (main: string, queue: string): void => {
    git(remote, ['update-ref', 'refs/heads/main', main]);
    git(remote, ['update-ref', 'refs/heads/merge-queue', queue]);
  };
  /** Promote `to` onto both refs, leased on the (main, queue) the caller read. */
  const promote = (
    url: string,
    to: string,
    readMain: string,
    readQueue: string,
  ): ReturnType<typeof gitPushAtomic> =>
    gitPushAtomic(
      work,
      url,
      [
        { refspec: `${to}:refs/heads/main`, expected: readMain },
        { refspec: `${to}:refs/heads/merge-queue`, expected: readQueue },
      ],
      TOKEN,
    );

  beforeAll(() => {
    remote = join(tmp, 'remote.git');
    mkdirSync(remote);
    git(remote, ['init', '-q', '--bare', '-b', 'main']);
    work = join(tmp, 'work');
    initRepo(work);
    c1 = commitFile(work, 'x.txt', '1\n', 'c1');
    c2 = commitFile(work, 'x.txt', '2\n', 'c2');
    c3 = commitFile(work, 'x.txt', '3\n', 'c3');
    git(work, ['push', '-q', remote, `${c3}:refs/heads/main`, `${c3}:refs/heads/merge-queue`]);
  }, 120_000);

  test('a leased atomic push lands both refs', async () => {
    setRemote(c1, c2);
    const res = await promote(remote, c2, c1, c2);
    expect(res.ok).toBe(true);
    expect(remoteRef('main')).toBe(c2);
    expect(remoteRef('merge-queue')).toBe(c2);
    expect(res.output).not.toContain(TOKEN);
  });

  test('an advanced merge-queue fails its lease and --atomic keeps main unmoved', async () => {
    // Read: main c1, queue c2. The queue then advanced to c3 remotely. The
    // main update alone (c1 → c2) would succeed; --atomic must refuse it.
    setRemote(c1, c3);
    const res = await promote(`file://${remote}`, c2, c1, c2);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/rejected/);
    expect(remoteRef('main')).toBe(c1);
    expect(remoteRef('merge-queue')).toBe(c3);
  });

  test('a merge-queue rewound to an ancestor between read and push is refused', async () => {
    // Read: main c1, queue c3. Break-glass then rewinds the queue to c2 (an
    // ancestor of c3): a plain push of c3 would fast-forward it back.
    setRemote(c1, c2);
    const res = await promote(remote, c3, c1, c3);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/rejected/);
    expect(remoteRef('main')).toBe(c1);
    expect(remoteRef('merge-queue')).toBe(c2);
  });

  test('a main rewound between read and push is refused', async () => {
    // Read: main c2, queue c3. main is then rewound to c1.
    setRemote(c1, c3);
    const res = await promote(remote, c3, c2, c3);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/rejected/);
    expect(remoteRef('main')).toBe(c1);
    expect(remoteRef('merge-queue')).toBe(c3);
  });

  test('a single stale lease is a resolved rejection', async () => {
    setRemote(c2, c2);
    const res = await gitPushAtomic(
      work,
      remote,
      [{ refspec: `${c3}:refs/heads/main`, expected: c1 }],
      TOKEN,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/rejected|stale/);
    expect(remoteRef('main')).toBe(c2);
  });

  test('bad url / refspec / branch / lease are refused before spawn', async () => {
    setRemote(c2, c2);
    const good = [{ refspec: `${c3}:refs/heads/main`, expected: c2 }];
    for (const url of [
      'relative/path',
      'http://github.com/o/r.git',
      'https://github.com/o/r',
      'https://user:pw@github.com/o/r.git',
      'ssh://git@github.com/o/r.git',
      '--upload-pack=evil',
      'ext::sh -c touch% /tmp/x',
    ]) {
      await expect(gitPushAtomic(work, url, good, TOKEN)).rejects.toThrow(/refusing push url/);
    }
    for (const refspec of [
      `+${c3}:refs/heads/main`,
      `${c3}:refs/tags/v1`,
      'main:refs/heads/main',
      `${c3}:refs/heads/-x`,
      `${c3}:refs/heads/a..b`,
      `${c3}`,
    ]) {
      await expect(gitPushAtomic(work, remote, [{ refspec, expected: c2 }], TOKEN)).rejects.toThrow(
        /refusing/,
      );
    }
    for (const expected of ['main', c2.slice(0, 12), '', `${c2}\n`, c2.toUpperCase()]) {
      await expect(
        gitPushAtomic(work, remote, [{ refspec: `${c3}:refs/heads/main`, expected }], TOKEN),
      ).rejects.toThrow(/refusing lease/);
    }
    await expect(
      gitPushAtomic(
        work,
        remote,
        [
          { refspec: `${c3}:refs/heads/main`, expected: c2 },
          { refspec: `${c1}:refs/heads/main`, expected: c2 },
        ],
        TOKEN,
      ),
    ).rejects.toThrow(/second update/);
    await expect(gitPushAtomic(work, remote, [], TOKEN)).rejects.toThrow(/empty push/);
    await expect(
      gitPushAtomic(work, 'https://github.invalid/o/r.git', good, 'a\nb'),
    ).rejects.toThrow(/credential/);
    expect(remoteRef('main')).toBe(c2);
  });

  test('an https transport failure is ok:false and the token is redacted', async () => {
    const res = await gitPushAtomic(
      work,
      'https://127.0.0.1.invalid/o/r.git',
      [{ refspec: `${c3}:refs/heads/main`, expected: c2 }],
      TOKEN,
    );
    expect(res.ok).toBe(false);
    expect(res.output).not.toContain(TOKEN);
    expect(res.output).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
  });
});
