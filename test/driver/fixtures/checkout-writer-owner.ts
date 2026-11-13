// Child process fixture: admission is through production review entrypoints.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { runReviewLoop } from '../../../src/plans/review-loop.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { spawnManaged } from '../../../src/shared/proc.js';
import { spawnAcpProcess } from '../../../src/driver/acp/process.js';
import { runArgvCommand, runShellCommand } from '../../../src/harness/run.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import {
  withAddressOwnership,
  bindAddressTerminalReport,
  addressTerminalWorkerBinding,
  recordAddressTerminalAttempt,
  deferAddressTerminalAttempt,
  addressCancelledResult,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';

const [root, common, worktreeRoot, boundary, probe, socket, head] = process.argv.slice(
  2,
) as string[];
const git = makeGhRunner({ bin: 'git' });
if (boundary === 'bulk') {
  await makeReviewAddressMany({
    address: async () => {
      throw new Error('clone did not pause');
    },
    gh: async (args) => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify(
        args[0] === 'repo'
          ? { nameWithOwner: 'octo/widget' }
          : {
              number: 7,
              state: 'open',
              merged: false,
              draft: false,
              base: { ref: 'main' },
              user: { login: 'octo', type: 'User' },
              head: { sha: head, ref: 'feature/x', repo: { full_name: 'octo/widget' } },
            },
      ),
    }),
  })({
    repoRoot: root!,
    repo: 'octo/widget',
    owner: 'octo',
    pulls: [7],
    maxTokens: 100,
    tokensPerPr: 50,
  });
} else if (boundary === 'terminal') {
  const parent = new AbortController();
  await withAddressOwnership(
    { repoRoot: root!, git, source: 'pr:7', production: true, signal: parent.signal },
    async (lease) => {
      const path = join(worktreeRoot!, 'pr-7-feature-x');
      await lease.claimCheckout({ path, branch: 'cq-review/pr-7', head: head! });
      await bindAddressTerminalReport(lease, {
        version: 1,
        source: 'pr:7',
        reportPath: join(root!, '..', 'terminal-report.json'),
        rounds: [],
        findings: [],
        openBlocking: [],
        fixes: [],
        attempts: [],
        failed: [],
        fixesPerRun: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        wallMs: 0,
        reasons: [],
      });
      const binding = addressTerminalWorkerBinding(lease);
      const attempt = await recordAddressTerminalAttempt(binding, {
        root: path,
        file: 'src/a.ts',
        parent: head!,
        executionHead: head!,
        runPrefix: 'fd-fixture',
        finding: 'fd',
        slug: 'fd',
        ordinal: 1,
        tier: 'worker',
        model: { provider: 'mock', model: 'offline' },
      });
      await writeFile(join(path, 'src/a.ts'), 'cancelled partial bytes\n');
      const originalSpawn = childProcess.spawn;
      let used = false;
      childProcess.spawn = ((
        command: string,
        args: readonly string[],
        options: import('node:child_process').SpawnOptions,
      ) => {
        if (used) return originalSpawn(command, args, options);
        used = true;
        return originalSpawn(process.execPath, [probe!, socket!], options);
      }) as unknown as typeof childProcess.spawn;
      syncBuiltinESMExports();
      parent.abort();
      deferAddressTerminalAttempt(binding, attempt);
      return addressCancelledResult(lease);
    },
  );
} else {
  await runReviewLoop({
    owner: 'octo',
    repo: 'widget',
    pr: 7,
    headRefName: 'feature/x',
    repoRoot: root!,
    git,
    gh: async () => {
      throw new Error('probe failed to pause before forge');
    },
    registry: slotWorktreeRegistry(common!),
    driver: { provider: 'mock', model: 'offline' },
    nowMs: 1,
    dispatchLogPath: join(root!, '..', 'fd-dispatch.jsonl'),
    worktreeRoot: worktreeRoot!,
    onWorktreeResolved: async (info) => {
      const args = [probe!, socket!],
        opts = { cwd: info.path, env: {}, maxBytes: 4096, timeoutMs: 30000 };
      if (boundary === 'gh') await makeGhRunner({ bin: process.execPath })(args);
      else if (boundary === 'managed')
        await spawnManaged({ command: process.execPath, args, cwd: info.path }).close;
      else if (boundary === 'acp')
        await once(
          spawnAcpProcess({ command: process.execPath, args, cwd: info.path, env: {} }),
          'close',
        );
      else if (boundary === 'effects')
        await makeSubprocessDevEffects(info.path).runCommand(process.execPath, args, {
          timeoutMs: 30000,
        });
      else if (boundary === 'argv') await runArgvCommand(process.execPath, args, opts);
      else if (boundary === 'shell') {
        const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
        // Replace the fixture shell so the probe's close-all-fds IPC ack is
        // the last inherited reference, not a race with an intermediate shell.
        await runShellCommand('exec ' + [process.execPath, ...args].map(quote).join(' '), opts);
      } else throw new Error('unknown boundary');
    },
  });
}
