// The acp driver instantiation — T1.8.
//
// Two layers, mirroring test/driver/subprocess.test.ts:
//   1. THE CONFORMANCE SUITE (test/driver/conformance.ts, verbatim) run
//      against the real AcpDriver spawning the FAKE ACP server
//      (test/fixtures/fake-acp-server.mjs) through the driver's spawn
//      seam — a REAL process speaking the REAL wire shapes (nested
//      session/update payloads, configOptions model reporting with the
//      lazy-vs-materialized split, kind-based permission options with
//      vendor-string optionIds, PromptResponse usage). No vendor binary,
//      no network, no @agentclientprotocol/sdk.
//   2. DRIVER-SPECIFIC tests: the absent-binary pre-dispatch throw (§3),
//      the unknown-endpoint + unknown-sessionRef throws, THE PERMISSION
//      ANSWER-TABLE legs (allow selects allow_once; the allow_always
//      fallback when only allow_always is offered; reject selects
//      reject_once by vendor-string optionId; a deny with no reject
//      option AND an allow with no allow option each fail the run,
//      narrating WHICH side failed — and the selection failure pins the
//      verdict 'error' even when a termination-tolerant vendor settles
//      end_turn past it), the never-asks tripwire, the probe-recorded
//      placeholder permission card (never mistaken for the tool
//      execution — the run stays a clean complete), the
//      replay window (bait-before-response discarded; a post-load frame
//      sharing the response's stdout flush FOLDS — the line-level gate),
//      the THREE-RUNG resume gate (session/load → unstable_resumeSession
//      → the honest partial, narrated), served-model surfacing + the
//      FAKE_ACP_SERVED_MODEL mismatch demonstration (the observed-model
//      check catches it — the subprocess remap test's framing), usage
//      mapping (fixed numbers → the DERIVED input, the wire's inputTokens
//      being INCLUSIVE of the cached tokens — no reasoning field), the
//      stdout frame-straddle leg (a ~20k-char frame split across flushes
//      survives the line buffer — frames are the data), the resume sidecar
//      discipline, cancel → 'aborted' over the governed signal, the
//      attach-time abort recheck (a deadline firing before the listener
//      attach still cancels the child — abort events are not replayed),
//      the mode-pin observability, the protocol-version mismatch verdict,
//      and the prompt-directed-JSON drop rule — plus the round-4 Codex
//      legs: a cancel write STALLED behind a wedged prompt cannot gate the
//      kill (the bounded grace starts the ladder — the decided kill never
//      depends on the cooperation of the thing being killed), and a tool
//      result reported via content blocks (no rawOutput) lands in the
//      record output and in the denial reason (textOfContent-style
//      extraction). Plus the review-debt sweep legs: the mode pin must be CONFIRMED by the
//      response echo (#39), the denied-execution tripwire (#45), a
//      structured rawOutput folds at the protocol boundary (#49), an
//      oversized frame fails the connection (#42), relative PATH entries
//      resolve absolute (#46), and win32 PATHEXT candidates (#40).
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { AcpDriver, ACP_SESSION_FILE, NARRATION_TOOL } from '../../src/driver/acp/index.js';
import {
  carriesPathSeparator,
  defaultAcpEndpointTable,
  AcpEndpointTableSchema,
  resolveAcpCommand,
} from '../../src/driver/acp/binaries.js';
import type { ExecutableProbe } from '../../src/driver/acp/binaries.js';
import type { AcpDriverOptions } from '../../src/driver/acp/index.js';
import { argvForShimSpawn, spawnAcpProcess } from '../../src/driver/acp/process.js';
import type { AcpSpawnFn } from '../../src/driver/acp/process.js';
import { runDriverConformance } from './conformance.js';
import type { ConformanceSpec, ModelDirective } from './conformance.js';
import { mapWireUsage } from '../../src/driver/acp/protocol.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER, CONFORMANCE_MODEL } from './conformance.js';
import { SessionStore } from '../../src/harness/session.js';
import { runLadder } from '../../src/kernel/governor.js';
import type { Clock } from '../../src/kernel/governor.js';
import type { Driver, OpInvocation } from '../../src/driver/types.js';

