import { join } from 'node:path';
import { fixture, deferred } from './addressManyWorktree.helpers.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { runReviewLoop, type ReviewLoopOpts } from '../../../src/plans/review-loop.js';
import { fakeGh } from '../../selfhost/self-review-loop-fakes.js';

export { deferred };
export async function slotFixture() {
  const f = await fixture();
  const common = f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const opts = (pr = 7): ReviewLoopOpts => ({
    owner: 'octo',
    repo: 'widget',
    pr,
    headRefName: 'feature/x',
    repoRoot: f.repo.root,
    git: f.run,
    gh: fakeGh([], {
      stateRoutes: true,
      singlePull: (number) => ({
        state: 'open',
        draft: false,
        head: {
          ref: 'feature/x',
          sha: f.prs.find((row) => row.number === number)!.headRefOid,
        },
      }),
    }),
    registry: slotWorktreeRegistry(common),
    driver: { provider: 'mock', model: 'offline' },
    nowMs: 1,
    dispatchLogPath: join(f.root, `dispatch-${pr}.jsonl`),
    worktreeRoot: f.worktreeRoot,
    publish: false,
  });
  return { ...f, common, opts };
}
/** Wait for a barrier or the actual invocation's early result; no polling/sleep. */
export async function reached(barrier: Promise<void>, invocation: Promise<unknown>): Promise<void> {
  await Promise.race([
    barrier,
    invocation.then((value) => {
      throw new Error(`invocation returned before barrier: ${JSON.stringify(value)}`);
    }),
  ]);
}
export async function pausedLoop(opts: ReviewLoopOpts) {
  const entered = deferred(),
    release = deferred();
  let path = '';
  const pending = runReviewLoop({
    ...opts,
    onWorktreeResolved: async (info) => {
      path = info.path;
      entered.resolve();
      await release.promise;
    },
  });
  // Immediately observe errors while the test drives a second entrypoint.
  void pending.catch(() => undefined);
  await reached(entered.promise, pending);
  return { path, pending, release: release.resolve };
}
