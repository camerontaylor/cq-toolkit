// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// install-hook ordering, worktree defaulting and reuse contracts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SweepUnitDispatchInputSchema } from '../../../src/ops/sweep/registry.js';
import { bindingsFromDispatch, makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import { CLEANUP, fakeFactory, registerCleanup, VALID } from './unit-registry.helpers.js';

registerCleanup();

describe('sweep.unit registry entry (jSKJF)', () => {
  test(
    'dispatch defaults worktrees outside the repo and binds an argv install hook',
    { timeout: 30_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sweep-install-'));
      CLEANUP.push(dir);
      const { worktreesDir: _ignored, ...withoutDir } = VALID;
      const bindings = bindingsFromDispatch(
        {
          ...withoutDir,
          repoRoot: join(dir, 'repo'),
          install: {
            command: process.execPath,
            args: ['-e', "require('node:fs').writeFileSync('installed', 'yes')"],
          },
        },
        fakeFactory,
      );
      expect(bindings.worktreesDir).toBe(join(dir, 'worktrees', 'cq'));
      expect(SweepUnitDispatchInputSchema.safeParse(withoutDir).success).toBe(true);
      await bindings.installDeps?.(dir);
      expect(readFileSync(join(dir, 'installed'), 'utf8')).toBe('yes');
      // The job's abort signal reaches the install subprocess: a pre-aborted
      // signal kills it before it can write anything.
      const aborted = AbortSignal.abort();
      rmSync(join(dir, 'installed'));
      await expect(bindings.installDeps?.(dir, aborted)).rejects.toThrow(/killed/);
      expect(existsSync(join(dir, 'installed'))).toBe(false);
    },
  );

  test(
    'new worktree installs before baseline, reuse skips install, and linked trees share the mutex',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'sweep-hook-order-'));
      CLEANUP.push(root);
      const repoRoot = join(root, 'repo');
      execFileSync('git', ['init', '-q', '-b', 'main', repoRoot], {
        timeout: 10_000,
      });
      execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 't@example.invalid'], {
        timeout: 10_000,
      });
      execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'T'], {
        timeout: 10_000,
      });
      writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
      execFileSync('git', ['-C', repoRoot, 'add', 'seed.txt'], {
        timeout: 10_000,
      });
      execFileSync('git', ['-C', repoRoot, 'commit', '-q', '-m', 'seed'], {
        timeout: 10_000,
      });
      const timeline: string[] = [];
      const bindings = bindingsFromDispatch(
        {
          ...VALID,
          repoRoot,
          worktreesDir: join(root, 'trees'),
          runPrefix: 'cq/hook-order',
          mode: 'prep',
          push: false,
        },
        fakeFactory,
      );
      const op = makeSweepUnitOp({
        ...bindings,
        installDeps: async () => {
          timeline.push('install');
        },
        runCheck: async () => {
          timeline.push('probe');
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      const unit = {
        package: VALID.package,
        fixer: VALID.fixer,
        files: VALID.files,
      };
      const first = await op(unit);
      expect(first.status).toBe('ok');
      if (first.status !== 'ok') return;
      expect(first.value.worktree.reused).toBe(false);
      expect(timeline).toEqual(['install', 'probe']);
      const linked = bindingsFromDispatch(
        { ...VALID, repoRoot: first.value.worktree.path },
        fakeFactory,
      );
      expect(linked.mutex?.lockPath).toBe(bindings.mutex?.lockPath);

      timeline.length = 0;
      const second = await op(unit);
      expect(second.status).toBe('ok');
      if (second.status !== 'ok') return;
      expect(second.value.worktree.reused).toBe(true);
      expect(timeline).toEqual(['probe']);
    },
  );

  test(
    'a failed install is not trusted on reuse — the next dispatch retries it before probing',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'sweep-install-retry-'));
      CLEANUP.push(root);
      const repoRoot = join(root, 'repo');
      for (const args of [
        ['init', '-q', '-b', 'main', repoRoot],
        ['-C', repoRoot, 'config', 'user.email', 't@example.invalid'],
        ['-C', repoRoot, 'config', 'user.name', 'T'],
      ]) {
        execFileSync('git', args, { timeout: 10_000 });
      }
      writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n');
      execFileSync('git', ['-C', repoRoot, 'add', 'seed.txt'], { timeout: 10_000 });
      execFileSync('git', ['-C', repoRoot, 'commit', '-q', '-m', 'seed'], { timeout: 10_000 });
      const timeline: string[] = [];
      let installs = 0;
      const op = makeSweepUnitOp({
        ...bindingsFromDispatch(
          {
            ...VALID,
            repoRoot,
            worktreesDir: join(root, 'trees'),
            runPrefix: 'cq/install-retry',
            mode: 'prep',
            push: false,
          },
          fakeFactory,
        ),
        installDeps: async () => {
          installs += 1;
          timeline.push('install');
          if (installs === 1) throw new Error('transient install failure');
        },
        runCheck: async () => {
          timeline.push('probe');
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      const unit = { package: VALID.package, fixer: VALID.fixer, files: VALID.files };
      await op(unit);
      expect(timeline).toEqual(['install']);

      timeline.length = 0;
      const second = await op(unit);
      expect(second.status).toBe('ok');
      if (second.status !== 'ok') return;
      expect(second.value.worktree.reused).toBe(true);
      expect(timeline).toEqual(['install', 'probe']);
    },
  );
});
