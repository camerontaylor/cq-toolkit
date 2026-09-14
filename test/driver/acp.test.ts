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
//      option fails the run naming the offered options), the never-asks
//      tripwire, served-model surfacing + the FAKE_ACP_SERVED_MODEL
//      mismatch demonstration (the observed-model check catches it —
//      the subprocess remap test's framing), usage mapping (fixed
//      numbers, NO reasoning field), the resume sidecar discipline,
//      cancel → 'aborted' over the governed signal, the mode-pin
//      observability, the protocol-version mismatch verdict, and the
//      prompt-directed-JSON drop rule.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { AcpDriver, ACP_SESSION_FILE, NARRATION_TOOL } from '../../src/driver/acp/index.js';
import { defaultAcpEndpointTable, AcpEndpointTableSchema } from '../../src/driver/acp/binaries.js';
import type { AcpDriverOptions } from '../../src/driver/acp/index.js';
import { spawnAcpProcess } from '../../src/driver/acp/process.js';
import type { AcpSpawnFn } from '../../src/driver/acp/process.js';
import { runDriverConformance } from './conformance.js';
import type { ConformanceSpec, ModelDirective } from './conformance.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER, CONFORMANCE_MODEL } from './conformance.js';
import { SessionStore } from '../../src/harness/session.js';
import { runLadder } from '../../src/kernel/governor.js';
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
      // {inputTokens:10, outputTokens:5, cachedReadTokens:2,
      // cachedWriteTokens:3} → the frozen fold (the step-2 correction:
      // cacheWrite FOLDS — the field exists on this wire).
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
      // thoughtTokens exists on the wire but its additivity is unproven —
      // reasoning is NEVER emitted (header; strategy §2.3).
      expect('reasoning' in result.usage).toBe(false);
      expect(result.costUSD).toBeUndefined(); // unpriced model — derived-only
      expect(result.costBasis).toBeUndefined();
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
