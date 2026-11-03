import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACP_SESSION_FILE, NARRATION_TOOL } from '../../src/driver/acp/index.js';
import type { AcpDriverOptions } from '../../src/driver/acp/index.js';
import { spawnAcpProcess } from '../../src/driver/acp/process.js';
import type { AcpSpawnFn } from '../../src/driver/acp/process.js';
import {
  SESSIONS_DIR,
  CONFORMANCE_PROVIDER,
  CONFORMANCE_MODEL,
} from '../../src/driver/conformance.js';
import { SessionStore } from '../../src/harness/session.js';
import type { Clock } from '../../src/kernel/governor.js';
import type { OpInvocation } from '../../src/driver/types.js';

// The fake ACP server: node + the fixture script, spawned through the
// driver's argv template `command` option (shell:false — argv is
// element-built; the resolved binary rides the spawn seam's command).
export const FAKE_ACP_SERVER = fileURLToPath(
  new URL('../fixtures/fake-acp-server.mjs', import.meta.url),
);

/** One recorded spawn call: the exact argv + env the driver handed over. */
export interface SpawnCall {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * A spawn seam that records every call (argv/env evidence for the resume,
 * modelEnv, and zero-spawn assertions) and merges `extraEnv` over the
 * driver's child env before delegating to the REAL spawnAcpProcess — the
 * fixture is a real process in a real workspace, only the MODEL is fake.
 */
export function recordingSpawn(
  calls: SpawnCall[],
  extraEnv: Record<string, string> = {},
): AcpSpawnFn {
  return (opts) => {
    calls.push({ command: opts.command, args: [...opts.args], env: { ...opts.env } });
    return spawnAcpProcess({ ...opts, env: { ...opts.env, ...extraEnv } });
  };
}

/** Base driver options shared by every test: fake binary, scratch dirs, env injection. */
export function acpSidecarPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}${ACP_SESSION_FILE}`);
}

export function driverOptions(
  scratchDir: string,
  extraEnv: Record<string, string>,
  calls: SpawnCall[],
): AcpDriverOptions {
  return {
    command: ['node', FAKE_ACP_SERVER],
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    workspaceRoot: join(scratchDir, 'workspaces'),
    // The REQUESTED model rides the modelEnv channel to the harness; the
    // fake reports it back as the MATERIALIZED model, so the observed-
    // model leg (m) exercises the honest request→observe chain end to end.
    modelEnv: 'FAKE_ACP_MODEL',
    spawn: recordingSpawn(calls, extraEnv),
  };
}

/** Calls `onInFlight` once the child observably holds the prompt the driver dispatched. */
type PromptInFlight = (child: ChildProcess, onInFlight: () => void) => void;

/**
 * A governed deadline that lands MID-PROMPT by construction: a manual clock
 * whose first rung (the signal) fires only once `inFlight` observes the
 * prompt on the real child. A wall-clock deadline races the handshake — on
 * a loaded host it fired before the prompt (the pre-prompt-abort branch,
 * no session/cancel), so a mid-prompt assertion measured the host, not the
 * driver. Later rungs never fire: a driver that cannot settle hangs into
 * the test timeout, the regression signal these tests document.
 */
export function midPromptDeadline(
  options: AcpDriverOptions,
  inFlight: PromptInFlight,
): { options: AcpDriverOptions; clock: Clock } {
  let fireSignal: (() => void) | undefined;
  const clock: Clock = {
    now: () => 0,
    setTimeout: (fn) => {
      fireSignal ??= fn; // only rung 1 is flushable — the later rungs must never fire
      return { rung: 'signal' };
    },
    clearTimeout: () => undefined,
  };
  const inner = options.spawn ?? spawnAcpProcess;
  const spawn: AcpSpawnFn = (opts) => {
    const child = inner(opts);
    // setImmediate, not a synchronous fire: this seam attaches its taps
    // BEFORE the driver's own stdout listener (AcpWire, constructed with no
    // await after the spawn), so it sees each chunk first. Deferring past
    // the current I/O callback lets the driver fold the chunk that proves
    // the prompt is in flight before the abort lands — a deadline firing
    // on an idle mid-prompt wait, not inside the driver's frame handling.
    inFlight(child, () => setImmediate(() => fireSignal?.()));
    return child;
  };
  return { options: { ...options, spawn }, clock };
}

/** The fixture HOLDS the prompt: it emits usage_update only from its session/prompt flows. */
export const fixtureHoldsPrompt: PromptInFlight = (child, onInFlight) => {
  let seen = '';
  const tap = (chunk: string): void => {
    seen += chunk;
    if (!seen.includes('"usage_update"')) return;
    child.stdout?.off('data', tap);
    onInFlight();
  };
  child.stdout?.on('data', tap);
};

/** The stalled-write test's prompt size: large enough to wedge behind any OS pipe buffer. */
export const WEDGED_PROMPT_CHARS = 1024 * 1024;

/**
 * Backlog that only the wedged prompt can produce. The handshake frames
 * (initialize, session establishment, the mode pin) total a few KiB, so
 * even all of them queued at once stay far below this; the pipe buffer
 * (16–64 KiB) is irrelevant because writableLength counts a chunk in full
 * until its write callback, and the unread prompt's callback never fires.
 */
const WEDGED_PROMPT_BACKLOG = WEDGED_PROMPT_CHARS / 2;

/**
 * The prompt write is WEDGED: the stalled-stdin fixture never reads the
 * prompt, so the driver's stdin holds a prompt-scale backlog that never
 * drains. A state predicate polled until true or the child exits — never
 * a deadline.
 */
export const promptWriteWedged: PromptInFlight = (child, onInFlight) => {
  let closed = false;
  child.once('close', () => {
    closed = true;
  });
  const poll = (): void => {
    if (closed || child.exitCode !== null || child.signalCode !== null) return;
    if ((child.stdin?.writableLength ?? 0) > WEDGED_PROMPT_BACKLOG) onInFlight();
    else setTimeout(poll, 10);
  };
  poll();
};

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

/** A run that is expected to THROW — resolves with the thrown value (errorClassOf fodder). */
export async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (err) {
    return err;
  }
}
