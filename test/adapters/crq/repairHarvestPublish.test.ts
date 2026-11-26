// `repair_tick.publish` through the composed bindings, end to end in a throwaway local
// repository: a real clone, a real local bare `origin` as the push target, the real
// worktree/verify/patch/detector/secret-scan/journal/queue ports, and injected fakes only
// for the forge (`gh pr view|list|create`), the clock and `new_item`. The wrapped ports carry
// their own Python differentials; this test pins the composition and the new push argv.
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import { repairHarvestPublish } from '../../../src/adapters/crq/repairHarvestPublish.js';
import { FixPrBacklog } from '../../../src/queue-runner/fixPrBacklog.js';
import { isPyError } from '../../../src/queue-runner/pyErrors.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const JOB = 'crq-job-1';
const GIT_ENV: Record<string, string> = {
  LC_ALL: 'C.UTF-8',
  LANGUAGE: '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const runGitFor =
  (repo: string): RunGit =>
  (args, options) =>
    runGitIn(repo)(args, { ...options, env: { ...GIT_ENV, ...options?.env } });

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: { ...scrubbedGitEnv(), ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

let root: string;
let clone: string;
let origin: string;
let wtRoot: string;
let state: string;
let fixed: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'crq-publish-')));
  clone = join(root, 'clone');
  origin = join(root, 'origin.git');
  wtRoot = join(root, 'wt');
  state = join(root, 'state');
  await mkdir(clone);
  await mkdir(wtRoot);
  await mkdir(join(state, 'repair', 'inbox'), { recursive: true });
  await writeFile(
    join(state, 'repair', 'inbox', `${JOB}.json`),
    JSON.stringify({ job: JOB, pr: 9, run: 'review-1', finding: { id: 'f1' } }),
  );
  git(root, 'init', '-q', '--bare', '--object-format=sha1', '-b', 'main', origin);
  git(clone, 'init', '-q', '--object-format=sha1', '-b', 'main');
  git(clone, 'remote', 'add', 'origin', origin);
  await writeFile(join(clone, 'a.txt'), 'l1\nl2\n');
  await mkdir(join(clone, 'policy/denylist'), { recursive: true });
  await writeFile(
    join(clone, 'policy/denylist/patterns.yml'),
    `rules:
  - id: class:deny-word
    description: synthetic deny word
    regex: '\\bdenyword\\b'
    sample: 'a denyword here'
clean_probes:
  - 'plain text that matches nothing'
`,
  );
  git(clone, 'add', 'a.txt', 'policy');
  git(clone, 'commit', '-q', '-m', 'base');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'fetch', '-q', 'origin');
  await writeFile(join(clone, 'a.txt'), 'l1 fixed\nl2\n');
  git(clone, 'commit', '-q', '-am', `fix ${JOB}`);
  fixed = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'checkout', '-q', '--detach', fixed);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Scenario {
  publish: ReturnType<typeof repairHarvestPublish>['publish'];
  created: { base: string; head: string; title: string; bodyFile: string }[];
  q: { items: Record<string, unknown>[] };
  item: Record<string, unknown>;
  record: Record<string, unknown>;
}

function scenario(run: string, openPr?: { target: string; branch: string }): Scenario {
  const created: Scenario['created'] = [];
  const item: Record<string, unknown> = { id: 'pr9', pr: 9, kind: 'open', state: 'running' };
  const q = { items: [item] };
  const record: Record<string, unknown> = {
    state: 'running',
    jobs: [JOB],
    open_pr: openPr !== undefined,
    ...(openPr === undefined ? {} : { base: openPr.target, branch: openPr.branch }),
    verdicts: [{ job: JOB, verdict: 'FIXED', reason: 'ok' }],
  };
  const branch = `crq/fix-${run}`;
  const { publish } = repairHarvestPublish({
    clone,
    worktreeRoot: wtRoot,
    worktreePrefix: 'crq-publish-',
    runGitFor,
    stateRoot: state,
    repo: 'o/r',
    iso: () => '2026-11-27T00:00:00Z',
    backlog: new FixPrBacklog(),
    gitleaks: async () => ({ kind: 'not-run' }),
    match: async () => [],
    forge: {
      prInfo: async () => {
        if (openPr === undefined) throw new Error('no forge read expected');
        return {
          state: 'OPEN',
          headRefOid: openPr.target,
          headRefName: openPr.branch,
        };
      },
      listBranchPrs: async () =>
        created.length === 0
          ? []
          : [
              {
                number: 42,
                url: 'https://github.com/o/r/pull/42',
                state: 'OPEN',
                headRefOid: git(origin, 'rev-parse', `refs/heads/${branch}`),
              },
            ],
    },
    createPr: async (request) => {
      created.push({ ...request });
    },
    newItem: async (queue, fields) => {
      (queue.items as unknown[]).push(fields);
    },
  });
  return { publish, created, q, item, record };
}

