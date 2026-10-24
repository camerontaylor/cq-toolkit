import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeAddressWorker } from '../../../src/ops/review/addressWorker.js';
import { GIT_HARDEN } from '../../../src/shared/gitHarden.js';

const initial = 'a'.repeat(40),
  fixed = 'b'.repeat(40);
const ok = (value: unknown): GhResult => ({
  code: 0,
  stdout: typeof value === 'string' ? value : JSON.stringify(value),
  stderr: '',
});
/** Phase-one orchestration world: no git process, provider package, credentials or forge network. */
async function world(
  human = false,
  options: {
    sameFile?: boolean;
    fileless?: 'first' | 'last';
    bot?: boolean;
    discussion?: boolean;
    recoverResolution?: boolean;
    reviewOutcome?: 'failed' | 'wrong-head' | 'open-finding';
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'cq-address-memory-'));
  const worktree = join(root, 'git', 'cq-review-worktrees', 'worker');
  await mkdir(worktree, { recursive: true });
  let head = initial,
    remote = initial;
  const resolved = new Set<string>();
  let failResolve = options.recoverResolution === true;
  let login = 'responder';
  let reviewerCalls = 0;
  const reports: string[] = [];
  const replies: Array<{
    id: number;
    in_reply_to_id: number;
    body: string;
    user: { login: string };
    created_at: string;
  }> = [];
  const actions: string[] = [];
  const prompts: string[] = [];
  const files = ['src/a.ts', 'src/b.ts'];
  await mkdir(join(worktree, 'src'), { recursive: true });
  for (const file of files) await writeFile(join(worktree, file), 'BAD\n');
  const initialTree = new Map(files.map((file) => [file, 'BAD\n']));
  const trees = new Map<string, Map<string, string>>([[initial, new Map(initialTree)]]);
  const heads = new Map<string, string>([[worktree, initial]]);
  const indices = new Map<string, Map<string, string>>([[worktree, new Map(initialTree)]]);
  const treeHash = (tree: Map<string, string>) =>
    createHash('sha1')
      .update(JSON.stringify([...tree].sort()))
      .digest('hex');
  const commits = new Map<string, { parent: string; message: string; tree: string }>();
  const order =
    options.sameFile || options.fileless === 'first'
      ? ['T2', 'T1']
      : ['T1', ...(human ? ['T2'] : [])];
  const threads = order.map((id, i) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path:
      options.fileless && id === 'T2'
        ? null
        : `src/${!options.sameFile && id === 'T2' ? 'b' : 'a'}.ts`,
    line: 1,
    comments: {
      nodes: [
        {
          databaseId: i + 101,
          author: options.bot
            ? { login: 'reviewer[bot]', __typename: 'Bot' }
            : { login: 'reviewer', __typename: 'User' },
          body: `Fix ${id}`,
          createdAt: new Date(Date.now() - 60000).toISOString(),
        },
      ],
    },
  }));
  const flag = (args: readonly string[], key: string) =>
    args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
  const gh: GhFn = async (args) => {
    if (args[0] === 'repo') return ok({ nameWithOwner: 'octo/widget' });
    if (args[0] === 'pr')
      return ok({
        headRefName: 'feature',
        headRepositoryOwner: { login: 'octo' },
        headRepository: { name: 'widget' },
      });
    if (args.includes('user')) return ok(login);
    const endpoint = args.find((a) => a.startsWith('repos/')) ?? '';
    if (args.includes('graphql')) {
      const query = flag(args, 'query');
      if (query.includes('resolveReviewThread')) {
        const id = flag(args, 'threadId');
        if (remote !== fixed) throw new Error('resolve before verified publication');
        if (failResolve) {
          failResolve = false;
          actions.push('resolve-failed');
          return { code: 1, stdout: '', stderr: 'scripted resolution failure after landed reply' };
        }
        resolved.add(id);
        actions.push(`resolve:${id}`);
        return ok({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } });
      }
      return ok({
        data: {
          repository: {
            pullRequest: {
              author: { login: 'prauthor' },
              headRefName: 'feature',
              headRefOid: remote,
              reviewThreads: {
                nodes: threads.map((t) => ({ ...t, isResolved: resolved.has(t.id) })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      });
    }
    if (args.includes('POST')) {
      if (endpoint.endsWith('requested_reviewers')) actions.push('rerequest');
      else {
        if (remote !== fixed) throw new Error('reply before verified publication');
        actions.push('reply');
        if (options.recoverResolution)
          replies.push({
            id: 1001,
            in_reply_to_id: Number(flag(args, 'in_reply_to')),
            body: flag(args, 'body'),
            user: { login },
            created_at: new Date().toISOString(),
          });
      }
      return ok({ id: 1001 });
    }
    if (endpoint === 'repos/octo/widget/pulls/7') return ok({ head: { sha: remote } });
    if (options.recoverResolution && endpoint.includes('/pulls/7/comments'))
      return ok([
        ...threads.map((thread) => ({
          id: thread.comments.nodes[0]!.databaseId,
          in_reply_to_id: null,
          body: thread.comments.nodes[0]!.body,
          user: { login: 'reviewer' },
          created_at: thread.comments.nodes[0]!.createdAt,
        })),
        ...replies,
      ]);
    if (options.discussion && endpoint.includes('/pulls/7/comments'))
      return ok([
        {
          id: 101,
          in_reply_to_id: null,
          body: 'Fix T1',
          path: 'src/a.ts',
          line: 1,
          user: { login: 'reviewer' },
          created_at: new Date(Date.now() - 60000).toISOString(),
        },
        {
          id: 201,
          in_reply_to_id: 101,
          body: 'FOLLOWUP-REQUIREMENT: the correction must preserve GOOD.',
          path: 'src/a.ts',
          line: 1,
          user: { login: 'reviewer' },
          created_at: new Date(Date.now() - 30000).toISOString(),
        },
      ]);
    if (endpoint.includes('/comments') || endpoint.includes('/reviews?')) return ok([]);
    return { code: 1, stdout: '', stderr: `unhandled forge: ${args.join(' ')}` };
  };
  const git: GhFn = async (args) => {
    const cwd = args[0] === '-C' ? args[1]! : root;
    const scoped = args[0] === '-C' ? args.slice(2) : args;
    const hardened = GIT_HARDEN.every((arg, i) => scoped[i] === arg);
    const a = hardened ? scoped.slice(GIT_HARDEN.length) : scoped;
    const localHead = heads.get(cwd) ?? head;
    const tree = trees.get(localHead) ?? initialTree;
    const index = indices.get(cwd) ?? new Map(tree);
    const changed: string[] = [];
    for (const file of files) {
      let text = '';
      try {
        text = await readFile(join(cwd, file), 'utf8');
      } catch {
        /* Absent paths are dirty in this in-memory git model. */
      }
      if (text !== (a.includes('HEAD') ? tree : index).get(file)) changed.push(file);
    }
    if (a[0] === 'worktree' && a[1] === 'add') {
      const dest = a[3]!,
        parent = a[4]!;
      await mkdir(join(dest, 'src'), { recursive: true });
      for (const [file, text] of trees.get(parent) ?? []) await writeFile(join(dest, file), text);
      heads.set(dest, parent);
      indices.set(dest, new Map(trees.get(parent)));
      return ok('');
    }
    if (a[0] === 'worktree' && a[1] === 'remove') {
      heads.delete(a[3]!);
      indices.delete(a[3]!);
      await rm(a[3]!, { recursive: true, force: true });
      return ok('');
    }
    if (a[0] === 'symbolic-ref') return ok('refs/heads/cq-review/pr-7');
    if (a[0] === 'ls-files') return ok('');
    if (a[0] === 'add') {
      for (const file of a.slice(a.indexOf('--') + 1))
        index.set(file, await readFile(join(cwd, file), 'utf8'));
      indices.set(cwd, index);
      return ok('');
    }
    if (a[0] === 'show' && a[1]?.includes(':')) {
      const separator = a[1].indexOf(':');
      const text = trees.get(a[1].slice(0, separator))?.get(a[1].slice(separator + 1));
      return text === undefined
        ? { code: 1, stdout: '', stderr: 'missing citation at execution head' }
        : ok(text);
    }
    if (a[0] === 'write-tree') {
      const sha = treeHash(index);
      trees.set(sha, new Map(index));
      return ok(sha);
    }
    if (a[0] === 'stash') return ok('');
    if (a[0] === 'restore') {
      for (const file of a.slice(a.indexOf('--') + 1))
        await writeFile(join(cwd, file), tree.get(file)!);
      indices.set(cwd, new Map(tree));
      return ok('');
    }
    if (a[0] === 'commit') {
      const sha = fixed;
      commits.set(sha, { parent: localHead, message: a[2]!, tree: treeHash(index) });
      trees.set(sha, new Map(index));
      heads.set(cwd, sha);
      head = sha;
      return ok('');
    }
    if (a[0] === 'diff' && a[1] !== '--quiet') {
      const indexed = [...index]
        .filter(([file, text]) => text !== tree.get(file))
        .map(([file]) => file);
      if (a.includes('--name-only'))
        return ok(
          (a.includes('--cached') ? indexed : changed)
            .map((path) => path + (a.includes('-z') ? '\0' : '\n'))
            .join(''),
        );
      return ok(
        indexed
          .map(
            (file) =>
              `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-BAD\n+GOOD\n`,
          )
          .join(''),
      );
    }
    if (a[0] === 'fetch') return ok('');
    if (a[0] === 'worktree' && a[1] === 'list')
      return ok(`worktree ${worktree}\nHEAD ${head}\nbranch refs/heads/cq-review/pr-7\n\n`);
    if (a[0] === 'rev-parse') {
      if (a.includes('--git-common-dir')) return ok(join(root, 'git'));
      if (a[1] === '--absolute-git-dir') return ok(join(root, 'git'));
      if (a[1] === '--abbrev-ref') return ok('cq-review/pr-7');
      if (a[1] === '--verify') {
        const sha = a[2]!.replace('HEAD', head).replace(/\^\{commit\}$/, '');
        return sha === initial || commits.has(sha)
          ? ok(sha)
          : { code: 1, stdout: '', stderr: 'unknown commit' };
      }
      if (a[1]?.endsWith('^{tree}'))
        return ok(commits.get(a[1].slice(0, -7))?.tree ?? treeHash(tree));
      if (a[1]?.endsWith('^')) return ok(commits.get(a[1].slice(0, -1))?.parent ?? initial);
      return ok(a[1]?.startsWith('refs/cq-review/') ? remote : localHead);
    }
    if (a[0] === 'status') return ok('');
    if (a[0] === 'rev-list') return ok(a[1] === `${initial}..HEAD` && head !== initial ? head : '');
    if (a[0] === 'merge-base') {
      const from = a[2],
        to = a[3] === 'HEAD' ? head : a[3];
      return {
        code: from === to || commits.get(to!)?.parent === from ? 0 : 1,
        stdout: '',
        stderr: '',
      };
    }
    if (a[0] === 'log') return ok(commits.get(a[3]!)?.message ?? '');
    if (a[0] === 'diff' && a[1] === '--quiet') return { code: 1, stdout: '', stderr: '' };
    if (a[0] === 'push') {
      remote = head;
      actions.push('push');
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unhandled git: ${args.join(' ')}` };
  };
  const drivers: DriverFactory = {
    resolve: ({ modelSpec }) => ({
      lane: 'ai-sdk',
      modelSpec,
      driver: {
        run: async (input) => {
          prompts.push(input.prompt);
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return {
              stopReason: 'complete',
              structuredOutput: { closed: true, reason: 'candidate closed' },
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          const deferred = human && input.prompt.includes('"id":"T2"');
          if (!deferred && !input.prompt.startsWith('related-check feedback'))
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
          return {
            stopReason: 'complete',
            structuredOutput: {
              disposition: deferred ? 'deferred' : 'fixed',
              reason: deferred ? 'human' : 'fixed',
              evidence: deferred ? [{ path: 'src/b.ts', line: 1 }] : [],
            },
            usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          };
        },
      },
    }),
  };
  const role = { provider: 'fixture', model: 'scripted' };
  const op = makeReviewAddress({
    git,
    gh,
    drivers,
    config: {
      schemaVersion: 2,
      checks: [
        {
          adapter: 'tsc-lines',
          command: { command: process.execPath, args: ['-e', 'process.exitCode=0'] },
        },
      ],
      roles: { worker: role, reviewer: role },
      budgets: { run: { maxTokens: 1000 } },
      review: { rounds: 1, reviewers: ['agent'] },
      escalation: { workerAttempts: 1, rescueBase: 0 },
    },
    disposition: async () => ({ status: 'ok', value: {} }),
    review: async () => {
      reviewerCalls++;
      return options.reviewOutcome === 'failed'
        ? {
            status: 'failed',
            error: 'scripted reviewer could not complete',
          }
        : {
            status: 'ok',
            value: {
              schemaVersion: 1,
              branch: 'cq-review/pr-7',
              head: options.reviewOutcome === 'wrong-head' ? initial : head,
              sources: [{ kind: 'agent', status: 'terminal' }],
              findings:
                options.reviewOutcome === 'open-finding'
                  ? [
                      {
                        id: 'agent-follow-up',
                        source: 'agent',
                        file: 'src/a.ts',
                        line: 1,
                        text: 'The assigned fix still needs a correction',
                        severity: 'major',
                        status: 'open',
                      },
                    ]
                  : [],
            },
          };
    },
    workerFactory: (deps) =>
      makeAddressWorker({
        ...deps,
        scanner: async (components) =>
          components.map((c) => ({ component: c.component, hits: [] })),
      }),
  });
  return {
    root,
    actions,
    prompts,
    resolved,
    reviewerCalls: () => reviewerCalls,
    replies,
    changeLogin: () => {
      login = 'another-responder';
    },
    clearReceipts: () =>
      rm(join(root, 'git', 'cq-review-address'), { recursive: true, force: true }),
    run: async (push = true, target?: string) => {
      const result = await op({
        repoRoot: root,
        source: 'pr:7',
        push,
        ...(target ? { target } : {}),
        ...(options.recoverResolution ? {} : { journalDir: join(root, 'journal') }),
      });
      reports.push((result.status === 'ok' ? result.value : result.report!).reportPath);
      return result;
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      if (options.recoverResolution)
        for (const path of reports) await rm(dirname(path), { recursive: true, force: true });
    },
  };
}
describe('review.address PR phase-one orchestration', () => {
  test.each(['failed', 'wrong-head', 'open-finding'] as const)(
    'verified PR work is retained but fresh %s re-review cannot announce clean',
    async (reviewOutcome) => {
      const w = await world(false, { reviewOutcome });
      try {
        const result = await w.run();
        expect(result.status).toBe('needs-human');
        const report = result.status === 'ok' ? result.value : result.report!;
        expect(report.fixesPerRun).toBe(1);
        expect(w.actions).toContain('push');
        expect(w.actions).not.toContain('rerequest');
        expect(report.reasons.join(' ')).toMatch(/PR re-review|round cap/);
        if (reviewOutcome === 'open-finding') {
          expect(w.prompts.some((p) => p.includes('agent-follow-up'))).toBe(true);
          expect(report.openBlocking.some((f) => f.id === 'agent-follow-up')).toBe(true);
        }
        expect(JSON.parse(await readFile(report.reportPath, 'utf8'))).toEqual(report);
      } finally {
        await w.cleanup();
      }
    },
  );
  test('current follow-up discussion reaches edit, mandatory feedback and candidate closure', async () => {
    const w = await world(false, { discussion: true });
    try {
      const result = await w.run();
      expect(result.status, JSON.stringify(result)).toBe('ok');
      expect(w.prompts).toHaveLength(3);
      for (const prompt of w.prompts) {
        expect(prompt).toContain('FOLLOWUP-REQUIREMENT');
        expect(prompt).toContain('reviewer');
      }
      expect(w.resolved.has('T1')).toBe(true);
    } finally {
      await w.cleanup();
    }
  });
  test.each(['same-file', 'fileless-first', 'fileless-last'] as const)(
    'human settlement preserves successful sibling dispatch and publication: %s',
    async (kind) => {
      const w = await world(
        true,
        kind === 'same-file'
          ? { sameFile: true }
          : { fileless: kind === 'fileless-first' ? 'first' : 'last' },
      );
      try {
        const result = await w.run();
        expect(result.status, JSON.stringify(result)).toBe('needs-human');
        expect(result.report?.fixesPerRun).toBe(1);
        expect(result.report?.fixes.map((fix) => fix.finding.id)).toEqual(
          kind === 'fileless-last' ? ['T1', 'T2'] : ['T2', 'T1'],
        );
        expect(result.report?.fixes.some((fix) => fix.finding.id === 'T1' && fix.commit)).toBe(
          true,
        );
        expect(w.resolved.has('T1')).toBe(true);
        expect(w.resolved.has('T2')).toBe(false);
        expect(w.actions.indexOf('push')).toBeLessThan(w.actions.indexOf('resolve:T1'));
        expect(result.report?.openBlocking).toMatchObject([
          {
            id: 'T2',
            status: 'deferred',
            reason: kind === 'same-file' ? 'human' : 'unanchored finding needs human scope',
          },
        ]);
        expect(
          result.report?.rounds[0]?.run?.jobs.every((row) => row.result.status !== 'failed'),
        ).toBe(true);
      } finally {
        await w.cleanup();
      }
    },
  );
  test('resolved bot source retains advisory evidence without an unsupported API request', async () => {
    const w = await world(false, { bot: true });
    try {
      const result = await w.run();
      expect(result.status, JSON.stringify(result)).toBe('ok');
      expect(w.resolved.has('T1')).toBe(true);
      expect(w.actions).not.toContain('rerequest');
      if (result.status === 'ok')
        expect(result.value.reasons).toContainEqual(
          expect.stringContaining('no bot re-request performed'),
        );
    } finally {
      await w.cleanup();
    }
  });
  test('verified publication precedes reply/resolve; clean re-review re-requests once', async () => {
    const w = await world();
    try {
      const result = await w.run();
      expect(result.status, JSON.stringify(result)).toBe('ok');
      expect(w.actions[0]).toBe('push');
      expect(w.actions.filter((a) => a !== 'push')).toEqual(['reply', 'resolve:T1', 'rerequest']);
      if (result.status === 'ok') {
        expect(result.value.fixesPerRun).toBe(1);
        expect(result.value.openBlocking).toEqual([]);
      }
    } finally {
      await w.cleanup();
    }
  });
  test('a human sibling stays open while the verified sibling publishes and resolves', async () => {
    const w = await world(true);
    try {
      const result = await w.run();
      expect(result.status, JSON.stringify(result)).toBe('needs-human');
      expect(w.resolved.has('T1')).toBe(true);
      expect(w.resolved.has('T2')).toBe(false);
      expect(w.actions).not.toContain('rerequest');
      expect(result.report?.fixesPerRun).toBe(1);
      expect(result.report?.openBlocking).toMatchObject([{ id: 'T2', status: 'deferred' }]);
    } finally {
      await w.cleanup();
    }
  });
  test('publication opt-out keeps verified local work and makes no forge mutations', async () => {
    const w = await world();
    try {
      const result = await w.run(false);
      expect(result.status).toBe('needs-human');
      expect(w.actions).toEqual([]);
      expect(result.report?.fixesPerRun).toBe(1);
    } finally {
      await w.cleanup();
    }
  });
});

test.each([
  'valid',
  'missing-receipt',
  'forged-author',
  'stale-head',
  'changed-actor',
  'changed-target',
] as const)('default PR rerun recovers only authenticated pending resolution: %s', async (mode) => {
  const w = await world(false, { recoverResolution: true });
  try {
    const first = await w.run();
    expect(first.status).toBe('needs-human');
    expect(w.actions).toContain('resolve-failed');
    expect(w.actions.filter((a) => a === 'reply')).toHaveLength(1);
    expect(w.resolved.has('T1')).toBe(false);
    const edits = w.prompts.length;
    const reviewerCalls = w.reviewerCalls();
    const actions = w.actions.length;
    const firstPath = first.report!.reportPath;
    expect(w.replies[0]?.body).toContain('resolve');
    if (mode === 'missing-receipt') await w.clearReceipts();
    if (mode === 'forged-author') w.replies[0]!.user.login = 'forger';
    if (mode === 'stale-head') w.replies[0]!.body = w.replies[0]!.body.replaceAll(fixed, initial);
    if (mode === 'changed-actor') w.changeLogin();
    const second = await w.run(true, mode === 'changed-target' ? 'another-target' : undefined);
    const report = second.status === 'ok' ? second.value : second.report!;
    expect(report.reportPath).not.toBe(firstPath);
    if (mode === 'valid') {
      expect(
        second.status,
        JSON.stringify({
          reasons: report.reasons,
          actions: w.actions.slice(actions),
          replies: w.replies,
        }),
      ).toBe('ok');
      expect(w.actions.slice(actions)).toEqual(['resolve:T1']);
      expect(w.prompts).toHaveLength(edits); // no editing/feedback/closure provider dispatch
      expect(w.reviewerCalls()).toBe(reviewerCalls + 1); // fresh mandatory terminal re-review
      expect(report.fixesPerRun).toBe(0);
    } else {
      expect(second.status).toBe('needs-human');
      expect(w.resolved.has('T1')).toBe(false);
      expect(w.prompts.length).toBeGreaterThan(edits);
      expect(w.actions.slice(actions)).not.toContain('resolve:T1');
    }
  } finally {
    await w.cleanup();
  }
});
