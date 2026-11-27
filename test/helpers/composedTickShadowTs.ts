/**
 * The TypeScript side of the composed tick shadow (test/adapters/crq/composedShadow.test.ts):
 * `composeFullTick` with every input supplied, driven by the real `runTick`, over one frozen
 * state-root copy. The Python side is composedTickShadowOracle.py; the two carry the same stubs,
 * named in that file's docstring, and nothing else is faked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitPool } from '../../src/adapters/crq/gitExec.js';
import type { ComposedGaps, ComposedRunResult } from '../../src/adapters/crq/shadowRun.js';
import { composeFullTick } from '../../src/adapters/crq/tickComposition.js';
import { JsonObject, parseJsonValue } from '../../src/policy/crq/jsonValue.js';
import { runTick, type TickInput } from '../../src/queue-runner/tickOrchestrator.js';

export interface ComposedSpec {
  /** The pinned instant, ISO-8601 with a `Z`. */
  readonly now: string;
  readonly runnerRoot: string;
  /** The heartbeat's `root` field (Python's `str(ROOT)`). */
  readonly rootField: string;
  /** Scratch HOME / XDG parent shared by neither implementation's live paths. */
  readonly home: string;
  /** An offline clone (a local bare `origin`), the same path on both sides. */
  readonly clone: string;
  readonly config: Record<string, unknown>;
  readonly dry?: boolean;
  readonly only?: string | null;
  readonly ignoreQuiet?: boolean;
}

/** A local bare `origin`, so `git fetch` and `git ls-remote` stay offline. */
export function offlineClone(): string {
  const base = mkdtempSync(join(tmpdir(), 'composed-shadow-clone-'));
  const bare = join(base, 'origin.git');
  const clone = join(base, 'clone');
  execFileSync('git', ['init', '--bare', '--quiet', bare]);
  execFileSync('git', ['init', '--quiet', clone]);
  execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', bare]);
  return clone;
}

/** The config both sides read: the checked-in default plus the sample's overrides. */
export function mergedConfig(
  repoRoot: string,
  spec: Pick<ComposedSpec, 'clone' | 'config'>,
): Record<string, unknown> {
  const base = JSON.parse(
    readFileSync(join(repoRoot, 'apps/crq-python/config.json'), 'utf8'),
  ) as Record<string, unknown>;
  return { ...base, ...spec.config, clone: spec.clone };
}

/**
 * A one-commit runner checkout holding the merged `config.json`: TS reads its config from the
 * runner root where Python reads `ROOT/config.json`, and `client_health.sha` is this HEAD on both
 * sides, so the oracle's `RUNNER_ROOT` is this same directory.
 */
export function runnerCheckout(
  repoRoot: string,
  spec: Pick<ComposedSpec, 'clone' | 'config'>,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'composed-shadow-runner-'));
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify(mergedConfig(repoRoot, spec), null, 2)}\n`,
  );
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'shadow',
        GIT_AUTHOR_EMAIL: 's@example.invalid',
        GIT_COMMITTER_NAME: 'shadow',
        GIT_COMMITTER_EMAIL: 's@example.invalid',
        GIT_AUTHOR_DATE: '2027-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2027-01-01T00:00:00Z',
      },
    });
  };
  git('init', '--quiet');
  git('add', 'config.json');
  git('commit', '--quiet', '-m', 'runner');
  return dir;
}

const unusedGh = (() => {
  throw new Error('no forge call is allowed in the composed shadow');
}) as never;

/** Run the composed tick once over `root`. */
export async function runComposedTs(
  repoRoot: string,
  root: string,
  spec: ComposedSpec,
): Promise<ComposedRunResult> {
  const nowMs = Date.parse(spec.now);
  const config = parseJsonValue(JSON.stringify(mergedConfig(repoRoot, spec))) as JsonObject;
  mkdirSync(join(spec.home, 'xdg'), { recursive: true });
  const phaseCalls: string[] = [];
  const emptyGh = (async () => ({ code: 0, stdout: '[]', stderr: '' })) as never;
  const composed = composeFullTick({
    stateRoot: root,
    config,
    clone: spec.clone,
    watchdogHome: root,
    root: spec.rootField,
    runnerRoot: spec.runnerRoot,
    repo: String(mergedConfig(repoRoot, spec).repo),
    now: () => nowMs,
    gh: emptyGh,
    usageProbes: {
      vendorProgress: async () => false,
      readUsage: async () => ({ remaining: 1 }),
    },
    delivery: {
      gh: unusedGh,
      authenticate: () => {
        throw new Error('no vendor auth in the composed shadow');
      },
      files: { readBytes: () => new Uint8Array() } as never,
      readText: () => '',
      primaryRepo: String(mergedConfig(repoRoot, spec).repo),
      push: {} as never,
    },
    admit: {
      config: { maxStartsPerHour: 5, maxStartsPerTick: 10, maxInflight: 10 },
      nowMicros: () => BigInt(nowMs) * 1000n,
      startOne: async (q) => {
        phaseCalls.push('start_one');
        return { queue: q, log: [], hasCoverage: false };
      },
    },
    discovery: {
      push: { event: async () => undefined },
      enroll: {
        localReview: { facts: async () => null, retained: async () => false },
        event: async () => undefined,
      },
    },
    fixPrBacklog: { listOpenPrs: async () => [] },
    repairBackfill: {
      ledgerRoot: join(root, 'ledger'),
      defaultRef: 'origin/main',
      mergedCurrentEnabled: false,
      maxRoundsPerPin: 2,
      git: async () => '',
      findings: async () => [],
    },
    harvest: {
      local: {
        kind: 'local-review',
        harvest: async (q) => ({ queue: q, message: null }),
        republish: async (q) => q,
        reconcileCompleted: async (q) => q,
      },
      reviewReceiptKind: 'review-receipt',
      worktree: { pool: new GitPool(), worktreePrefix: 'coderabbit-queue-' },
      review: {} as never,
      repairHarvest: async () => [],
    },
    reporting: {
      roots: {
        runnerRoot: spec.runnerRoot,
        stateRoot: root,
        xdgStateHome: join(spec.home, 'xdg'),
        home: spec.home,
      },
    },
  });
  const tick: TickInput = {
    dry: spec.dry === true,
    only: spec.only ?? null,
    ignoreQuiet: spec.ignoreQuiet === true,
    staleAlarmMin: Number(mergedConfig(repoRoot, spec).stale_alarm_min ?? 36),
    statusPath: join(root, 'status.md'),
  };
  // `composeFullTick` binds `notifyOwnerFrom(config)`, i.e. the real `paseo send`. The Python oracle
  // stubs `notify_owner`; the TS side records the same phase call and never spawns anything.
  const phases = {
    ...composed.phases,
    notifyOwner: async () => {
      phaseCalls.push('notify_owner');
    },
  };
  const log = await runTick(tick, phases);
  const gaps: ComposedGaps = {
    complete: composed.complete,
    unbound: composed.unbound.map((gap) => gap.id),
    staged: composed.staged.map((gap) => gap.id),
  };
  return { log, phaseCalls, gaps };
}