// The fake ACP server: node + the fixture script, spawned through the
// driver's argv template `command` option (shell:false — argv is
// element-built; the resolved binary rides the spawn seam's command).
const FAKE_ACP_SERVER = fileURLToPath(new URL('../fixtures/fake-acp-server.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Directive → FAKE_ACP_* env (the conformance script contract, scripted
// into the fixture). The spawn seam injects these per driver instance —
// process.env is never mutated per-run.
// ---------------------------------------------------------------------------

function directiveEnv(directive: ModelDirective | undefined): Record<string, string> {
  switch (directive?.kind) {
    case 'block-until-abort':
      return { FAKE_ACP_MODE: 'block-until-abort' };
    case 'fail':
      return { FAKE_ACP_MODE: 'fail' };
    case 'tool-then-reply':
      return {
        FAKE_ACP_MODE: 'tool-then-reply',
        FAKE_ACP_TOOL: directive.tool,
        FAKE_ACP_INPUT: JSON.stringify(directive.input),
        FAKE_ACP_REPLY: directive.reply,
      };
    case 'reply':
      return { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: directive.text };
    default:
      return { FAKE_ACP_MODE: 'ok' };
  }
}

/** One recorded spawn call: the exact argv + env the driver handed over. */
interface SpawnCall {
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
function recordingSpawn(calls: SpawnCall[], extraEnv: Record<string, string> = {}): AcpSpawnFn {
  return (opts) => {
    calls.push({ command: opts.command, args: [...opts.args], env: { ...opts.env } });
    return spawnAcpProcess({ ...opts, env: { ...opts.env, ...extraEnv } });
  };
}

/** Base driver options shared by every test: fake binary, scratch dirs, env injection. */
function driverOptions(scratchDir: string, extraEnv: Record<string, string>, calls: SpawnCall[]): AcpDriverOptions {
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

/** Fresh AcpDriver honoring the ConformanceSpec contract. */
function makeDriver(spec: ConformanceSpec): Driver {
  const calls: SpawnCall[] = [];
  return new AcpDriver({
    ...driverOptions(spec.scratchDir, directiveEnv(spec.directive), calls),
    ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
    // The priced handle flows through the price lookup so the conformance
    // suite can assert a derived costUSD; everything else stays unpriced.
    ...(spec.pricedModel !== undefined
      ? {
          pricing: (modelSpec: { provider: string; model: string }) =>
            modelSpec.provider === spec.pricedModel?.provider
              ? { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }
              : undefined,
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. The conformance suite, fake-ACP-server-backed
// ---------------------------------------------------------------------------

runDriverConformance(makeDriver, { label: 'acp driver (fake ACP server)' });

// ---------------------------------------------------------------------------
// 2. Driver-specific tests
// ---------------------------------------------------------------------------

/** Minimal invocation for the driver-specific tests. */
function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
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
async function withScratch(body: (scratchDir: string, store: SessionStore) => Promise<void>): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'acpdrv-'));
  const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
  try {
    await body(scratchDir, store);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** The narration record message's parsed entries (tripwire/mismatch markers etc.). */
async function narrationOf(store: SessionStore, sessionId: string): Promise<string[]> {
  const record = await store.load(sessionId);
  const entry = record?.messages.find((m) => m.role === 'tool' && m.toolName === NARRATION_TOOL);
  return entry === undefined ? [] : (JSON.parse(entry.content) as string[]);
}

describe('win32 .cmd/.bat shim spawn translation (review-debt #54/#55)', () => {
  test('a resolved .cmd/.bat shim routes through cmd.exe /d /s /c as ONE verbatim token', () => {
    // The PATHEXT walk (issue #40) resolves npm's .cmd shims, but Node's
    // CVE-2024-27980 hardening rejects a DIRECT shell-less spawn of them
    // (EINVAL) — the launch must route through cmd.exe. Pure argv mapping,
    // keyed on the injected platform so it is testable everywhere.
    expect(argvForShimSpawn('C:\\tools\\zcode-acp-server.cmd', ['--flag', 'v'], 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\tools\\zcode-acp-server.cmd --flag v"'],
      windowsVerbatimArguments: true,
    });
    expect(argvForShimSpawn('C:\\tools\\dsh.BAT', [], 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\tools\\dsh.BAT"'],
      windowsVerbatimArguments: true,
    });
    // Case-insensitive extension match (PATHEXT is uppercase by default,
    // but a lowercase-suffixed shim is the same file).
    expect(argvForShimSpawn('C:\\x\\tool.CMD', ['a'], 'win32')?.command).toBe('cmd.exe');
    // Element boundaries survive: a space-bearing path and a two-word
    // argument each stay ONE element, inside the ONE outer quote pair
    // that /s strips (PR #111 + PR #119 reviews).
    const quoted = argvForShimSpawn(
      'C:\\Program Files\\nodejs\\zcode-acp-server.cmd',
      ['--prompt', 'two words'],
      'win32',
    );
    expect(quoted.command).toBe('cmd.exe');
    expect(quoted.args[3]).toBe(
      `"\"C:\\Program Files\\nodejs\\zcode-acp-server.cmd\" --prompt "two words\""`,
    );
  });

  test('everything else passes through verbatim: exes, scripts, and any non-win32 platform', () => {
    expect(argvForShimSpawn('C:\\tools\\zcode.exe', ['--x'], 'win32')).toEqual({
      command: 'C:\\tools\\zcode.exe',
      args: ['--x'],
      windowsVerbatimArguments: false,
    });
    expect(argvForShimSpawn('node', ['server.js'], 'win32')).toEqual({
      command: 'node',
      args: ['server.js'],
      windowsVerbatimArguments: false,
    });
    // A .cmd path on POSIX is a plain file like any other — no routing.
    expect(argvForShimSpawn('/usr/local/bin/tool.cmd', [], 'darwin')).toEqual({
      command: '/usr/local/bin/tool.cmd',
      args: [],
      windowsVerbatimArguments: false,
    });
    expect(argvForShimSpawn('/usr/local/bin/tool.cmd', [], 'linux')).toEqual({
      command: '/usr/local/bin/tool.cmd',
      args: [],
      windowsVerbatimArguments: false,
    });
  });
});

describe('acp driver specifics (fake ACP server)', () => {
  test('absent binary: the pre-dispatch throw names the binary + install hint BEFORE any spawn (§3)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver({
        command: ['cq-acp-binary-definitely-absent'],
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        spawn: recordingSpawn(calls),
      });
      await expect(driver.run(invocation())).rejects.toThrow(
        /harness binary 'cq-acp-binary-definitely-absent' was not found .* install .* refusing pre-dispatch/,
      );
      // Pre-dispatch means PRE-dispatch: zero spawns — the sessions dir is
      // never even created (store.create would have mkdir'd it).
      expect(calls).toEqual([]);
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  test('unknown endpoint + absent endpoint binary: loud registry throws (the default table untouched)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const table = AcpEndpointTableSchema.parse({
        endpoints: {
          ...defaultAcpEndpointTable().endpoints,
          'absent-harness': {
            command: ['cq-absent-harness-bin'],
            installHint: 'npm install -g some-absent-harness',
            notes: 'test endpoint: a registry name whose binary does not exist on this host',
          },
        },
      });
      const unknown = new AcpDriver({
        endpoint: 'nope',
        endpointTable: table,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        spawn: recordingSpawn(calls),
      });
      await expect(unknown.run(invocation())).rejects.toThrow(/unknown endpoint 'nope' .*zcode-acp-server, dsh-acp/);
      const absent = new AcpDriver({
        endpoint: 'absent-harness',
        endpointTable: table,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        spawn: recordingSpawn(calls),
      });
      await expect(absent.run(invocation())).rejects.toThrow(/'cq-absent-harness-bin' was not found/);
      await expect(absent.run(invocation())).rejects.toThrow(/npm install -g some-absent-harness/);
      expect(calls).toEqual([]);
    });
  });

  test('unknown sessionRef: the pre-dispatch throw, zero spawns (a fake resume is worse than a loud one)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(driverOptions(scratchDir, {}, calls));
      await expect(driver.run(invocation({ sessionRef: 'ses-never-created' }))).rejects.toThrow(
        /unknown sessionRef 'ses-never-created'/,
      );
      expect(calls).toEqual([]);
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  test('envNames: a missing host env var throws pre-dispatch (names in config, never values)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, {}, calls),
        envNames: ['CQ_ACP_DEFINITELY_UNSET_VAR'],
      });
      await expect(driver.run(invocation())).rejects.toThrow(/envNames entry 'CQ_ACP_DEFINITELY_UNSET_VAR' is not set/);
      expect(calls).toEqual([]);
    });
  });

  test('answer table: allow selects allow_once (the vendor-string optionId echoed)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'tool-then-reply', FAKE_ACP_TOOL: 'read', FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }) },
          calls,
        ),
      );
      const result = await driver.run(invocation({ prompt: 'allow run' }));
      expect(result.stopReason).toBe('complete');
      // The fixture echoes the ANSWERED optionId: the default options offer
      // allow_once first, and the driver's ALLOW side of the answer table
      // selects exactly that vendor string.
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[permission:allow_once]'))).toBe(true);
      // The gate fired (a permission round-trip happened) and the read
      // executed: a real role 'tool' message for the executed read.
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(true);
    });
  });

  test('answer table: the allow_always fallback when ONLY allow_always is offered', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
            // Only the always-allow option exists — the ALLOW side must fall through to it.
            FAKE_ACP_OPTIONS: JSON.stringify([{ optionId: 'a_always', kind: 'allow_always' }]),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'allow-always run' }));
      expect(result.stopReason).toBe('complete');
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[permission:a_always]'))).toBe(true);
    });
  });

  test('answer table: reject selects reject_once — the denial is synthesized AT the answer', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'tool-then-reply', FAKE_ACP_TOOL: 'edit', FAKE_ACP_INPUT: JSON.stringify({ path: 'x.txt', oldText: 'a', newText: 'b' }) },
          [],
        ),
      );
      // Allowlist that does NOT contain 'edit': the DENY side selects the
      // reject_once option — which on the reference vendor's option table
      // carries the VENDOR STRING 'deny' (probe verbatim).
      const result = await driver.run(
        invocation({ prompt: 'reject run', toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('complete'); // the turn settles end_turn after a deny (probed)
      // `kind` is ABSENT from the request's toolCall on the probed wire —
      // the denial reason records that honestly ('kind unknown'); the
      // identity comes from the title's leading tool name.
      expect(result.denials).toEqual([
        { tool: 'edit', reason: 'tool policy: not allowlisted (kind unknown)' },
      ]);
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[permission:deny]'))).toBe(true);
      // The denied tool never executed: no role 'tool' message for it.
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'edit')).toBe(false);
    });
  });

  test('answer table: a deny with NO reject option fails the run, naming the offered options', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'edit',
            // An allow-only option set: the deny side has NO answer (strategy §2.1 — fail the run).
            FAKE_ACP_OPTIONS: JSON.stringify([{ optionId: 'only_allow', kind: 'allow_once' }]),
          },
          [],
        ),
      );
      const result = await driver.run(
        invocation({ prompt: 'deny-deadlock run', toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('error'); // never answered 'cancelled'; never hung
      const narration = await narrationOf(store, result.sessionId as string);
      const failed = narration.find((line) => line.includes('"permission-answer-failed"'));
      expect(failed !== undefined && failed.includes('"only_allow"')).toBe(true);
      expect(failed !== undefined && failed.includes('"allow_once"')).toBe(true);
    });
  });

  test('answer table: an ALLOW decision with no allow option fails the run, narrating the ALLOW side — not the deny wording', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            // A reject-only option set: the ALLOW side has NO answer —
            // the mirror image of the deny-side deadlock (round-2 review:
            // both sides fail the run loudly, each narrated as its OWN
            // side, never mislabeled).
            FAKE_ACP_OPTIONS: JSON.stringify([{ optionId: 'only_reject', kind: 'reject_once' }]),
          },
          [],
        ),
      );
      // Unrestricted policy → the decision is ALLOW → no allow option
      // exists → the run fails.
      const result = await driver.run(invocation({ prompt: 'allow-deadlock run' }));
      expect(result.stopReason).toBe('error'); // never answered 'cancelled'; never hung
      const narration = await narrationOf(store, result.sessionId as string);
      const failed = narration.find((line) => line.includes('"permission-answer-failed"'));
      expect(failed !== undefined && failed.includes('"side":"allow"')).toBe(true);
      expect(failed !== undefined && failed.includes('no allow option offered on the allow side')).toBe(true);
      expect(failed !== undefined && failed.includes('no reject option offered')).toBe(false);
    });
  });

  test('answer table: the SELECTION failure pins the verdict error even when the tolerant vendor settles end_turn anyway', async () => {
    await withScratch(async (scratchDir, store) => {
      // The tolerant-vendor persona (FAKE_ACP_IGNORE_CANCEL: the cancel
      // notification is swallowed, the termination SIGNAL is ignored, an
      // unanswered ask TIMES OUT into an end_turn settle) + the allow-side
      // deadlock: the driver cannot answer the ask and terminates the
      // child — the vendor ignores the termination, times out its
      // unanswered ask, and settles end_turn with real usage anyway. A
      // driver that trusts the wire outcome reads that shape as
      // 'complete'; the failed ENFORCEMENT pins 'error' (the
      // answerWriteFailed mirror, round-3) while the measurement still
      // folds — it really happened.
      const driver = new AcpDriver({
        ...driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_OPTIONS: JSON.stringify([{ optionId: 'only_reject', kind: 'reject_once' }]),
            FAKE_ACP_IGNORE_CANCEL: '1',
          },
          [],
        ),
        // The SIGTERM grace gives the fixture's 250 ms settle timer a wide
        // margin over the failed-selection ladder's SIGKILL escalation
        // (review-debt #48): the timer starts when the ASK goes out,
        // BEFORE the driver handles the failed selection — at the old
        // 500 ms the settle-to-SIGKILL margin was ~250 ms of real time, a
        // race a loaded runner could lose (fixture killed before its
        // end_turn folded).
        termGraceMs: 2000,
        killGraceMs: 500,
      });
      const result = await driver.run(invocation({ prompt: 'tolerant-vendor selection-failure run' }));
      expect(result.stopReason).toBe('error'); // pinned — never 'complete', however green the wire looks
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }); // the end_turn measurement folds
      const narration = await narrationOf(store, result.sessionId as string);
      const failed = narration.find((line) => line.includes('"permission-answer-failed"'));
      expect(failed !== undefined && failed.includes('"side":"allow"')).toBe(true);
    });
  }, 20_000);

  test('THE NEVER-ASKS TRIWIRE: an ungated tool_call is evidence + an error verdict — never green', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'never-asks', FAKE_ACP_TOOL: 'run', FAKE_ACP_INPUT: JSON.stringify({ command: 'echo never-asks-marker > ungated.txt' }) },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'never-asks run' }));
      // Even under an UNRESTRICTED policy (every ask would be answered
      // allow), a harness that never asks is a policy void — fail loud.
      expect(result.stopReason).toBe('error');
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"never-asks"'));
      expect(marker !== undefined && marker.includes('call_ungated_')).toBe(true);
      // The ungated execution really happened (visceral evidence): the file exists.
      const record = await store.load(result.sessionId as string);
      const workspace = record?.workspace as string;
      const ungated = await readFile(join(workspace, 'ungated.txt'), 'utf8');
      expect(ungated).toContain('never-asks-marker');
    });
  });

  test('THE DENIED-EXECUTION TRIPWIRE (#45): a denied toolCallId reporting completed is ungated-execution evidence — error, never green', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_DENY_BUT_COMPLETE: the ask fires, the driver answers
      // reject — and the fixture EXECUTES the tool anyway, reporting the
      // same toolCallId completed (first-channel-wins keeps the id on the
      // 'permission' channel, so the never-asks wire alone would miss
      // this bypass). The verdict fails loud; the bypass is real (the
      // file exists) but never persisted as a governed tool message.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({ command: 'echo denied-but-ran-marker > denied-ran.txt' }),
            FAKE_ACP_DENY_BUT_COMPLETE: '1',
          },
          [],
        ),
      );
      const result = await driver.run(
        invocation({ prompt: 'denied-but-completed run', toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('error');
      // `kind` is ABSENT from the ask's toolCall on the recorded wire — the
      // denial reason says so honestly (the same shape as the reject test).
      expect(result.denials).toEqual([{ tool: 'run', reason: 'tool policy: not allowlisted (kind unknown)' }]);
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"denied-tool-completed"'));
      expect(marker !== undefined && marker.includes('call_run_')).toBe(true);
      const record = await store.load(result.sessionId as string);
      const workspace = record?.workspace as string;
      const bypassed = await readFile(join(workspace, 'denied-ran.txt'), 'utf8');
      expect(bypassed).toContain('denied-but-ran-marker'); // the bypass really happened
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'run')).toBe(false); // governed surface only
    });
  });

  test('the completed bypass evidence is LATCHED: a later failed update for the same id cannot erase it (CodeRabbit P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // DENY_BUT_COMPLETE + LATE_FAIL: denied → completed (the bypass) →
      // then a further update reports failed for the same id. The mutable
      // final status must not wipe the latch: the verdict stays 'error'.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({ command: 'echo latch-marker > latch.txt' }),
            FAKE_ACP_DENY_BUT_COMPLETE: '1',
            FAKE_ACP_LATE_FAIL: '1',
          },
          [],
        ),
      );
      const result = await driver.run(
        invocation({ prompt: 'latch run', toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('error'); // latched — the late failed status did not downgrade it
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"denied-tool-completed"'))).toBe(true);
    });
  });

  test('the probe-recorded placeholder permission card is not the tool execution: the run stays a clean complete', async () => {
    await withScratch(async (scratchDir, store) => {
      // The strategy records the bridge's placeholder card — title
      // 'tool permission (<Tool>)', status 'pending', kind 'other',
      // emitted while the ask is PENDING — and warns the driver must not
      // treat that card as the tool execution. With the card live on the
      // wire (FAKE_ACP_PLACEHOLDER_CARD) the run must complete normally:
      // the card's id is the ASK's id (permission precedes it — no
      // never-asks evidence), 'pending' is not 'failed' (no denial), and
      // the real execution still lands in the record.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            // A tool that genuinely SUCCEEDS in the fresh workspace (run +
            // echo): the clean shape — the placeholder card must add no
            // denial of its own, and a succeeding execution adds none
            // either (a failed read would muddy the assertion with the
            // second denial channel).
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({ command: 'echo placeholder-card-ok > placeholder-card-marker.txt' }),
            FAKE_ACP_PLACEHOLDER_CARD: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'placeholder-card run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.denials).toEqual([]);
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"never-asks"'))).toBe(false);
      const record = await store.load(result.sessionId as string);
      // The REAL execution is what the record carries (allow-answered,
      // completed) and the turn settled the normal permission round-trip.
      expect(
        record?.messages.some((m) => m.role === 'tool' && m.toolName === 'run' && m.content.includes('"ok":true')),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[permission:allow_once]')),
      ).toBe(true);
    });
  });

  test('THE SERVED-MODEL TEST: the requested model is observed via the modelEnv chain; a divergence is surfaced honestly', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls));
      const result = await driver.run(invocation({ prompt: 'observed-model run' }));
      // The observed chain: driver → modelEnv → fixture → materialized
      // config_option_update → WorkerResult.model — present and EQUAL to
      // the requested id (leg m's shape).
      expect(result.model).toBe(CONFORMANCE_MODEL);
      // The lazy session/new value is deliberately DIFFERENT
      // ('builtin:zai\<model>'): surfacing it would fail leg m, so passing
      // here PROVES the post-materialization read.
      expect(result.model).not.toBe(`builtin:zai\\${CONFORMANCE_MODEL}`);
      // And the requested id really rode the spawn env (the REQUEST channel).
      expect(calls[0]?.env['FAKE_ACP_MODEL']).toBe(CONFORMANCE_MODEL);

      // The remap demonstration: the vendor serves something ELSE than
      // requested (FAKE_ACP_SERVED_MODEL). The driver surfaces the honest
      // observation — which leg m would fail loudly, exactly like the
      // subprocess lane's remap test (the manufactured-requested id is
      // never substituted).
      const calls2: SpawnCall[] = [];
      const remapping = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_SERVED_MODEL: 'builtin:bigmodel\\GLM-5.3' }, calls2),
      );
      const remapped = await remapping.run(invocation({ prompt: 'remapped run' }));
      expect(remapped.model).toBe('builtin:bigmodel\\GLM-5.3'); // the honest observation
      expect(remapped.model).not.toBe(CONFORMANCE_MODEL); // the suite's leg m fails this run loudly
    });
  });

  test('usage mapping: the fixed fixture numbers become the frozen Usage shape — NO reasoning field', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, []));
      const result = await driver.run(invocation({ prompt: 'usage run' }));
      expect(result.stopReason).toBe('complete');
      // The wire carries {inputTokens:15, outputTokens:5, cachedReadTokens:2,
      // cachedWriteTokens:3} — inputTokens INCLUSIVE of the cached tokens
      // (totalTokens 20 = 15 + 5, the live-sample arithmetic). The fold
      // DERIVES input = 15 − 2 − 3 = 10 (cacheRead/cacheWrite stay the
      // breakdown terms, Σ = 20 = the wire's totalTokens): a driver that
      // maps inputTokens straight through reports 15 and fails here.
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
      // thoughtTokens exists on the wire but its additivity is unproven —
      // reasoning is NEVER emitted (header; strategy §2.3).
      expect('reasoning' in result.usage).toBe(false);
      expect(result.costUSD).toBeUndefined(); // unpriced model — derived-only
      expect(result.costBasis).toBeUndefined();
    });
  });

  test('mapWireUsage: invalid token counts are NO measurement — negative/fractional/NaN/Infinity never reach accounting (PR #37 review, Codex P2)', () => {
    // The probed live sample folds unchanged (input INCLUSIVE of cache,
    // derived by subtraction — the committed arithmetic).
    expect(
      mapWireUsage({ totalTokens: 15722, inputTokens: 15719, outputTokens: 3, cachedReadTokens: 11648, cachedWriteTokens: 0 }),
    ).toEqual({ input: 4071, output: 3, cacheRead: 11648, cacheWrite: 0 });
    // Every field rejects an invalid count by making the WHOLE usage
    // unshapeable: undefined, never zeros-that-look-measured and never a
    // corrupted fold (a negative inputToken could drag a total below
    // Budget.maxTokens; a negative outputToken a negative modeled cost).
    const badUsages: unknown[] = [
      { inputTokens: -1, outputTokens: 3 },
      { inputTokens: 15, outputTokens: -2 },
      { inputTokens: 1.5, outputTokens: 5 },
      { inputTokens: 15, outputTokens: 5, cachedReadTokens: -1 },
      { inputTokens: 15, outputTokens: 5, cachedWriteTokens: 2.5 },
      { inputTokens: 15, outputTokens: 5, thoughtTokens: Number.NaN },
      { inputTokens: 15, outputTokens: 5, totalTokens: Number.POSITIVE_INFINITY },
    ];
    for (const usage of badUsages) {
      expect(mapWireUsage(usage)).toBeUndefined();
    }
  });

  test('measured usage with NO observed served model: the cost is ABSENT even for a priced requested id — never silently priced (PR #37 review, Codex P2)', async () => {
    await withScratch(async (scratchDir) => {
      // FAKE_ACP_NO_SERVED_MODEL: the turn settles end_turn WITH usage but
      // the config_option_update never arrives. Pricing is trivially
      // satisfied for every spec, so the old requested-spec fallback would
      // surface a cost here; the fix keeps it absent (the DD-9 unpriced
      // trip then binds under a maxUsd instead of a silent misprice).
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_NO_SERVED_MODEL: '1' }, []),
        pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
      });
      const result = await driver.run(invocation({ prompt: 'no-observed-model run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }); // real measurement kept
      expect(result.model).toBeUndefined(); // observed-only, never requested
      expect(result.costUSD).toBeUndefined(); // never the requested-spec fallback
      expect(result.costBasis).toBeUndefined();
    });
  });

  test('a response CARRYING usage the wire gate rejects is an ERROR run — never zeros-that-look-measured (PR #97 review, Codex P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_MALFORMED_USAGE: the turn settles end_turn with
      // inputTokens: -1. The verdict must pin to 'error' — the old code
      // treated the unshapeable usage as ABSENT, substituted zeros, and
      // classified the run 'complete', erasing accounting and bypassing
      // the unpriced check under a USD cap.
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_MALFORMED_USAGE: '1' }, []));
      const result = await driver.run(invocation({ prompt: 'malformed-usage run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // never trusted numbers
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"malformed-reported-usage"'))).toBe(true);
    });
  });

  test('a foreign-session ask whose REJECTION write fails settles error — never a hung run (PR #97 review, Codex P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FOREIGN ask + stdin destroyed: the failRequest write EPIPEs, and
      // the vendor would otherwise wait forever for an answer that can
      // never be delivered. The broken-channel posture applies: verdict
      // 'error', the child terminated via the settle ladder, the run
      // settles.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: '{"path":"a.txt"}',
            FAKE_ACP_FOREIGN_PERMISSION_SESSION: '1',
            FAKE_ACP_CLOSE_STDIN_ON_PERMISSION: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'foreign-ask-dead-stdin run' }));
      expect(result.stopReason).toBe('error');
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"permission-rejection-send-failed"'))).toBe(true);
    });
  }, 20_000);

  test('a session/request_permission naming a FOREIGN session is rejected: no answer, no evidence — the ungated tool card fails the run (PR #37 review, Codex P2)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_FOREIGN_PERMISSION_SESSION: the ask names a session that
      // is not this run's. The driver must fail the request BEFORE any
      // answer-table or evidence effects — the foreign ask must not mark
      // its toolCallId permission-first (the never-asks bypass) — and the
      // vendor's subsequent tool card, ungated by any accepted ask, fails
      // the run exactly like any never-asks evidence.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: '{"path":"a.txt"}',
            FAKE_ACP_FOREIGN_PERMISSION_SESSION: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'foreign-ask run' }));
      expect(result.stopReason).toBe('error'); // ungated execution is an error, never green
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"permission-not-scoped"'))).toBe(true);
      expect(narration.some((line) => line.includes('"never-asks"'))).toBe(true); // the bypass is closed
    });
  });

  test('stdout frame straddle: a ~20k-char frame split across flushes survives the line buffer intact (frames are the data)', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture writes ONE session/update whose JSON line is ~20k
      // chars in TWO stdout flushes with no newline between. A driver with
      // the old 8000-char stdout cap destroyed the partial frame mid-JSON
      // (ACP defines no line-length limit) — the transcript lost the chunk
      // and the overflow narration fired; THIS test failed on both.
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_BIG_FRAME: '1' }, []));
      const result = await driver.run(invocation({ prompt: 'big-frame run' }));
      expect(result.stopReason).toBe('complete');
      const record = await store.load(result.sessionId as string);
      // BOTH ends of the straddled frame folded into the transcript: the
      // line buffer held the partial bytes across the flush boundary.
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('BIGFRAME-START')),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('BIGFRAME-END')),
      ).toBe(true);
      // No truncation marker — the frame was never treated as an overflow.
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('stdout line buffer overflow'))).toBe(false);
    });
  });

  test('an oversized frame fails the CONNECTION (#42): error verdict naming the frame — never silent truncation', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_HUGE_FRAME: a >1 MiB frame prefix with NO newline, never
      // completed. The old shape narrated a truncation marker and kept
      // reading — a possibly-valid frame destroyed and the wire misframed
      // forever. The fixed wire fails the connection: the pending prompt
      // rejects naming the oversized frame and the run settles 'error'.
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_HUGE_FRAME: '1' }, []));
      const result = await driver.run(invocation({ prompt: 'oversized frame run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // the turn never settled protocol-side
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('stdout line buffer overflow'))).toBe(true);
      const failure = narration.find((line) => line.includes('"prompt-failure"'));
      expect(failure !== undefined && failure.includes('oversized frame')).toBe(true);
    });
  });

  test('an oversized frame AFTER a settled turn still pins the verdict error — the connection failure is verdict evidence (CodeRabbit P2)', async () => {
    await withScratch(async (scratchDir, store) => {
      // HUGE_FRAME_AFTER_REPLY + IGNORE_CANCEL: a valid turn settles
      // end_turn FIRST, then the (signal-tolerant) harness emits the
      // oversized unterminated frame DURING the settle ladder's term
      // grace. The pending table is empty at failConnection (nothing left
      // to reject) — the stored connection failure must still pin 'error',
      // with the REAL measurement folded (the response did arrive).
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'ok', FAKE_ACP_HUGE_FRAME_AFTER_REPLY: '1', FAKE_ACP_IGNORE_CANCEL: '1' },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'post-reply overflow run' }));
      expect(result.stopReason).toBe('error'); // pinned past the green-looking response
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 }); // the real measurement folds
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('stdout line buffer overflow'))).toBe(true);
      expect(narration.some((line) => line.includes('"connection-failed"'))).toBe(true);
    });
  });

  test('a COMPLETE newline-terminated frame over the line bound still fails the connection — the bound is a true bound (Codex P2)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_HUGE_FRAME_COMPLETE: a whole >1 MiB frame, newline and
      // all. The extraction loop must enforce the bound on COMPLETE frames
      // too — the old check ran only on the unterminated leftover, so a
      // valid oversized frame folded as if nothing was wrong.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_HUGE_FRAME_COMPLETE: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'complete-oversized run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // never settled protocol-side
      const narration = await narrationOf(store, result.sessionId as string);
      // EITHER bound branch may fire depending on how the OS chunks the
      // 1.1 MB write: the complete-line bound (this test's subject) or the
      // unterminated-accumulation overflow — both fail the connection.
      const bounded =
        narration.some((line) => line.includes('exceeds the')) ||
        narration.some((line) => line.includes('stdout line buffer overflow'));
      expect(bounded).toBe(true);
      const failure = narration.find((line) => line.includes('"prompt-failure"'));
      expect(failure !== undefined && failure.includes('oversized frame')).toBe(true);
    });
  });

  test('resume sidecar: the ACP session id persists to the workspace; session/load continues the SAME vendor session', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'resume run one' }));
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      const acpId = (await readFile(join(workspace, ACP_SESSION_FILE), 'utf8')).trim();
      expect(acpId).toMatch(/^fake-acp-/);

      // The resumed run loads the RECORDED session (proven by the fixture
      // echoing the loaded id) and reuses the SAME workspace.
      const calls2: SpawnCall[] = [];
      const second = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'resume-echo' }, calls2));
      const run2 = await second.run(invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }));
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(run2.stopReason).toBe('complete');
      const record = await store.load(run1.sessionId as string);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes(`resumed from acp session ${acpId}`)),
      ).toBe(true);
      // ONE session record carries both runs' turns; the sidecar is stable.
      expect(record?.messages.some((m) => m.role === 'user' && m.content === 'resume run one')).toBe(true);
      expect(record?.messages.some((m) => m.role === 'user' && m.content === 'resume run two')).toBe(true);
      expect((await readFile(join(workspace, ACP_SESSION_FILE), 'utf8')).trim()).toBe(acpId);
    });
  });

  test('resume gate rung 2: unstable_resumeSession when only sessionCapabilities.resume is advertised — the recorded handle resumes (strategy §6)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'rung2 run one' }));
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      const acpId = (await readFile(join(workspace, ACP_SESSION_FILE), 'utf8')).trim();

      const calls2: SpawnCall[] = [];
      // loadSession NOT advertised + sessionCapabilities.resume advertised:
      // the §6 middle rung — the driver must send unstable_resumeSession
      // (method + the recorded session id in params) instead of falling
      // straight to the honest partial.
      const second = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'resume-echo', FAKE_ACP_NO_LOADSESSION: '1', FAKE_ACP_RESUME: '1' },
          calls2,
        ),
      );
      const run2 = await second.run(invocation({ prompt: 'rung2 run two', sessionRef: run1.sessionId }));
      expect(run2.stopReason).toBe('complete');
      const record = await store.load(run2.sessionId as string);
      // The resume REQUEST carried the recorded session id: the fixture
      // adopted it and the echo proves protocol-side continuity (the
      // partial rung would have session/new'd a FRESH id and echoed THAT).
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes(`resumed from acp session ${acpId}`)),
      ).toBe(true);
      // NOT the honest-partial rung: no partial narration.
      const narration = await narrationOf(store, run2.sessionId as string);
      expect(narration.some((line) => line.includes('"resume-partial"'))).toBe(false);
    });
  });

  test('resume gate rung 3: neither capability advertised — the honest-partial narration names BOTH (the sidecar was recorded but is unusable)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'rung3 run one' }));
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      const acpId = (await readFile(join(workspace, ACP_SESSION_FILE), 'utf8')).trim();
      expect(acpId).toMatch(/^fake-acp-/); // the sidecar was WRITTEN — rung 3 gates only its USE

      const calls2: SpawnCall[] = [];
      const second = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'resume-echo', FAKE_ACP_NO_LOADSESSION: '1' }, calls2),
      );
      const run2 = await second.run(invocation({ prompt: 'rung3 run two', sessionRef: run1.sessionId }));
      expect(run2.stopReason).toBe('complete'); // honest partial, never a failure
      const record = await store.load(run2.sessionId as string);
      // The echo carries a FRESH session id (session/new), never the
      // recorded handle — workspace-only continuation.
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes(`resumed from acp session ${acpId}`)),
      ).toBe(false);
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content.includes('resumed from acp session'))).toBe(
        true,
      );
      const narration = await narrationOf(store, run2.sessionId as string);
      const partial = narration.find((line) => line.includes('"resume-partial"'));
      expect(partial !== undefined && partial.includes(acpId)).toBe(true);
      expect(partial !== undefined && partial.includes('NEITHER loadSession NOR sessionCapabilities.resume')).toBe(true);
    });
  });

  test('session/load REPLAY: replayed prior-turn frames are suppressed — honest verdict, clean transcript, the count is the evidence', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'replay run one' }));

      const calls2: SpawnCall[] = [];
      // The resumed run points the fixture at a REPLAYING session/load:
      // three prior-turn session/update frames (a text chunk, a
      // permission-less tool_call, a FAILED tool_call_update) arrive
      // BEFORE the load response — the reference-recorded replay shape
      // (strategy §6). A driver that folds them false-fires the
      // never-asks tripwire (verdict 'error' on an honest run), leaks the
      // prior-turn text into this run's transcript, and synthesizes a
      // phantom denial.
      const second = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'resume-echo', FAKE_ACP_REPLAY: '1' }, calls2),
      );
      const run2 = await second.run(invocation({ prompt: 'replay run two', sessionRef: run1.sessionId }));
      expect(run2.stopReason).toBe('complete'); // NOT the never-asks false 'error'
      expect(run2.denials).toEqual([]); // the replayed failed status synthesized no phantom denial
      const record = await store.load(run2.sessionId as string);
      // The replayed prior-turn text never joined THIS run's transcript —
      // the persisted assistant turn is this run's resume echo only.
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content.includes('REPLAYED'))).toBe(false);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('resumed from acp session')),
      ).toBe(true);
      // The discard sink narrates the COUNT (honest evidence, never the
      // content): all three replayed frames were counted and discarded.
      const narration = await narrationOf(store, run2.sessionId as string);
      const marker = narration.find((line) => line.includes('"replayed-frames-discarded"'));
      expect(marker !== undefined && marker.includes('"count":3')).toBe(true);
      expect(narration.some((line) => line.includes('"never-asks"'))).toBe(false);
    });
  });

  test('the replay window is LINE-gated: a post-load update sharing the load response flush FOLDS; the pre-response bait is still discarded', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const first = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await first.run(invocation({ prompt: 'tail run one' }));

      const calls2: SpawnCall[] = [];
      // The resumed run's session/load emits the bait replay history, then
      // the RESPONSE LINE and a post-load agent_message_chunk in ONE stdout
      // flush. The tail post-dates the load settle: a driver that clears
      // the replay flag only at the load await's continuation processes the
      // WHOLE flush first and drops it (the round-2 chunk-boundary bug);
      // the wire-line gate folds it.
      const second = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'resume-echo', FAKE_ACP_REPLAY_WITH_TAIL: '1' }, calls2),
      );
      const run2 = await second.run(invocation({ prompt: 'tail run two', sessionRef: run1.sessionId }));
      expect(run2.stopReason).toBe('complete'); // the bait never false-fired the tripwire
      expect(run2.denials).toEqual([]); // the replayed failed status synthesized no phantom denial
      const record = await store.load(run2.sessionId as string);
      // THE REGRESSION: the same-flush POST-load tail chunk FOLDED into
      // this run's transcript — and the resume echo folded after it.
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('POST-LOAD tail chunk')),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('resumed from acp session')),
      ).toBe(true);
      // The PRE-response bait frames are still suppressed: no replayed
      // text, exactly the three-frame discard count, no never-asks.
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content.includes('REPLAYED'))).toBe(false);
      const narration = await narrationOf(store, run2.sessionId as string);
      const marker = narration.find((line) => line.includes('"replayed-frames-discarded"'));
      expect(marker !== undefined && marker.includes('"count":3')).toBe(true);
      expect(narration.some((line) => line.includes('"never-asks"'))).toBe(false);
    });
  });

  test('JSON-RPC string request ids: the permission answer echoes the id VERBATIM (no coercion into an uncorrelatable null)', async () => {
    await withScratch(async (scratchDir, store) => {
      // A string session/request_permission id is legal JSON-RPC (the
      // reference vendor sends numbers). A driver that Number()-coerces
      // answers 'id':null — the vendor's ask never resolves and the turn
      // hangs; on a regression THIS test fails by timeout.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
            FAKE_ACP_STRING_REQUEST_IDS: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'string-id run' }));
      expect(result.stopReason).toBe('complete');
      const record = await store.load(result.sessionId as string);
      // The answer CORRELATED: the fixture honored it and echoed the
      // selected optionId — proof the round-trip completed.
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[permission:allow_once]')),
      ).toBe(true);
    });
  });

  test('cancel maps to aborted: the governed signal settles via session/cancel + the cancelled response (§2.3)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(
        { ...driverOptions(scratchDir, { FAKE_ACP_MODE: 'block-until-abort' }, calls), termGraceMs: 500, killGraceMs: 500 },
      );
      // wallClockMs lands MID-PROMPT (after the handshake): the governed
      // signal fires → session/cancel → the cancelled prompt response
      // (usage null) settles the run.
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'cancel run' })),
        { wallClockMs: 1000 },
        { op: 'acp', jobKey: 'acp-cancel', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // usage: null — unmeasured
      expect(outcome.value.costUSD).toBeUndefined(); // never a cost on an unmeasured verdict
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      expect(narration.some((line) => line.includes('"cancel-sent"'))).toBe(true);
    });
  }, 20_000);

  test('a vendor that IGNORES session/cancel cannot hang the governed cancel: the kill rung reaches the child mid-prompt', async () => {
    await withScratch(async (scratchDir, store) => {
      // block-until-abort + the swallow knob: the turn NEVER settles
      // protocol-side. The governed signal fires mid-prompt → the
      // session/cancel courtesy write → the settle ladder terminates the
      // child → the pending prompt rejects on the wire's exit path → the
      // run settles 'aborted'. Without the mid-prompt kill rung (Codex P1)
      // THIS test hangs into its timeout.
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, { FAKE_ACP_MODE: 'block-until-abort', FAKE_ACP_IGNORE_CANCEL: '1' }, []),
        termGraceMs: 300,
        killGraceMs: 300,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'ignore-cancel run' })),
        { wallClockMs: 1000 },
        { op: 'acp', jobKey: 'acp-ignore-cancel', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // unmeasured — the turn never settled protocol-side
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      // The courtesy write landed BEFORE the ladder fired (the settled-write
      // ordering), then the kill settled the run.
      expect(narration.some((line) => line.includes('"cancel-sent"'))).toBe(true);
    });
  }, 20_000);

  test('attach-time abort recheck: a governed signal that fired before the listener attach still cancels the child — the run settles aborted', async () => {
    await withScratch(async (scratchDir, store) => {
      // Manual clock: the ladder's rung-1 timer fires ONLY when the test
      // flushes it — and the flush happens INSIDE the spawn seam, i.e.
      // synchronously between the spawn and the driver's abort-listener
      // attach. That is exactly the window the attach-time recheck guards:
      // the pre-dispatch `signal.aborted` check ran long before, so the
      // abort is injected while appendMessage()/readAcpSessionId()-shaped
      // awaits have already passed; the listener then attaches to an
      // ALREADY-aborted signal, which NEVER receives the abort event. The
      // unfixed driver runs the whole handshake + prompt to 'complete'
      // past a fired deadline; the fixed one cancels the child pre-prompt.
      let fireSignal: (() => void) | undefined;
      const clock: Clock = {
        now: () => 0,
        setTimeout: (fn) => {
          fireSignal ??= fn; // only rung 1 is flushable — the later rungs must never fire
          return { rung: 'signal' };
        },
        clearTimeout: () => undefined,
      };
      const calls: SpawnCall[] = [];
      const abortingSpawn: AcpSpawnFn = (opts) => {
        calls.push({ command: opts.command, args: [...opts.args], env: { ...opts.env } });
        const child = spawnAcpProcess(opts);
        fireSignal?.(); // the governed deadline lands before the listener attach
        return child;
      };
      const driver = new AcpDriver({
        command: ['node', FAKE_ACP_SERVER],
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        modelEnv: 'FAKE_ACP_MODEL',
        termGraceMs: 500,
        killGraceMs: 500,
        spawn: abortingSpawn,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'pre-attach abort run' })),
        { wallClockMs: 60_000 }, // nominal — the manual clock owns when it fires
        { op: 'acp', jobKey: 'acp-pre-attach-abort', attempt: 1 },
        { clock },
      );
      expect(outcome.outcome).toBe('completed'); // the run settled, not ladder-killed
      if (outcome.outcome !== 'completed') return;
      expect(outcome.markers.some((marker) => marker.rung === 'signal')).toBe(true); // the deadline really fired
      expect(outcome.value.stopReason).toBe('aborted');
      // The child was cancelled BEFORE the handshake: no session was ever
      // established, so no assistant turn exists and exactly one spawn
      // (the child that received the termination) happened.
      const record = await store.load(outcome.value.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant')).toBe(false);
      expect(calls).toHaveLength(1);
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      const marker = narration.find((line) => line.includes('"pre-prompt-abort"'));
      expect(marker !== undefined).toBe(true); // the abort path RAN at attach time
      expect(narration.some((line) => line.includes('"cancel-sent"'))).toBe(false); // pre-prompt — nothing to cancel
    });
  });

  test('a cancel write stalled behind a wedged prompt cannot gate the kill: the bounded grace starts the ladder (Codex P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture goes deaf (pauses stdin) right AFTER the mode pin, so
      // the 1 MiB prompt write wedges: only the OS pipe buffer's worth is
      // accepted, the rest sits in the driver's stream queue FOREVER, and
      // the courtesy session/cancel write's callback queues BEHIND it —
      // notify() never settles. The old ladder was gated on the write's
      // .finally(), never fired, and the run hung past the decided kill
      // (THIS test times out on that regression). The fixed driver races
      // the write against cancelWriteGraceMs and runs the ladder
      // regardless of which wins.
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, { FAKE_ACP_MODE: 'block-until-abort', FAKE_ACP_STOP_READ_BEFORE_PROMPT: '1' }, []),
        termGraceMs: 300,
        killGraceMs: 300,
        cancelWriteGraceMs: 100,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'x'.repeat(1024 * 1024) })),
        { wallClockMs: 1000 },
        { op: 'acp', jobKey: 'acp-stalled-cancel-write', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // unmeasured — the turn never settled protocol-side
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      // The grace won the race: the record says the vendor never consumed
      // the cancel before the SIGTERM — and the kill happened anyway.
      expect(narration.some((line) => line.includes('"cancel-write-stalled"'))).toBe(true);
    });
  }, 20_000);

  test('answer-write failure fails the run loudly: a broken enforcement channel settles error, never hangs', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture destroys its own stdin as the permission ask goes out
      // and KEEPS RUNNING: the driver's ALLOW answer write fails (EPIPE)
      // with the prompt still pending. A driver that only narrates the
      // failure hangs here forever (no timeouts by design — I8) — THIS
      // test fails by its timeout on that regression; a correct driver
      // terminates the child via the settle ladder and settles 'error'
      // with the write-failure evidence (Codex P1).
      const driver = new AcpDriver({
        ...driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'read',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }),
            FAKE_ACP_CLOSE_STDIN_ON_PERMISSION: '1',
          },
          [],
        ),
        termGraceMs: 500,
        killGraceMs: 500,
      });
      const result = await driver.run(invocation({ prompt: 'broken-channel run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // unmeasured — the prompt never settled
      expect(result.costUSD).toBeUndefined(); // never a cost on an unmeasured verdict
      const narration = await narrationOf(store, result.sessionId as string);
      const failed = narration.find((line) => line.includes('"permission-answer-send-failed"'));
      expect(failed !== undefined).toBe(true); // the write-failure evidence
    });
  }, 20_000);

  test('the mode pin is observable: the session really runs in build (the echo proves the pin landed)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'tool-then-reply', FAKE_ACP_TOOL: 'read', FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }) },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'mode-pin run' }));
      const record = await store.load(result.sessionId as string);
      // The fixture echoes the session mode AFTER the pin: '[mode:build]',
      // never '[mode:yolo]' — a driver that skipped the pin would fail here.
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[mode:build]')),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[mode:yolo]')),
      ).toBe(false);
    });
  });

  test('the mode pin must be CONFIRMED: a response echoing yolo (or echoing nothing) fails the run pre-prompt (#39)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_IGNORE_MODE_PIN: the pin request is answered 2xx but the
      // fixture never applies it — the echo names 'yolo'. A driver that
      // trusts the 2xx prompts into the policy void; the fixed driver
      // requires EITHER confirmation surface to name 'build' — the echo or
      // a folded current_mode_update — and refuses to prompt when neither
      // does (this persona provides neither).
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_IGNORE_MODE_PIN: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'unconfirmed pin run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // never prompted — unmeasured
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"handshake-failure"'));
      expect(marker !== undefined && marker.includes('mode pin was not confirmed')).toBe(true);
      expect(marker !== undefined && marker.includes("'yolo'")).toBe(true);
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant')).toBe(false); // the prompt never fired
    });
  });

  test('the mode pin confirms from the NOTIFICATION surface: the live shape (no modes echo, current_mode_update build before the response) prompts normally', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_MODE_PIN_NOTIFICATION: the live vendor's recorded shape
      // (probe 2026-09-14) — the set_config_option answer carries NO modes
      // member; the switch is broadcast as current_mode_update 'build'
      // written BEFORE the response line. The driver must confirm the pin
      // from that surface and prompt; an echo-only gate would fail every
      // live run pre-prompt (round-1 review finding 1).
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'tool-then-reply', FAKE_ACP_TOOL: 'read', FAKE_ACP_INPUT: JSON.stringify({ path: 'note.txt' }), FAKE_ACP_MODE_PIN_NOTIFICATION: '1' },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'notification-pin run' }));
      expect(result.stopReason).toBe('complete'); // confirmed via current_mode_update — the prompt fired
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content.includes('[mode:build]'))).toBe(true);
    });
  });

  test('a PRE-pin mode report naming build is STALE — it cannot confirm the pin (PR #53 review, Codex P1)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_PRE_PIN_MODE_BUILD: the agent announces its initial mode
      // 'build' right after session/new (the loading-an-already-build-
      // session shape), and the pin answer carries NO modes echo and NO
      // fresh notification. The only 'build' observation predates the pin
      // request, so a driver that checks observedMode alone would accept
      // the STALE value and prompt without proving THIS pin landed — the
      // fixed driver snapshots the update seq before sending the pin and
      // requires the naming to be newer.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_PRE_PIN_MODE_BUILD: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'stale-mode run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); // never prompted — unmeasured
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"handshake-failure"'));
      expect(marker !== undefined && marker.includes('mode pin was not confirmed')).toBe(true);
      expect(marker !== undefined && marker.includes('STALE')).toBe(true); // the evidence names the staleness
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant')).toBe(false); // the prompt never fired
    });
  });

  test('a POST-PIN mode downgrade is narrated (cq: mode-downgrade) — evidence, never classified alone (round-3, the round-2 fix pinned)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_MODE_DOWNGRADE: after the confirmed pin (materialization
      // already reported build) the harness reports yolo MID-TURN. The
      // settle-time marker must carry the evidence; the verdict stays what
      // the wire said (the never-asks tripwire remains the error path).
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_MODE_DOWNGRADE: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'downgrade run' }));
      expect(result.stopReason).toBe('complete');
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"mode-downgrade"'));
      expect(marker !== undefined && marker.includes("'yolo'")).toBe(true);
    });
  });

  test('an UNSHAPEABLE pin answer is the not-confirmed evidence — distinct from an absent modes echo (round-3, the round-2 fix pinned)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_PIN_UNSHAPEABLE: the set_config_option answer carries
      // modes as a bare string — the safeParse fails, and the failure
      // evidence must say 'unshapeable pin response', not the ambiguous
      // 'no mode echo'.
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_PIN_UNSHAPEABLE: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'unshapeable pin run' }));
      expect(result.stopReason).toBe('error');
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"handshake-failure"'));
      expect(marker !== undefined && marker.includes('unshapeable pin response')).toBe(true);
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant')).toBe(false); // the prompt never fired
    });
  });

  test('protocol-version mismatch: a different negotiated integer fails the run pre-prompt, naming BOTH numbers (§3)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_PROTOCOL_VERSION: '2' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'mismatch run' }));
      expect(result.stopReason).toBe('error'); // never prompted past a mismatch
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"handshake-failure"'));
      expect(marker !== undefined && marker.includes('requested 1, agent answered 2')).toBe(true);
    });
  });

  test('deny-tool: a vendor-side execution failure maps to the frozen {tool, reason} denial channel', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'deny-tool', FAKE_ACP_TOOL: 'edit', FAKE_ACP_INPUT: JSON.stringify({ path: 'x.txt', oldText: 'a', newText: 'b' }) }, []),
      );
      const result = await driver.run(invocation({ prompt: 'deny-tool run' }));
      // The tool executed (allow-answered) and FAILED vendor-side: the
      // second denial channel carries the vendor's rawOutput.
      expect(result.denials).toEqual([
        { tool: 'edit', reason: 'permission denied: edit is not allowed' },
      ]);
      expect(result.stopReason).toBe('complete'); // the turn settled end_turn with real usage
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
    });
  });

  test('a successful tool result reported via content blocks (no rawOutput) lands in the record output (Codex P2)', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture's SUCCESS path emits the tool_call_update with
      // content: [{type:'text', text}] and NO rawOutput — the committed
      // shape the old fold dropped (existing.output stayed ''). The
      // output must be the content blocks' text.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_INPUT: JSON.stringify({ command: 'echo content-block-marker > run-marker.txt' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'content-block success run' }));
      expect(result.stopReason).toBe('complete');
      const record = await store.load(result.sessionId as string);
      const toolMessage = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'run');
      expect(toolMessage !== undefined).toBe(true); // the execution was persisted
      const folded = JSON.parse(toolMessage?.content as string) as { input: unknown; ok: boolean; output: string };
      expect(folded.ok).toBe(true);
      expect(folded.output).toBe('exit 0'); // the block's text — never the empty string the old fold left
    });
  });

  test('a FAILED tool result carried by content blocks only: the denial reason comes from the text (the WorkerResult channel, Codex P2)', async () => {
    await withScratch(async (scratchDir) => {
      // FAKE_ACP_OMIT_RAW_OUTPUT: the content-only persona — even a
      // failure rides content blocks alone. The denial reason must be the
      // blocks' text, never the empty-output fallback wording ('tool
      // execution failed (…)') the old fold produced here.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'deny-tool',
            FAKE_ACP_OMIT_RAW_OUTPUT: '1',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'x.txt', oldText: 'a', newText: 'b' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'content-block failure run' }));
      expect(result.denials).toEqual([
        { tool: 'edit', reason: 'permission denied: edit is not allowed' },
      ]);
      expect(result.stopReason).toBe('complete'); // the turn settled end_turn; the denial rides the frozen channel
    });
  });

  test('a STRUCTURED rawOutput folds: the string-only schema no longer rejects the whole tool_call_update (#49)', async () => {
    await withScratch(async (scratchDir, store) => {
      // FAKE_ACP_RAW_OUTPUT_JSON: the failed execution's rawOutput is an
      // OBJECT. The old string-only schema rejected the ENTIRE frame —
      // terminal status AND output lost (no denial, a card pending
      // forever). The fold stringifies non-strings at the protocol
      // boundary, so the status and the denial reason both survive.
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'deny-tool',
            FAKE_ACP_RAW_OUTPUT_JSON: '1',
            FAKE_ACP_TOOL: 'edit',
            FAKE_ACP_INPUT: JSON.stringify({ path: 'x.txt', oldText: 'a', newText: 'b' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'structured rawOutput run' }));
      expect(result.stopReason).toBe('complete'); // the turn settles end_turn with real usage
      expect(result.denials).toEqual([
        { tool: 'edit', reason: '{"error":"permission denied: edit is not allowed"}' }, // stringified at the boundary
      ]);
      const record = await store.load(result.sessionId as string);
      const toolMessage = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'edit');
      expect(toolMessage !== undefined).toBe(true); // the terminal status survived the fold
      expect((JSON.parse(toolMessage?.content as string) as { ok: boolean; output: string }).output).toBe(
        '{"error":"permission denied: edit is not allowed"}',
      );
    });
  });

  test('structured output: a non-JSON reply is dropped to narration, never trusted (strategy §4)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: 'prose before json {"answer":' }, []),
        outputSchema: z.object({ answer: z.string() }).strict(),
      });
      const result = await driver.run(invocation({ prompt: 'lying harness run' }));
      // The run itself succeeded; only the unrepresentable payload is gone.
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      const narration = await narrationOf(store, result.sessionId as string);
      expect(narration.some((line) => line.includes('"structured-output-unparseable"'))).toBe(true);
    });
  });

  test('the spawn seam receives the resolved binary + driver-built argv (no shell, model env attached)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls));
      await driver.run(invocation({ prompt: 'argv run' }));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toMatch(/node$/); // the resolved binary (which-like PATH hit)
      expect(calls[0]?.args).toEqual([FAKE_ACP_SERVER]); // the driver-built argv tail
      expect(calls[0]?.env['FAKE_ACP_MODEL']).toBe(CONFORMANCE_MODEL); // the modelEnv REQUEST channel
    });
  });

  test('structured output round-trip through the wire: prompt-directed JSON lands in structuredOutput', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver({
        ...driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: '{"answer":"ok"}' }, []),
        outputSchema: z.object({ answer: z.string() }).strict(),
      });
      const result = await driver.run(invocation({ prompt: 'structured run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
    });
  });

  test('path escape: the harness tool containment denial surfaces as the frozen denial', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'tool-then-reply', FAKE_ACP_TOOL: 'read', FAKE_ACP_INPUT: JSON.stringify({ path: '../../outside-secret.txt' }) },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'escape attempt' }));
      expect(result.denials.some((d) => d.tool === 'read' && d.reason.includes('path escape'))).toBe(true);
    });
  });

  test('fresh runs share NOTHING (I6): separate workspaces, separate ACP sessions, separate sidecars', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls1: SpawnCall[] = [];
      const driver1 = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls1));
      const run1 = await driver1.run(invocation({ prompt: 'isolation run one' }));
      const calls2: SpawnCall[] = [];
      const driver2 = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok' }, calls2));
      const run2 = await driver2.run(invocation({ prompt: 'isolation run two' }));
      expect(run2.sessionId).not.toBe(run1.sessionId);
      const record1 = await store.load(run1.sessionId as string);
      const record2 = await store.load(run2.sessionId as string);
      expect(record1?.workspace).not.toBe(record2?.workspace);
      // Each run created a FRESH ACP session (never resumed the other's).
      const id1 = (await readFile(join(record1?.workspace as string, ACP_SESSION_FILE), 'utf8')).trim();
      const id2 = (await readFile(join(record2?.workspace as string, ACP_SESSION_FILE), 'utf8')).trim();
      expect(id1).not.toBe(id2);
      // Run 1's prompt never leaked into run 2's record.
      expect(record2?.messages.some((m) => m.content === 'isolation run one')).toBe(false);
    });
  });
});

