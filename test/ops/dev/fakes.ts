// Shared fakes for the dev-family op tests: a scripted DevEffects over an
// in-memory ledger, and a stub secret scanner. No process ever spawns.
import type {
  DevCheckRecord,
  DevCycleRecord,
  DevDispositionRecord,
  DevLedgerFile,
  DevLedgerStore,
  DevRecord,
} from '../../../src/ops/dev/record.js';
import { DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';

export type { DevRecord };
import type { CommandResult, DevEffects } from '../../../src/ops/dev/effects.js';

export const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const BRANCH = 'test/branch';

/** An in-memory ledger store (the DevLedgerStore contract, no fs, no lock). */
export function memoryLedgerStore(
  branch: string = BRANCH,
): DevLedgerStore & { file(): DevLedgerFile } {
  let file: DevLedgerFile = { version: DEV_LEDGER_VERSION, branch, records: [] };
  return {
    load: () => ({ ...file, records: [...file.records] }),
    save: (next) => {
      file = { ...next, records: [...next.records] };
    },
    mutate: async (fn) => {
      const next = fn({ ...file, records: [...file.records] });
      file = { ...next.ledger, records: [...next.ledger.records] };
      return next.value;
    },
    file: () => ({ ...file, records: [...file.records] }),
  };
}

/** A scripted command result. */
export function okResult(stdout = '', stderr = ''): CommandResult {
  return { exitCode: 0, stdout, stderr, timedOut: false };
}

export function failResult(exitCode: number, stdout = '', stderr = ''): CommandResult {
  return { exitCode, stdout, stderr, timedOut: false };
}

/**
 * Fully scripted effects (no process ever spawns): `handlers` answers a
 * command or returns undefined, and any unhandled command fails LOUDLY.
 * For op tests that need git, prefer the real-git harness in repo.ts.
 */
export function makeFakeEffects(
  handlers: (command: string, args: readonly string[]) => CommandResult | string | undefined = () =>
    undefined,
  options: { branch?: string } = {},
): DevEffects & {
  commands: { command: string; args: readonly string[] }[];
  store: ReturnType<typeof memoryLedgerStore>;
} {
  const store = memoryLedgerStore(options.branch ?? BRANCH);
  const commands: { command: string; args: readonly string[] }[] = [];
  return {
    commands,
    store,
    runCommand: async (command, args) => {
      commands.push({ command, args: [...args] });
      const scripted = handlers(command, args);
      if (scripted === undefined) {
        throw new Error(`fake effects: unscripted command ${command} ${args.join(' ')}`);
      }
      return typeof scripted === 'string' ? okResult(scripted) : scripted;
    },
    nowIso: () => '2026-10-17T00:00:00.000Z',
    loadStamp: () => ({ uptimeSeconds: 1000, load1: 1.5, at: '2026-10-17T00:00:00.000Z' }),
    withHostLock: async (fn) => fn(),
    writeReviewLog: async (_branch, stamp) => `/tmp/fake-cq-dev-review/${stamp}.log`,
    readWorktreeFile: async () => ({ ok: false as const, reason: 'unreadable (fake default)' }),
    makeScratchDir: async (prefix) => `/tmp/fake-scratch-${prefix}`,
    ensureDir: async () => undefined,
    removeScratchDir: async () => undefined,
    openLedger: () => store,
  };
}

/** A secret scanner stub: no hits, or the hits given. */
export function stubScanner(
  hits: { component: string; ruleId: string }[] = [],
): (
  components: readonly { component: string }[],
) => { component: string; hits: { ruleId: string; lines: number[] }[] }[] {
  return (components) =>
    components.map((component) => ({
      component: component.component,
      hits: hits
        .filter((hit) => hit.component === component.component)
        .map((hit) => ({ ruleId: hit.ruleId, lines: [1] })),
    }));
}

// ---------------------------------------------------------------------------
// Record fixtures (shared; importing a .test.ts file would re-register its
// tests into the importing file — these live in a non-test module)
// ---------------------------------------------------------------------------

export function cycleRecord(overrides: Partial<DevCycleRecord> = {}): DevCycleRecord {
  return {
    kind: 'cycle',
    cycleId: 'c001-aaaaaaaa',
    reviewer: 'coderabbit',
    scope: 'full',
    target: 'merge-queue',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    completion: { kind: 'terminal' },
    findings: [],
    logPath: '/tmp/log',
    untracked: [],
    at: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

export function checkRecord(overrides: Partial<DevCheckRecord> = {}): DevCheckRecord {
  return {
    kind: 'check',
    checkId: 'k001-aaaaaaaa',
    target: 'merge-queue',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    passed: true,
    gates: [{ name: 'check:static', status: 'pass', exitCode: 0, durationMs: 10, evidence: 'ok' }],
    loadStamp: { uptimeSeconds: 1, load1: 1, at: '2026-10-17T00:00:00.000Z' },
    at: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

export function dispositionRecord(
  overrides: Partial<DevDispositionRecord> = {},
): DevDispositionRecord {
  return {
    kind: 'disposition',
    findingId: 'c001-aaaaaaaa#f1',
    action: 'fixed',
    why: 'addressed in the diff',
    head: HEAD,
    at: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

export function ledgerWith(records: DevRecord[], branch: string = BRANCH): DevLedgerFile {
  return { version: DEV_LEDGER_VERSION, branch, records };
}
