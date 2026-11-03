import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPolicyDiff } from '../../../src/ops/gates/policyDiff.js';
import {
  HOOK_MS,
  SLOW,
  COVERAGE_PATH,
  GIT_ENV,
  baselineText,
  gitIn,
  importCommits,
  kinds,
  repo,
  root,
  run,
  setupFixtures,
  teardownFixtures,
  trust,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

/** One raw tree entry: mode, name, 20-byte oid. */
interface RawEntry {
  mode: string;
  name: string;
  oid: Buffer;
}

/** Write `bytes` as a loose object of `type` with NO fsck (`hash-object --literally`). */
function writeLiteral(dir: string, type: 'blob' | 'tree', bytes: Buffer): string {
  return execFileSync('git', ['hash-object', '--literally', '-t', type, '-w', '--stdin'], {
    cwd: dir,
    env: GIT_ENV,
    input: bytes,
  })
    .toString('utf8')
    .trim();
}

/** Git's tree order: byte order, with a tree's name compared as if it ended in `/`. */
function treeKey(e: RawEntry): Buffer {
  return Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
}

function serializeTree(entries: RawEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeKey(a), treeKey(b)));
  return Buffer.concat(
    sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), e.oid]),
  );
}

/**
 * A commit on `parent` adding one file at `<dir>/<name>` (or `<name>` at the
 * root when `dir` is null), with every object written raw — the only way to
 * get a `.GIT` segment into a tree once fast-import's fsck refuses it.
 */
function literalCommit(
  dir: string,
  parent: string,
  sub: string | null,
  name: string,
  content: string,
): string {
  const raw = execFileSync('git', ['cat-file', 'tree', `${parent}^{tree}`], {
    cwd: dir,
    env: GIT_ENV,
  });
  const entries: RawEntry[] = [];
  for (let at = 0; at < raw.length;) {
    const nul = raw.indexOf(0, at);
    const [mode, ...rest] = raw.subarray(at, nul).toString('utf8').split(' ');
    entries.push({ mode: mode!, name: rest.join(' '), oid: raw.subarray(nul + 1, nul + 21) });
    at = nul + 21;
  }
  const blob = Buffer.from(writeLiteral(dir, 'blob', Buffer.from(content, 'utf8')), 'hex');
  const file: RawEntry = { mode: '100644', name, oid: blob };
  if (sub === null) entries.push(file);
  else {
    const tree = writeLiteral(dir, 'tree', serializeTree([file]));
    entries.push({ mode: '40000', name: sub, oid: Buffer.from(tree, 'hex') });
  }
  const root = writeLiteral(dir, 'tree', serializeTree(entries));
  return execFileSync('git', ['commit-tree', root, '-p', parent, '-m', `literal ${name}`], {
    cwd: dir,
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  })
    .toString('utf8')
    .trim();
}

describe('policyDiff: unsafe paths (#224 composition)', SLOW, () => {
  let c: Record<string, string>;
  beforeAll(() => {
    // Both paths are refused by the porcelain (update-index), and newer git's
    // fast-import fsck refuses `.GIT` too, so the trees are written raw.
    c = {
      dotgit: literalCommit(repo, trust, '.GIT', 'x', 'hostile\n'),
      backslash: literalCommit(repo, trust, null, 'a\\b.txt', 'x\n'),
    };
  }, HOOK_MS);

  test('a `.GIT` segment is unsafe-path and never read', async () => {
    const out = await run(c['dotgit']!, 'diff-check');
    expect(out.findings).toEqual([
      {
        kind: 'unsafe-path',
        path: '".GIT/x"',
        reason: "ratchet git: refusing changed path '.GIT/x' (.git segment)",
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('a backslash path is unsafe-path', async () => {
    const out = await run(c['backslash']!, 'diff-check');
    expect(kinds(out)).toEqual(['unsafe-path']);
    expect(out.verdict).toBe('needs-human');
  });
});

describe('policyDiff: no-shell composition (#221 / W1.7 argv)', SLOW, () => {
  test('configured diff programs and hooks never run; the real change is still judged', async () => {
    // A separate clone, so the hostile config cannot leak into other cases.
    const clone = join(root, 'hostile');
    execFileSync('git', ['clone', '-q', '--no-checkout', repo, clone], { env: GIT_ENV });
    const subject = importCommits(clone, {
      hostile: {
        files: { '.gitattributes': '* diff=evil\n', [COVERAGE_PATH]: baselineText(80) },
      },
    })['hostile']!;
    const marker = join(root, 'MARKER');
    const script = join(root, 'evil.sh');
    // If git ran it, the textconv would also blank the diff and hide the loosening.
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(script, 0o755);
    for (const key of ['diff.external', 'diff.evil.textconv', 'core.fsmonitor', 'core.pager']) {
      gitIn(clone, ['config', key, script]);
    }
    const result = await createPolicyDiff({ posture: 'diff-check', layer: 'env' })({
      repo: clone,
      trustRef: trust,
      subject,
      subjectKind: 'pr',
      base: 'refs/remotes/origin/main',
    });
    expect(existsSync(marker)).toBe(false);
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect(result.value.findings).toContainEqual(
      expect.objectContaining({ kind: 'baseline-loosened' }),
    );
    expect(result.value.findings).toContainEqual(
      expect.objectContaining({ kind: 'definition-changed', path: '.gitattributes' }),
    );
    expect(result.value.verdict).toBe('needs-human');
  });
});