describe('acp binary resolution (the §3 which-like fold)', () => {
  // Platform delimiter (issue #41): a fixed colon makes this ONE entry on
  // Windows (';' would split '/cq-tools:/usr/bin' nowhere) — derive it, so
  // the walk is two-dir on every platform.
  const env = { PATH: ['/cq-tools', '/usr/bin'].join(delimiter) };

  test("the documented './bin/acp-server' form is path-carrying: resolved against the caller cwd, NEVER joined to PATH dirs", async () => {
    const seen: string[] = [];
    const probe: ExecutableProbe = async (candidate) => {
      seen.push(candidate);
      return true; // every candidate "exists" — the SHAPE of the resolution is what binds
    };
    const resolved = await resolveAcpCommand(['./bin/acp-server', '--flag'], 'explicit', defaultAcpEndpointTable(), env, probe);
    // Exactly ONE probe — the caller-cwd-resolved candidate. A driver that
    // misses the path-carrying branch would walk the PATH instead
    // (/cq-tools/./bin/acp-server, /usr/bin/./bin/acp-server, ...).
    expect(seen).toEqual([resolve('./bin/acp-server')]);
    expect(resolved.binary).toBe(resolve('./bin/acp-server'));
    expect(resolved.command).toEqual([resolve('./bin/acp-server'), '--flag']);
    expect(resolved.source).toBe('explicit');
  });

  test('a bare name walks the PATH (the which contract) — past a miss, onto the hit; the two shapes stay distinct', async () => {
    const seen: string[] = [];
    // Only the SECOND PATH dir carries the binary: the walk must skip the
    // first entry (a miss) and land on the second.
    const probe: ExecutableProbe = async (candidate) => {
      seen.push(candidate);
      return candidate === join('/usr/bin', 'acp-server');
    };
    const resolved = await resolveAcpCommand(['acp-server'], 'explicit', defaultAcpEndpointTable(), env, probe);
    // The extensionless candidates must appear IN PATH ORDER — past the
    // miss, onto the hit — and the hit must win. Asserted as an ordered
    // SUBSEQUENCE of `seen`, not the whole array: on win32 the walk also
    // probes the PATHEXT extensions per dir (issue #40; this env carries
    // no PATHEXT, so DEFAULT_PATHEXT fires), so the full candidate list is
    // platform-shaped while the which-contract shape — PATH order, first
    // hit wins, extensionless resolution — is what binds here.
    const miss = seen.indexOf(join('/cq-tools', 'acp-server'));
    const hit = seen.indexOf(join('/usr/bin', 'acp-server'));
    expect(miss).toBeGreaterThanOrEqual(0);
    expect(hit).toBeGreaterThan(miss);
    expect(resolved.binary).toBe(join('/usr/bin', 'acp-server'));
  });

  test('carriesPathSeparator: the forward-slash form is path-carrying on EVERY platform (the Windows fix — sep is a backslash there, but Node accepts / too)', () => {
    expect(carriesPathSeparator('./bin/acp-server')).toBe(true);
    expect(carriesPathSeparator('bin/acp-server')).toBe(true);
    expect(carriesPathSeparator('/abs/acp-server')).toBe(true);
    expect(carriesPathSeparator('acp-server')).toBe(false);
    expect(carriesPathSeparator('')).toBe(false);
    // Platform note (Codex P2): on win32 the backslash forms are caught by
    // the same check via `sep`; this suite runs on ubuntu/macOS where sep
    // IS '/', so that half is inert here — correctness for the documented
    // Windows case, not locally observable behavior.
  });

  test('a RELATIVE PATH ENTRY resolves to absolute before probing (#46) — the result survives the later cwd switch to the workspace', async () => {
    const seen: string[] = [];
    const probe: ExecutableProbe = async (candidate) => {
      seen.push(candidate);
      return candidate === join(resolve('./tools'), 'acp-server');
    };
    const resolved = await resolveAcpCommand(['acp-server'], 'explicit', defaultAcpEndpointTable(), { PATH: './tools' }, probe);
    // The probe saw the ABSOLUTE candidate (caller-cwd-resolved), never
    // the raw './tools/acp-server' the old walk probed — a relative
    // resolution result would break the moment the spawn switched cwd to
    // the workspace.
    expect(seen).toEqual([join(resolve('./tools'), 'acp-server')]);
    expect(resolved.binary).toBe(join(resolve('./tools'), 'acp-server'));
  });

  // The kernel lane's pathCandidates (merge-queue, right of way) keys the
  // PATHEXT walk on the HOST platform — the win32 candidate order stays
  // suite-unobservable on POSIX exactly as issue #40 anticipated; the
  // walk's two-dir structure above pins the platform-neutral half.
});
