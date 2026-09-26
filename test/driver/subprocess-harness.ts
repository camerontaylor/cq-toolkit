// Process-free helpers shared by the subprocess driver tests:
// subprocess.test.ts (the fake agent CLI's persona in-process) and
// subprocess.real.test.ts (the CLI as a REAL process). Each file owns its
// spawn override, so the process-entry inventory scan (*.test.ts only)
// sees exactly the file that launches the fixture.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnFn, SubprocessDriverOptions } from '../../src/driver/subprocess/index.js';
import { RoutingTableSchema, defaultRoutingTable } from '../../src/driver/subprocess/routing.js';
import type { RoutingTable } from '../../src/driver/subprocess/routing.js';
import type { OpInvocation } from '../../src/driver/types.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { SessionStore } from '../../src/harness/session.js';
import { CONFORMANCE_MODEL, CONFORMANCE_PROVIDER, SESSIONS_DIR } from './conformance.js';

// The fake CLI: node + the fixture script, spawned through the driver's
// argv template `binary` option (shell:false — argv is element-built). The
// in-process override never runs it; the argv is still the driver's input.
export const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-agent-cli.mjs', import.meta.url));

// The driver reads key VALUES from the environment at run() time (the route
// carries names only); the conformance endpoint's fake key is set once here.
process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

// ---------------------------------------------------------------------------
// Routing: the default table + the suite's canonical handles as endpoints
// ---------------------------------------------------------------------------

/**
 * The conformance routing table: the shipped default (zai / deepseek /
 * anthropic, as-of 2026-09) extended with the suite's canonical provider
 * handles — `conformance` (never priced) and `conformance-priced` — pointed
 * at a black-hole URL no child ever contacts (the fixture IS the model).
 */
export function conformanceRoutingTable(): RoutingTable {
  return RoutingTableSchema.parse({
    endpoints: {
      ...defaultRoutingTable().endpoints,
      conformance: {
        baseUrlEnv: 'CONFORMANCE_BASE_URL',
        baseUrlDefault: 'http://127.0.0.1:1/anthropic',
        keyEnv: 'CONFORMANCE_API_KEY',
        models: ['conformance-1'],
        notes: 'test endpoint: the fake agent CLI is the model; the URL is never contacted',
      },
      'conformance-priced': {
        baseUrlEnv: 'CONFORMANCE_PRICED_BASE_URL',
        baseUrlDefault: 'http://127.0.0.1:1/anthropic',
        keyEnv: 'CONFORMANCE_API_KEY',
        models: ['priced-1'],
        notes: 'test endpoint for the derived-costUSD conformance leg',
      },
    },
  });
}

/** The --allowedTools value of a built argv (the fixture's permission gate). */
export function allowedToolsArg(args: readonly string[]): string {
  const index = args.indexOf('--allowedTools');
  return index !== -1 && index + 1 < args.length ? (args[index + 1] as string) : '';
}

/** The parsed --json-schema value of a built argv (the CLI's structured-output contract). */
export function jsonSchemaArgOf(args: readonly string[]): Record<string, unknown> {
  const index = args.indexOf('--json-schema');
  if (index === -1 || index + 1 >= args.length) throw new Error('--json-schema missing from argv');
  return JSON.parse(args[index + 1] as string) as Record<string, unknown>;
}

/** One recorded spawn call: the exact argv + env the driver handed over. */
export interface SpawnCall {
  args: string[];
  env: Record<string, string>;
}

/**
 * The fixture env a spawn adds over the driver's child env: the test's
 * FAKE_AGENT_* knobs, plus the driver's --allowedTools value forwarded
 * verbatim — the fixture's permission simulation reads FAKE_AGENT_ALLOWED,
 * so it simulates --permission-prompts none faithfully.
 */
export function personaEnv(
  args: readonly string[],
  extraEnv: Record<string, string>,
): Record<string, string> {
  return { ...extraEnv, FAKE_AGENT_ALLOWED: allowedToolsArg(args) };
}

/** Base driver options shared by every test: fake binary, conformance routes, scratch dirs. */
export function baseDriverOptions(scratchDir: string, spawn: SpawnFn): SubprocessDriverOptions {
  return {
    binary: ['node', FAKE_CLI],
    routingTable: conformanceRoutingTable(),
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    harnessConfig: { ...defaultHarnessConfig, workspaceRoot: join(scratchDir, 'workspaces') },
    spawn,
  };
}

/** Minimal invocation for the driver-specific tests. */
export function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'driver-specific run',
    modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: 'workspace-write' },
    budget: {},
    ...overrides,
  };
}

/** Fresh scratch dir + store; cleaned up by the test's finally block. */
export async function withScratch(
  body: (scratchDir: string, store: SessionStore) => Promise<void>,
): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'subdrv-'));
  const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
  try {
    await body(scratchDir, store);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** The narration record message's parsed entries (termination markers etc.). */
export async function narrationOf(store: SessionStore, sessionId: string): Promise<string[]> {
  const record = await store.load(sessionId);
  const entry = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'cli-narration');
  return entry === undefined ? [] : (JSON.parse(entry.content) as string[]);
}

/** Parse the env-probe line a spawned worker wrote (issue #183 test). */
export function probeEnvOf(narration: readonly string[]): Record<string, string> {
  const line = narration.find((entry) => entry.startsWith('CQ_ENV_PROBE:'));
  if (line === undefined) throw new Error('env probe line missing from narration');
  return JSON.parse(line.slice('CQ_ENV_PROBE:'.length)) as Record<string, string>;
}
