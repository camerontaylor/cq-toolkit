// Analyze lane G2 — test evidence for the ast-grep codemod path: the JSON
// wire parse (planned edits vs honestly-counted unfixed matches), the
// scan's verdict policy (a non-zero exit behind parsable JSON is the
// error-severity contract, not a failure; a lost exit is a fault naming the
// missing binary), the collision block, the exact splice semantics of the
// apply, the synthesized unified diffs (hunks, no-newline markers), and the
// op's approval gate — an apply without `approved: true` refuses before any
// I/O. All through INJECTED runners and stores: no ast-grep binary, no real
// fs.
//
// Split provenance: test/ops/analyze/codemod/astGrep.test.ts was split into
// astGrep.parse.test.ts, astGrep.scan.test.ts, astGrep.collision.test.ts,
// astGrep.diff.test.ts, astGrep.codemod-approval.test.ts,
// astGrep.codemod-plan.test.ts, astGrep.codemod-write-safety.test.ts and
// astGrep.codemod-target-policy.test.ts; shared fixtures live in
// astGrep.helpers.ts.
import { describe, expect, test } from 'vitest';
import type { ApprovalState, ExercisedScope } from '../../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
  withApprovedMutation,
} from '../../../../src/ops/analyze/approval.js';
import { makeAstGrepCodemod } from '../../../../src/ops/analyze/codemod/astGrep.js';
import {
  FIXTURE_FILES,
  memoryStore,
  scanRunner,
  scanRunnerFor,
  trustedAuthority,
} from './astGrep.helpers.js';

