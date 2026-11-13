// Split provenance: test/ops/review/address-pr.test.ts was split by subject
// into address-pr.admission.test.ts, address-pr.rereview.test.ts,
// address-pr.threadSources.test.ts, address-pr.humanDeferral.test.ts,
// address-pr.publication.test.ts, address-pr.exitPublication.test.ts and
// address-pr.recovery.test.ts. This module holds the shared phase-one
// orchestration fixture; it declares no tests.
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import type { CqSeverity } from '../../../src/ops/analyze/cqConfig.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeAddressWorker } from '../../../src/ops/review/addressWorker.js';
import type { ReviewRunInput } from '../../../src/ops/review/run.js';
import { replyHeadStamp, replySignature, settleRound } from '../../../src/plans/review-loop.js';
import { GIT_HARDEN } from '../../../src/shared/gitHarden.js';

export const initial = 'a'.repeat(40),
  fixed = 'b'.repeat(40);
const ok = (value: unknown): GhResult => ({
  code: 0,
  stdout: typeof value === 'string' ? value : JSON.stringify(value),
  stderr: '',
});
/** Phase-one orchestration world: no git process, provider package, credentials or forge network. */
export async function world(
  human = false,
  options: {
    runBudget?: number;
    fork?: boolean;
    verifyClosure?: boolean;
    refuseAdmissionAt?: number;
    admissionPrecondition?: string;
    postFixSnapshotFailure?: boolean;
    sameFile?: boolean;
    fileless?: 'first' | 'last';
    bot?: boolean;
    discussion?: boolean;
    recoverResolution?: boolean;
    reviewOutcome?: 'failed' | 'wrong-head' | 'open-finding';
    /** A second thread whose worker crashes: the row genuinely FAILS. */
    failer?: boolean;
    /** Review rounds (default 1): a multi-round publication-range run. */
    rounds?: number;
    /** Distinct commit shas per commit (default: the single `fixed` sha). */
    incrementingCommits?: boolean;
    /** Fail every git push from this 1-based ordinal on with the scripted stderr. */
    failPushFrom?: { ordinal: number; stderr: string };
    /** Caller-asserted PR head (the pr:N base witness inputs). */
    expectedHead?: string;
    /** Fail every merge-base read, so the composition's PR pin cannot resolve. */
    failMergeBase?: boolean;
    /**
     * The clone NAMES the asserted head but does not CONTAIN its object: ref
     * and string paths resolve it (admission and the worktree guard agree on
     * the sha), while an object read — `rev-parse --verify <oid>^{commit}`,
     * the base witness's own probe — fails.
     */
    missingHeadObject?: boolean;
    /** Run wall override (default: the engine's six-hour review wall). */
    wallMs?: number;
    /** Observe each item's fix AFTER it settles, e.g. to advance a test clock. */
    afterFix?: (id: string) => void;
    /** Engine dispatch concurrency (default: the policy's own setting). */
    concurrency?: number;
    /** Blocking severities for the round's planned population (default: the policy's own). */
    blockingSeverities?: readonly CqSeverity[];
    /**
     * Every thread's latest REST reply is the responder's own settled loop
     * reply — the signature line plus a head stamp naming the checked-out
     * head and the thread's settle round — so the whole plan is skipped
     * (loop-replied-this-head) and onItemsPlanned sees an empty list.
     */
    settledLoopReplies?: boolean;
    /**
     * PR-state graphql queries (the $reviewsAfter document) from this
     * 1-based ordinal on answer truncated reviewThreads pagination
     * (hasNextPage with no endCursor) while earlier queries stay complete:
     * ordinal 2 keeps the loop's classification fetch complete and makes the
     * engine's post-dispatch fetch fail closed.
     */
    truncatePrStateFrom?: number;
  } = {},
) {
  // The failer knob only has a defined thread order inside the default
  // ordering (its T3 crasher and the human-conditional T2 tail are appended
  // there); combined with human/sameFile/fileless it would silently drop or
  // reorder a thread, so refuse the combination instead of testing the
  // wrong world.
  if (options.failer && (human || options.sameFile || options.fileless))
    throw new Error('world(): failer cannot be combined with human, sameFile or fileless');
  if (options.missingHeadObject && options.expectedHead === undefined)
    throw new Error('world(): missingHeadObject requires expectedHead');
  const root = await realTmpDir('cq-address-memory-');
  const worktree = join(root, 'git', 'cq-review-worktrees', 'worker');
  await mkdir(worktree, { recursive: true });
  // A PR head the clone does not contain YET: the head ref names it (ref and
  // string paths resolve the sha, exactly as they do in a fresh clone whose
  // refs were fetched later), but the COMMIT object only arrives with the
  // PR-head fetch the loop performs. So the base witness's object read — the
  // one probe that runs BEFORE that fetch — fails, and every later object read
  // succeeds. That is the production ordering this branch models.
  const seedHead = options.missingHeadObject ? options.expectedHead : undefined;
  let prHeadObjectArrived = false;
  let head = seedHead ?? initial,
    remote = seedHead ?? initial;
  const resolved = new Set<string>();
  let failResolve = options.recoverResolution === true;
  let login = 'responder';
  let reviewerCalls = 0;
  let admissionCalls = 0;
  let prStateCalls = 0;
  const reports: string[] = [];
  const replies: Array<{
    id: number;
    in_reply_to_id: number;
    body: string;
    user: { login: string };
    created_at: string;
  }> = [];
  const actions: string[] = [];
  const pushes: string[][] = [];
  const prompts: string[] = [];
  const reviewInputs: ReviewRunInput[] = [];
  let pushFault: (() => string) | undefined;
  let pushOrdinal = 0;
  let commitSeq = 0;
  const editWrites = new Map<string, number>();
  const files = ['src/a.ts', 'src/b.ts'];
  await mkdir(join(worktree, 'src'), { recursive: true });
  for (const file of files) await writeFile(join(worktree, file), 'BAD\n');
  const initialTree = new Map(files.map((file) => [file, 'BAD\n']));
  const trees = new Map<string, Map<string, string>>([[initial, new Map(initialTree)]]);
  if (seedHead !== undefined) trees.set(seedHead, new Map(initialTree));
  const heads = new Map<string, string>([[worktree, seedHead ?? initial]]);
  const indices = new Map<string, Map<string, string>>([[worktree, new Map(initialTree)]]);
  const treeHash = (tree: Map<string, string>) =>
    createHash('sha1')
      .update(JSON.stringify([...tree].sort()))
      .digest('hex');
  const commits = new Map<string, { parent: string; message: string; tree: string }>();
  const order = options.sameFile
    ? ['T2', 'T1']
    : options.fileless === 'first'
      ? ['T2', 'T1']
      : options.fileless === 'last'
        ? ['T1', 'T2']
        : ['T1', ...(options.failer ? ['T3'] : []), ...(human ? ['T2'] : [])];
  const threads = order.map((id, i) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path:
      options.fileless && id === 'T2'
        ? null
        : id === 'T3'
          ? // T3 targets src/b.ts by identity, never by its position in the
            // order above, so a reordering cannot silently retarget its file.
            'src/b.ts'
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
        headRepositoryOwner: { login: options.fork ? 'fork-owner' : 'octo' },
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
      // The PR-state document is the only graphql query carrying
      // $reviewsAfter (the resolved-threads snapshot query does not), so
      // that substring counts exactly the fetchReviewState pagination loops.
      const prState = query.includes('$reviewsAfter');
      if (prState) prStateCalls += 1;
      const truncatedThreads =
        options.truncatePrStateFrom !== undefined && prStateCalls >= options.truncatePrStateFrom;
      return ok({
        data: {
          repository: {
            pullRequest: {
              author: { login: 'prauthor' },
              headRefName: 'feature',
              headRefOid: remote,
              reviewThreads: {
                nodes: threads.map((t) => ({ ...t, isResolved: resolved.has(t.id) })),
                // hasNextPage with no endCursor is the fail-closed
                // truncation: the fetch keeps the page's data and records
                // the truncatedBecause cause.
                pageInfo: truncatedThreads
                  ? { hasNextPage: true, endCursor: null }
                  : { hasNextPage: false, endCursor: null },
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
    if (endpoint === 'repos/octo/widget/pulls/7') {
      if (options.postFixSnapshotFailure && head === fixed)
        throw new Error('scripted post-fix snapshot failure');
      return ok({ head: { sha: remote } });
    }
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
    if (options.settledLoopReplies && endpoint.includes('/pulls/7/comments'))
      return ok([
        // Chain roots: each thread's own root comment (the GraphQL root
        // databaseId join attachRestReplies matches on).
        ...threads.map((thread) => ({
          id: thread.comments.nodes[0]!.databaseId,
          in_reply_to_id: null,
          body: thread.comments.nodes[0]!.body,
          user: { login: 'reviewer' },
          created_at: thread.comments.nodes[0]!.createdAt,
        })),
        // The responder's settled loop reply on every thread: signature
        // line, a head stamp binding the checked-out head and the thread's
        // settle round (no prior replies), then the summary after a blank
        // line — the exact header shape loopReplyVerdict authenticates.
        ...threads.map((thread) => ({
          id: 900 + thread.comments.nodes[0]!.databaseId,
          in_reply_to_id: thread.comments.nodes[0]!.databaseId,
          body: [
            replySignature('octo', 'widget', 7),
            replyHeadStamp(
              initial,
              settleRound({ id: thread.id, body: thread.comments.nodes[0]!.body }, []),
            ),
            '',
            'answered in the prior run',
          ].join('\n'),
          user: { login },
          created_at: new Date().toISOString(),
        })),
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
      // The default world models one fix with the single `fixed` sha; the
      // incrementing option gives every commit its own sha so a multi-round
      // run can prove per-range publication truth (A out, B local).
      commitSeq += 1;
      const sha = options.incrementingCommits ? `c${String(commitSeq).padStart(39, '0')}` : fixed;
      commits.set(sha, { parent: localHead, message: a[2]!, tree: treeHash(index) });
      trees.set(sha, new Map(index));
      heads.set(cwd, sha);
      head = sha;
      return ok('');
    }
    if (a[0] === 'diff' && a.includes('--quiet')) {
      const dirty = a.includes('--cached')
        ? [...index].some(([file, text]) => text !== tree.get(file))
        : changed.length > 0;
      return { code: a.some((arg) => arg.includes('..')) || dirty ? 1 : 0, stdout: '', stderr: '' };
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
    if (a[0] === 'fetch') {
      // The PR-head fetch is what BRINGS the asserted head's commit object.
      if (a.some((arg) => arg.includes('refs/pull/'))) prHeadObjectArrived = true;
      return ok('');
    }
    if (a[0] === 'worktree' && a[1] === 'list')
      return ok(`worktree ${worktree}\nHEAD ${head}\nbranch refs/heads/cq-review/pr-7\n\n`);
    if (a[0] === 'rev-parse') {
      if (a.includes('--git-common-dir')) return ok(join(root, 'git'));
      if (a[1] === '--absolute-git-dir') return ok(join(root, 'git'));
      if (a[1] === '--abbrev-ref') return ok('cq-review/pr-7');
      if (a[1] === '--verify') {
        const sha = a[2]!.replace('HEAD', head).replace(/\^\{commit\}$/, '');
        return sha === initial || commits.has(sha) || (sha === seedHead && prHeadObjectArrived)
          ? ok(sha)
          : { code: 1, stdout: '', stderr: 'unknown commit' };
      }
      if (a[1]?.endsWith('^{tree}'))
        return ok(commits.get(a[1].slice(0, -7))?.tree ?? treeHash(tree));
      if (a[1]?.endsWith('^')) return ok(commits.get(a[1].slice(0, -1))?.parent ?? initial);
      return ok(a[1]?.startsWith('refs/cq-review/') ? remote : localHead);
    }
    if (a[0] === 'status') return ok('');
    if (a[0] === 'rev-list') {
      // Only the plain `<base>..<tip>` form walks the parent chain (so a
      // second round's `publishedBase..HEAD` enumerates exactly the later
      // commits); every flagged form (--count, --parents, …) keeps the
      // legacy empty answer.
      if (!a[1]!.includes('..')) return ok('');
      const from = a[1]!.split('..')[0]!;
      const out: string[] = [];
      let cur = a[1]!.split('..')[1] === 'HEAD' ? head : a[1]!.split('..')[1]!;
      while (cur !== from && commits.has(cur)) {
        out.push(cur);
        cur = commits.get(cur)!.parent;
      }
      return cur === from ? ok(out.join('\n')) : { code: 1, stdout: '', stderr: 'bad range' };
    }
    if (a[0] === 'merge-base') {
      if (options.failMergeBase)
        return { code: 1, stdout: '', stderr: 'fake: merge-base unresolved' };
      const from = a[2],
        to = a[3] === 'HEAD' ? head : a[3];
      // The read form (with --end-of-options, four args) returns the actual
      // base sha: the composition's base capture consumes the stdout. The
      // fake models every origin target's merge-base with HEAD as the head's
      // parent, so downstream guards (e.g. changed-target) stay in charge.
      if (a[1] === '--end-of-options') return ok(commits.get(head)?.parent ?? initial);
      return {
        code: from === to || commits.get(to!)?.parent === from ? 0 : 1,
        stdout: '',
        stderr: '',
      };
    }
    if (a[0] === 'log') return ok(commits.get(a[3]!)?.message ?? '');
    if (a[0] === 'remote' && a[1] === 'get-url') return ok('https://github.com/octo/widget.git\n');
    if (a[0] === 'ls-remote') return ok(`${remote}\trefs/heads/feature\n`);
    if (a[0] === 'push') {
      pushes.push(a);
      if (a[1] !== `--force-with-lease=refs/heads/feature:${remote}`)
        return { code: 1, stdout: '', stderr: 'stale or missing explicit lease' };
      if (
        a[2] !==
          (options.fork
            ? 'https://github.com/fork-owner/widget.git'
            : 'https://github.com/octo/widget.git') &&
        a[2] !== (options.fork ? '' : 'origin')
      )
        return { code: 1, stdout: '', stderr: 'wrong head repository' };
      pushOrdinal += 1;
      if (pushFault !== undefined) {
        const stderr = pushFault();
        return { code: 1, stdout: '', stderr };
      }
      if (options.failPushFrom !== undefined && pushOrdinal >= options.failPushFrom.ordinal)
        return { code: 1, stdout: '', stderr: options.failPushFrom.stderr };
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
          if (!deferred && !input.prompt.startsWith('related-check feedback')) {
            // In an incrementing-commit world, a later round's re-fix must
            // be a REAL edit: identical content would be a no-op diff, which
            // the worker treats as a failed candidate instead of a verified
            // commit — so every later write appends a refinement line. The
            // default single-sha world keeps its identical-content re-fixes
            // (no second commit, unchanged legacy behavior).
            const file = join(input.workspace!.path, 'src/a.ts');
            const writes = (editWrites.get(file) ?? 0) + 1;
            editWrites.set(file, writes);
            await writeFile(
              file,
              writes === 1 || !options.incrementingCommits
                ? 'GOOD\n'
                : `GOOD\n// refinement ${String(writes)}\n`,
            );
          }
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
      budgets: {
        run: {
          maxTokens: options.runBudget ?? 1000,
          ...(options.wallMs === undefined ? {} : { wallMs: options.wallMs }),
        },
      },
      review: {
        rounds: options.rounds ?? 1,
        reviewers: ['agent'],
        ...(options.blockingSeverities
          ? { blockingSeverities: [...options.blockingSeverities] }
          : {}),
        ...(options.refuseAdmissionAt || options.concurrency !== undefined
          ? { addressConcurrency: options.concurrency ?? 1 }
          : {}),
      },
      escalation: { workerAttempts: 1, rescueBase: 0 },
    },
    disposition: async () => ({ status: 'ok', value: {} }),
    review: async (input) => {
      reviewInputs.push(input);
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
    workerFactory: (deps) => {
      const worker = makeAddressWorker({
        ...deps,
        scanner: async (components) =>
          components.map((c) => ({ component: c.component, hits: [] })),
      });
      return {
        ...worker,
        preconditionFailure: () =>
          (admissionCalls >= (options.refuseAdmissionAt ?? Infinity)
            ? options.admissionPrecondition
            : undefined) ?? worker.preconditionFailure?.(),
        async withVerifiedHead<T>(action: (head: string) => Promise<T>) {
          if (++admissionCalls === options.refuseAdmissionAt)
            throw new Error('scripted admission ownership changed');
          return worker.withVerifiedHead!(action);
        },
        fix: async (finding, round) => {
          if (options.failer && finding.id === 'T3')
            throw new Error('worker crash: scripted T3 fault');
          const fix = await worker.fix(finding, round);
          options.afterFix?.(finding.id);
          return fix;
        },
      };
    },
  });
  return {
    root,
    actions,
    pushes,
    prompts,
    reviewInputs,
    resolved,
    reviewerCalls: () => reviewerCalls,
    replies,
    /** The remote head the fake forge saw: only a successful push moves it. */
    remoteHead: () => remote,
    /**
     * Arm a persistent git-push fault: EVERY git push after this call
     * returns exit 1 with the scripted stderr, and nothing disarms the
     * fault. The push-fault test below relies on
     * the fault riding every push of the run: the loop's stage-5 publish,
     * replyAndResolve's push-before-post, and the engine's publishOnExit
     * push through finish(). Disarming after the first firing would let
     * those later pushes succeed and the "verified publication failed"
     * outcome rewrite would never fire (PR #470 verdict P2 #1).
     */
    failEveryPush: (script: () => string) => {
      pushFault = script;
    },
    changeLogin: () => {
      login = 'another-responder';
    },
    clearReceipts: () =>
      rm(join(root, 'git', 'cq-review-address'), { recursive: true, force: true }),
    run: async (push = true, target?: string) => {
      const result = await op({
        repoRoot: root,
        source: 'pr:7',
        ...(options.expectedHead === undefined ? {} : { expectedHead: options.expectedHead }),
        ...(options.verifyClosure ? { verifyClosure: true } : {}),
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
