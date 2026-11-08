import { writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  makeAddressWorker,
  type AddressWorkerDeps,
  type AddressAttempt,
} from '../../../src/ops/review/addressWorker.js';
import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { checkoutWriterContext } from '../../../src/shared/checkoutWriterContext.js';
import { resolveCqConfigDefaults } from '../../../src/ops/analyze/cqConfigDefaults.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { OpInvocation, Usage } from '../../../src/driver/types.js';
import type { ObservationWriter } from '../../../src/kernel/observation.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { makeGhRunner, type GhFn } from '../../../src/adapters/forge-github/gh.js';
import type { Finding } from '../../../src/ops/review/findings.js';
import { makeTestRepo } from '../dev/repo.js';
import { realTmpDir } from '../../helpers/tmp-dir.js';

export const role = { provider: 'mock', model: 'worker' };
export const finding = (file = 'src/a.ts'): Finding => ({
  id: file,
  source: 'agent',
  file,
  line: 1,
  severity: 'major',
  text: 'Replace BAD with GOOD',
  status: 'open',
});
export async function fixture(
  handler?: (input: OpInvocation) => Promise<unknown>,
  check = '',
  options: {
    scannerFails?: boolean;
    terminalBinding?: object;
    parentSignal?: AbortSignal;
    maxTokens?: number;
    workerAttempts?: number;
    rescueBase?: number;
    aliasRoot?: boolean;
    installedDependencies?: 'matching' | 'mismatched';
    preferDependencyRoot?: boolean;
    workspaceDependency?: 'caller' | 'worker';
    firstStopReason?: 'budget' | 'aborted' | 'error';
    costUSD?: number;
    remainingWallMs?: () => number;
    unitWallMs?: number;
    configure?: (config: CqConfig) => void;
    scanner?: DiffSecretScanner;
    providerRequest?: boolean;
    indexIdentityUnavailable?: boolean;
    prepareBookkeeping?: () => Promise<void>;
    gitHook?: (args: string[], run: GhFn) => ReturnType<GhFn>;
    runPrefix?: string;
    objectFormat?: 'sha256';
    observationWriter?: ObservationWriter;
    observationRunId?: string;
    observationDrainMs?: number;
    usage?: Usage;
  } = {},
) {
  const repo = await makeTestRepo(
    options.objectFormat ? { objectFormat: options.objectFormat } : {},
  );
  repo.git('config', 'user.name', 'Test');
  repo.git('config', 'user.email', 'test@example.invalid');
  await repo.write('src/a.ts', 'BAD\n');
  await repo.write('src/b.ts', 'BAD\n');
  await repo.write('scripts/check.cjs', check || 'process.exitCode = 0;\n');
  repo.commitAll('fixture');
  const initial = repo.git('rev-parse', 'HEAD').trim();
  const journal = await realTmpDir('cq-address-test-');
  const alias = join(journal, 'repo-alias');
  if (options.aliasRoot) await symlink(repo.root, alias, 'dir');
  const dependencyRoot = join(journal, 'installed-caller');
  const dependencyCheckMarker = join(journal, 'workspace-check-ran');
  if (options.installedDependencies) {
    await mkdir(join(dependencyRoot, 'node_modules'), { recursive: true });
    await repo.write('package.json', '{"name":"fixture"}\n');
    await repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    await writeFile(
      join(dependencyRoot, 'package.json'),
      options.installedDependencies === 'matching'
        ? '{"name":"fixture"}\n'
        : '{"name":"fixture","dependencies":{"different":"1.0.0"}}\n',
    );
    await writeFile(join(dependencyRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    await writeFile(join(dependencyRoot, 'node_modules/check.cjs'), 'process.exitCode = 0;\n');
    repo.commitAll('dependency metadata');
  }
  if (options.workspaceDependency) {
    await repo.write('packages/lib/index.js', "module.exports = 'PARENT';\n");
    await repo.write('.gitignore', 'node_modules/\n');
    repo.commitAll('workspace package parent');
    const installedRoot = options.workspaceDependency === 'caller' ? dependencyRoot : repo.root;
    await mkdir(join(installedRoot, 'node_modules'), { recursive: true });
    await mkdir(join(installedRoot, 'packages/lib'), { recursive: true });
    if (options.workspaceDependency === 'caller')
      await writeFile(join(installedRoot, 'packages/lib/index.js'), "module.exports = 'CALLER';\n");
    await symlink('../packages/lib', join(installedRoot, 'node_modules/linked-lib'), 'dir');
    await writeFile(
      join(installedRoot, 'node_modules/check.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(dependencyCheckMarker)}, 'ran'); if(require('linked-lib') !== '${options.workspaceDependency === 'caller' ? 'CALLER' : 'PARENT'}') process.exitCode=1;\n`,
    );
  }
  const attempts: AddressAttempt[] = [];
  let spent = 0,
    calls = 0;
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [
      {
        adapter: 'tsc-lines',
        command: {
          command: process.execPath,
          args: [options.installedDependencies ? 'node_modules/check.cjs' : 'scripts/check.cjs'],
        },
      },
    ],
    roles: {
      worker: role,
      rescue: { ...role, model: 'rescue' },
      reviewer: { ...role, model: 'reviewer' },
    },
    budgets: {
      run: { maxTokens: options.maxTokens ?? 10000, wallMs: 20000 },
      step: { wallMs: 5000 },
      ...(options.unitWallMs === undefined ? {} : { unit: { wallMs: options.unitWallMs } }),
    },
    escalation: {
      workerAttempts: options.workerAttempts ?? 1,
      rescueBase: options.rescueBase ?? 0,
    },
    review: { reviewers: ['agent'] },
  };
  const drivers: DriverFactory = {
    resolve: (request) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: {
        run: async (input) => {
          calls++;
          if (options.providerRequest)
            await request.beforeRequest?.('synthetic request', [
              { text: 'synthetic tool output', path: 'src/a.ts' },
            ]);
          const output = handler
            ? await handler(input)
            : await (async () => {
                if (input.outputSchema?.name === 'review.address.closure/v1')
                  return { closed: true, reason: 'candidate fixed' };
                if (
                  input.prompt.includes('initial finding') ||
                  input.prompt.includes('worker retry')
                )
                  await writeFile(
                    join(
                      input.workspace!.path,
                      input.prompt.includes('src/b.ts') ? 'src/b.ts' : 'src/a.ts',
                    ),
                    'GOOD\n',
                  );
                return { disposition: 'fixed', reason: 'fixed', evidence: [] };
              })();
          return {
            stopReason: calls === 1 ? (options.firstStopReason ?? 'complete') : 'complete',
            structuredOutput: output,
            usage: options.usage ?? { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
            ...(options.costUSD === undefined ? {} : { costUSD: options.costUSD }),
            denials: [],
          };
        },
      },
    }),
  };
  options.configure?.(config);
  const git = makeGhRunner({ bin: 'git', cwd: repo.root });
  let identityRequests = 0;
  const engineDeps: AddressWorkerDeps = {
    git: async (args) => {
      if (args.includes('--absolute-git-dir')) {
        identityRequests++;
        if (options.indexIdentityUnavailable)
          return { code: 1, stdout: '', stderr: 'identity unavailable' };
      }
      return options.gitHook ? options.gitHook(args, git) : git(args);
    },
    drivers,
    repoRoot: options.aliasRoot ? alias : repo.root,
    ...(options.installedDependencies ? { dependencyRoot } : {}),
    ...(options.preferDependencyRoot ? { preferDependencyRoot: true } : {}),
    journalDir: journal,
    policy: resolveCqConfigDefaults(config, { packageName: 'fixture' }),
    attempts,
    ...(options.prepareBookkeeping ? { prepareBookkeeping: options.prepareBookkeeping } : {}),
    ...(options.runPrefix ? { runPrefix: options.runPrefix } : {}),
    remainingTokens: () => config.budgets!.run!.maxTokens! - spent,
    remainingWallMs: options.remainingWallMs ?? (() => 20000),
    account: (r) => {
      spent += r.usage.input + r.usage.output;
    },
    scanner:
      options.scanner ??
      (async (components) => {
        if (options.scannerFails) throw new Error('scanner unavailable');
        return components.map((c) => ({ component: c.component, hits: [] }));
      }),
    ...(options.parentSignal ? { parentSignal: options.parentSignal } : {}),
    ...(options.terminalBinding ? { terminalBinding: options.terminalBinding } : {}),
    ...(options.observationWriter ? { observationWriter: options.observationWriter } : {}),
    ...(options.observationRunId ? { observationRunId: options.observationRunId } : {}),
    ...(options.observationDrainMs === undefined
      ? {}
      : { observationDrainMs: options.observationDrainMs }),
  };
  const baseEngine = makeAddressWorker(engineDeps);
  // Standalone worker fixtures enter the shipped checkout lifetime lazily, so
  // sibling calls still share one FIFO and terminal-capture tests may supply
  // their own lifetime without competing with an unused fixture engine.
  let finish!: () => void, ready!: () => void;
  const released = new Promise<void>((done) => {
    finish = done;
  });
  const admitted = new Promise<void>((done) => {
    ready = done;
  });
  let lifetime: Promise<void> | undefined;
  let enteredLifetime = false;
  let execute: <T>(action: () => Promise<T>) => Promise<T>;
  async function owned<T>(action: () => Promise<T>): Promise<T> {
    lifetime ??= withAddressOwnership(
      { repoRoot: repo.root, git: engineDeps.git, source: 'local', production: false },
      async (lease) => {
        const context = checkoutWriterContext()!;
        execute = (action) => context.run(() => lease.track(action));
        enteredLifetime = true;
        ready();
        await released;
      },
    );
    await Promise.race([admitted, lifetime]);
    return execute(action);
  }
  const engine = {
    ...baseEngine,
    fix: (...args: Parameters<typeof baseEngine.fix>) => owned(() => baseEngine.fix(...args)),
    withVerifiedHead: <T>(action: (head: string) => Promise<T>) =>
      owned(() => baseEngine.withVerifiedHead!(action)),
  };
  return {
    repo,
    engineDeps,
    engine,
    attempts,
    initial,
    calls: () => calls,
    identityRequests: () => identityRequests,
    dependencyCheckMarker,
    dependencyRoot,
    cleanup: async () => {
      finish();
      if (enteredLifetime) await lifetime;
      else await lifetime?.catch(() => undefined);
      await repo.cleanup();
      await rm(journal, { recursive: true, force: true });
    },
  };
}