describe('repairHarvestPublish', () => {
  it('replays the repair, scans it, pushes to the bare origin and creates the fix PR', async () => {
    await mkdir(join(state, 'repair', JOB), { recursive: true });
    const s = scenario('r1');
    await s.publish(s.q, s.item, 'r1', s.record, [{ job: JOB, commits: [fixed] }]);

    const head = git(origin, 'rev-parse', 'refs/heads/crq/fix-r1');
    expect(git(origin, 'show', `${head}:a.txt`)).toBe('l1 fixed\nl2');
    const journal = JSON.parse(
      await readFile(join(state, 'repair', JOB, 'publication.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(journal).toMatchObject({ head, branch: 'crq/fix-r1', open_pr: false });
    expect(git(clone, 'rev-parse', 'refs/crq/publication/r1')).toBe(head);
    expect(await readFile(join(state, 'repair', JOB, 'publication.patch'), 'utf8')).toContain(
      '+l1 fixed',
    );
    expect(s.created).toHaveLength(1);
    expect(s.created[0]).toMatchObject({ base: 'main', head: 'crq/fix-r1' });
    expect(await readFile(s.created[0]!.bodyFile, 'utf8')).toContain(`| ${JOB} | FIXED | ok |`);
    expect(s.record['state']).toBe('published');
    expect(s.item['state']).toBe('done');
    expect(s.q.items.map((i) => i['id'])).toEqual(['pr9', 'pr42']);
    expect(await exists(join(wtRoot, 'crq-publish-publish-r1'))).toBe(false);
  });

  it('a branch already on the remote fails the lease and still removes the worktree', async () => {
    await mkdir(join(state, 'repair', JOB), { recursive: true });
    await rm(join(state, 'repair', JOB, 'publication.json'), { force: true });
    git(clone, 'push', '-q', 'origin', 'origin/main:refs/heads/crq/fix-r2');
    const s = scenario('r2');
    const error = await s
      .publish(s.q, s.item, 'r2', s.record, [{ job: JOB, commits: [fixed] }])
      .catch((e: unknown) => e);
    expect(isPyError(error, 'RuntimeError')).toBe(true);
    expect((error as Error).message).toContain(
      'push origin --force-with-lease=refs/heads/crq/fix-r2:',
    );
    expect(s.created).toHaveLength(0);
    expect(s.record['state']).toBe('running');
    expect(git(origin, 'rev-parse', 'refs/heads/crq/fix-r2')).toBe(
      git(origin, 'rev-parse', 'refs/heads/main'),
    );
    expect(await exists(join(wtRoot, 'crq-publish-publish-r2'))).toBe(false);
  });

  it('an open PR whose branch moved fails the non-empty lease and leaves the remote alone', async () => {
    await mkdir(join(state, 'repair', JOB), { recursive: true });
    await rm(join(state, 'repair', JOB, 'publication.json'), { force: true });
    const target = git(origin, 'rev-parse', 'refs/heads/main');
    // The branch moved on the remote after the PR head was read: the lease names `target`.
    const moved = git(clone, 'commit-tree', `${target}^{tree}`, '-p', target, '-m', 'maintainer');
    git(clone, 'push', '-q', 'origin', `${moved}:refs/heads/crq/fix-r3`);
    const s = scenario('r3', { target, branch: 'crq/fix-r3' });
    const error = await s
      .publish(s.q, s.item, 'r3', s.record, [{ job: JOB, commits: [fixed] }])
      .catch((e: unknown) => e);
    expect(isPyError(error, 'RuntimeError')).toBe(true);
    expect((error as Error).message).toContain(
      `push origin --force-with-lease=refs/heads/crq/fix-r3:${target}`,
    );
    expect(git(origin, 'rev-parse', 'refs/heads/crq/fix-r3')).toBe(moved);
    expect(s.created).toHaveLength(0);
    expect(await exists(join(wtRoot, 'crq-publish-publish-r3'))).toBe(false);
  });
});
