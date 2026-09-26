// Process-free helpers shared by the ACP driver tests: acp.test.ts (the
// fake ACP server's persona in-process) and acp.real.test.ts (the fixture
// as a REAL process). Each file owns its spawn seam, so the process-entry
// inventory scan (test/driver/process-inventory.test.ts, *.test.ts only)
// sees exactly the file that launches the fixture.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NARRATION_TOOL } from '../../src/driver/acp/index.js';
import type { AcpDriverOptions } from '../../src/driver/acp/index.js';
import type { AcpSpawnFn } from '../../src/driver/acp/process.js';
import type { OpInvocation } from '../../src/driver/types.js';
import { SessionStore } from '../../src/harness/session.js';
import { CONFORMANCE_MODEL, CONFORMANCE_PROVIDER, SESSIONS_DIR } from './conformance.js';

// The fake ACP server: node + the fixture script, spawned through the
// driver's argv template `command` option (shell:false — argv is
// element-built; the resolved binary rides the spawn seam's command). The
// in-process seam never runs it; the argv is still the driver's evidence.
export const FAKE_ACP_SERVER = fileURLToPath(
  new URL('../fixtures/fake-acp-server.mjs', import.meta.url),
);

/** One recorded spawn call: the exact argv + env the driver handed over. */
export interface SpawnCall {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Base driver options shared by every test: fake binary, scratch dirs, the given spawn seam. */
export function baseDriverOptions(scratchDir: string, spawn: AcpSpawnFn): AcpDriverOptions {
  return {
    command: ['node', FAKE_ACP_SERVER],
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    workspaceRoot: join(scratchDir, 'workspaces'),
    // The REQUESTED model rides the modelEnv channel to the harness; the
    // fake reports it back as the MATERIALIZED model, so the observed-
    // model leg (m) exercises the honest request→observe chain end to end.
    modelEnv: 'FAKE_ACP_MODEL',
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
  const scratchDir = await mkdtemp(join(tmpdir(), 'acpdrv-'));
  const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
  try {
    await body(scratchDir, store);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** The narration record message's parsed entries (tripwire/mismatch markers etc.). */
export async function narrationOf(store: SessionStore, sessionId: string): Promise<string[]> {
  const record = await store.load(sessionId);
  const entry = record?.messages.find((m) => m.role === 'tool' && m.toolName === NARRATION_TOOL);
  return entry === undefined ? [] : (JSON.parse(entry.content) as string[]);
}