describe('makeAstGrepCodemod (the op: approval gate first, then scan → collision → write)', () => {
  // W4.3 / A16: the standalone op is a REGISTRY ENTRY, so untrusted plan JSON
  // can name it. Before the authority existed, `approved: true` alone
  // authorized its write. These pin that the flag is now necessary but never
  // sufficient.
  describe('the mutation is authorized by an approval, not by the input flag', () => {
    test('a lock RELEASE fault after the write is a failed result naming the write set, not a rejection', async () => {
      const store = memoryStore(FIXTURE_FILES);
      const state: ApprovalState = { workspace: '/ws', headSha: 'codemod-head', treeClean: true };
      const real = makeProcessLocalMutationLocks();
      const authority = makeApprovalAuthority({
        approvals: {
          verifiedFor: (subject) =>
            Promise.resolve({ nonce: `codemod-${subject.inputDigest.slice(0, 12)}`, state }),
        },
        ledger: makeInMemoryNonceLedger(),
        locks: {
          forWorkspace: (workspace) => ({
            withLock: async <T>(fn: () => T | Promise<T>): Promise<T> => {
              await real.forWorkspace(workspace).withLock(fn);
              throw new Error('git-mutex: release failed');
            },
          }),
        },
        readState: { read: () => Promise.resolve(state) },
      });
      const result = await makeAstGrepCodemod(
        scanRunnerFor('src/a.ts'),
        () => store,
        authority,
      )({
        dir: '/ws',
        rule: 'r',
        files: ['src/a.ts'],
        dryRun: false,
        approved: true,
      });
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') return;
      expect(result.error).toContain('mutation lock faulted');
      expect(result.error).toContain('token is spent');
      expect(result.error).toContain("'src/a.ts'");
    });

    test('deny-all: approved:true alone writes nothing', async () => {
      const store = memoryStore(FIXTURE_FILES);
      const run = scanRunnerFor('src/a.ts');
      // NO authority bound — the shipped default for an unbound caller.
      const op = makeAstGrepCodemod(run, () => store);
      const result = await op({
        dir: '/ws',
        rule: 'r',
        files: ['src/a.ts'],
        dryRun: false,
        approved: true,
      });
      expect(result.status).toBe('needs-human');
      // The refusal happens AT THE MUTATION, after the plan is computed — so
      // the scan HAS run by then. Pinned so nobody later "optimises" this
      // into a pre-scan gate and believes the test proves otherwise.
      expect(run.commands.length).toBeGreaterThan(0);
      expect(store.written.size).toBe(0);
    });

    test('a forged inherited scope is REFUSED, not ignored', async () => {
      const store = memoryStore(FIXTURE_FILES);
      const run = scanRunnerFor('src/a.ts');
      // A forgery is exactly this: a well-shaped object that is NOT branded,
      // so the cast is what a bypass attempt would have to do.
      const forged = {
        op: 'analyze.playbookDispatch',
        workspace: '/ws',
      } as unknown as ExercisedScope;
      const op = makeAstGrepCodemod(run, () => store, trustedAuthority(), forged);
      const result = await op({
        dir: '/ws',
        rule: 'r',
        files: ['src/a.ts'],
        dryRun: false,
        approved: true,
      });
      // Ignored-and-fallthrough would be the hole: it would authorize the
      // write on the input flag alone.
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') return;
      expect(result.error).toContain('not minted by the approval module');
      // ...and explicitly NOT ignored, because ignoring is the fall-through
      // to authorizing the write on the input flag alone.
      expect(result.error).toContain('refused rather than ignored');
      expect(store.written.size).toBe(0);
    });

    test('NESTED (ADR-0003 §6): an inherited scope writes under the OUTER approval, with no second exercise', async () => {
      const store = memoryStore(FIXTURE_FILES);
      const run = scanRunnerFor('src/a.ts');
      const authority = trustedAuthority();
      const subject = {
        op: 'analyze.playbookDispatch',
        workspace: '/ws',
        targets: ['src/a.ts'],
        inputDigest: 'sha256:nested',
      };
      // The dispatch shape: one approved mutation whose write is the engine
      // primitive. The primitive receives the scope instead of demanding a
      // second token, which would throw on at-most-once.
      const nested = await withApprovedMutation(authority, subject, async (scope) => {
        const engine = makeAstGrepCodemod(run, () => store, undefined, scope);
        return engine({
          dir: '/ws',
          rule: 'r',
          files: ['src/a.ts'],
          dryRun: false,
          approved: true,
        });
      });
      expect(nested.status).toBe('ok');
      // The bytes landed, and the nested op consumed no approval of its own:
      // the outer subject's nonce is the only one spent.
      expect(store.written.size).toBe(1);
      // The outer mutation's VALUE is the inner op's result (the dispatch
      // passes the engine's report straight through).
      if (nested.status === 'ok' && nested.value.status === 'ok') {
        expect(nested.value.value.mode).toBe('applied');
      } else {
        throw new Error('the nested engine did not report ok through the outer approval');
      }
    });

    test('cross-workspace: a scope minted for one tree does not authorize another', async () => {
      const store = memoryStore(FIXTURE_FILES);
      const run = scanRunnerFor('src/a.ts');
      const authority = trustedAuthority('/ws');
      let refused = '';
      // The outer approval covers '/ws'; the nested op aims at '/elsewhere'.
      await withApprovedMutation(
        authority,
        {
          op: 'analyze.playbookDispatch',
          workspace: '/ws',
          targets: ['src/a.ts'],
          inputDigest: 'sha256:cross',
        },
        async (scope) => {
          const engine = makeAstGrepCodemod(run, () => store, undefined, scope);
          const result = await engine({
            dir: '/elsewhere',
            rule: 'r',
            files: ['src/a.ts'],
            dryRun: false,
            approved: true,
          });
          if (result.status === 'failed') refused = result.error;
          return result;
        },
      );
      // A scope authorizes exactly the workspace it was minted for, so a
      // different tree is refused rather than riding the same approval.
      expect(refused).toContain('authorizes exactly the workspace');
      expect(store.written.size).toBe(0);
    });

    test('containment: a scope does not authorize targets outside its approved set', async () => {
      const store = memoryStore(FIXTURE_FILES);
      const run = scanRunner();
      const authority = trustedAuthority('/ws');
      let refused = '';
      await withApprovedMutation(
        authority,
        {
          op: 'analyze.playbookDispatch',
          workspace: '/ws',
          // The approval covered ONE file ...
          targets: ['src/a.ts'],
          inputDigest: 'sha256:contain',
        },
        async (scope) => {
          // ... but the nested op would write a second, unapproved one.
          const engine = makeAstGrepCodemod(run, () => store, undefined, scope);
          const result = await engine({
            dir: '/ws',
            rule: 'r',
            files: ['src/a.ts', 'src/b.ts'],
            dryRun: false,
            approved: true,
          });
          if (result.status === 'failed') refused = result.error;
          return result;
        },
      );
      expect(refused).toContain('authorizes exactly the targets');
      expect(refused).toContain('src/b.ts');
      expect(store.written.size).toBe(0);
    });

    test('a RETAINED scope is refused on reuse after its section ended', async () => {
      const store = memoryStore(FIXTURE_FILES);
      const run = scanRunnerFor('src/a.ts');
      const authority = trustedAuthority();
      let retained: unknown;
      await withApprovedMutation(
        authority,
        {
          op: 'analyze.playbookDispatch',
          workspace: '/ws',
          targets: ['src/a.ts'],
          inputDigest: 'sha256:retain',
        },
        async (scope) => {
          retained = scope;
          return 'written';
        },
      );
      // Outside the section now, so the same primitive call that was legal
      // inside it is refused — otherwise a captured capability would be a
      // permanent write token.
      const engine = makeAstGrepCodemod(run, () => store, undefined, retained as ExercisedScope);
      const result = await engine({
        dir: '/ws',
        rule: 'r',
        files: ['src/a.ts'],
        dryRun: false,
        approved: true,
      });
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') return;
      expect(result.error).toContain('not live');
      expect(store.written.size).toBe(0);
    });

    test('the direct path spends exactly one nonce for the same write the nested path performs', async () => {
      const direct = trustedAuthority();
      const store = memoryStore(FIXTURE_FILES);
      const result = await makeAstGrepCodemod(
        scanRunnerFor('src/a.ts'),
        () => store,
        direct,
      )({
        dir: '/ws',
        rule: 'r',
        files: ['src/a.ts'],
        dryRun: false,
        approved: true,
      });
      expect(result.status).toBe('ok');
      expect(store.written.size).toBe(1);
    });
  });
});
