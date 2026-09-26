// The subprocess driver's REAL-PROCESS contracts (plan 003 F2): the fake
// agent CLI (test/fixtures/fake-agent-cli.mjs) as a real child. Every case
// here is an OS-level boundary the in-process persona (subprocess.test.ts)
// cannot model — see the classification table in
// docs/test-performance-notes.md:
//   - the signal ladder (SIGTERM ignored → SIGKILL; the default
//     disposition dying on SIGTERM) and the process-GROUP kill of a real
//     grandchild;
//   - real argv and sidecar files (--resume, --json-schema checked by the
//     CLI itself) and a real stream's usage and cost;
//   - spawnManaged's bounded stdout tail over real pipe chunks;
//   - the real child environment (the #183 env allowlist).
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { stripMetaSchema } from '../../src/driver/json-schema.js';
import { CLI_SESSION_FILE, SubprocessDriver } from '../../src/driver/subprocess/index.js';
import type { SpawnFn, SubprocessDriverOptions } from '../../src/driver/subprocess/index.js';
import { DEFAULT_MAX_RETAINED_BYTES, spawnManaged } from '../../src/driver/subprocess/process.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { realClock, runLadder } from '../../src/kernel/governor.js';
import {
  baseDriverOptions,
  conformanceRoutingTable,
  FAKE_CLI,
  invocation,
  jsonSchemaArgOf,
  narrationOf,
  personaEnv,
  probeEnvOf,
  withScratch,
} from './subprocess-harness.js';
import type { SpawnCall } from './subprocess-harness.js';
import { CONFORMANCE_PROVIDER, SESSIONS_DIR } from './conformance.js';

/**
 * A spawn override that records every call (argv/env evidence for the
 * resume assertions) and merges the fixture env over the driver's child env
 * before delegating to the REAL spawnManaged — the fixture is a real
 * process in a real workspace, only the MODEL is fake.
 */
function recordingSpawn(calls: SpawnCall[], extraEnv: Record<string, string> = {}): SpawnFn {
  return (opts) => {
    calls.push({ args: [...opts.args], env: { ...opts.env } });
    return spawnManaged({ ...opts, env: { ...opts.env, ...personaEnv(opts.args, extraEnv) } });
  };
}

/** Base driver options for the real-process contracts. */
function baseOptions(
  scratchDir: string,
  extraEnv: Record<string, string>,
  calls: SpawnCall[],
): SubprocessDriverOptions {
  return baseDriverOptions(scratchDir, recordingSpawn(calls, extraEnv));
}

describe('subprocess driver real-process contracts (fake agent CLI process)', () => {
  test('grace ladder: a SIGTERM-ignoring child escalates to SIGKILL — both rungs observed in order', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      let deadline: (() => void) | undefined;
      const deadlineHandle = Symbol('readiness-gated deadline');
      const spawn = recordingSpawn(calls, { FAKE_AGENT_MODE: 'ignore-sigterm' });
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, calls),
        spawn: (options) => {
          const child = spawn(options);
          onTestFinished(() => {
            child.kill('SIGKILL');
          });
          child.onStdoutLine((line) => {
            // Init is emitted only after the fixture installs its SIGTERM handler.
            if (line.includes('"subtype":"init"')) queueMicrotask(() => deadline?.());
          });
          return child;
        },
        termGraceMs: 200,
        killGraceMs: 200,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'stubborn run' })),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-ladder', attempt: 1 },
        {
          clock: {
            now: realClock.now,
            setTimeout: (fn, ms) => {
              if (deadline === undefined) {
                deadline = fn;
                return deadlineHandle;
              }
              return realClock.setTimeout(fn, ms);
            },
            clearTimeout: (handle) => {
              if (handle !== deadlineHandle) realClock.clearTimeout(handle);
            },
          },
        },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      // The driver's own ladder markers, recorded as session narration:
      // SIGTERM first (ignored by the fixture), then SIGKILL.
      const sessionId = outcome.value.sessionId as string;
      const narration = await narrationOf(store, sessionId);
      const rungs = narration
        .filter((line) => line.includes('"termination-rung"'))
        .map((line) => JSON.parse(line) as { rung: string });
      expect(rungs.map((r) => r.rung)).toEqual(['sigterm', 'sigkill']);
      const termination = narration.find((line) => line.includes('"termination"'));
      expect(termination !== undefined && termination.includes('"killed"')).toBe(true);
      // The child really was SIGKILLed: exactly one spawn, never completed.
      expect(calls).toHaveLength(1);
    });
  }, 20_000);

  test('graceful abort: a default-disposition child dies on SIGTERM — one rung, no SIGKILL', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver({
        ...baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'slow-exit-ms', FAKE_AGENT_SLOW_EXIT_MS: '10000' },
          [],
        ),
        termGraceMs: 200,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'slow run' })),
        // > node startup: the abort must land after the driver attached the
        // ladder (an abort before the spawn path returns the early-aborted
        // verdict with no narration)
        { wallClockMs: 300 },
        { op: 'subprocess', jobKey: 'subprocess-graceful', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      // error rides only stopReason 'error' (frozen WorkerResultSchema contract).
      expect(outcome.value.error).toBeUndefined();
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      const rungs = narration
        .filter((line) => line.includes('"termination-rung"'))
        .map((line) => JSON.parse(line) as { rung: string });
      expect(rungs.map((r) => r.rung)).toEqual(['sigterm']); // no SIGKILL rung
      const termination = narration.find((line) => line.includes('"termination"'));
      expect(termination !== undefined && termination.includes('"terminated"')).toBe(true);
    });
  }, 20_000);

  test('resume: the second run passes --resume; the sidecar lives in the STORE, not the workspace (#19-12/#26)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const first = new SubprocessDriver(baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls));
      const run1 = await first.run(invocation({ prompt: 'resume run one' }));
      expect(calls[0]?.args).not.toContain('--resume'); // fresh run: no resume flag
      // The sidecar is RELOCATED (issue #26, design (b)): beside the session
      // records, keyed by sessionId — never in the model-visible workspace.
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      const sidecarPath = join(
        scratchDir,
        SESSIONS_DIR,
        `${run1.sessionId as string}${CLI_SESSION_FILE}`,
      );
      const cliId = (await readFile(sidecarPath, 'utf8')).trim();
      expect(cliId).toMatch(/^fake-cli-/);
      // 0o600 — the sidecar is evidence like the records it sits beside,
      // never world-readable (review thread: mode was umask-default 0o666).
      expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
      const noSidecarInWorkspace = async (): Promise<void> => {
        const files = await readdir(workspace);
        expect(files.filter((f) => f.endsWith(CLI_SESSION_FILE))).toEqual([]);
      };
      await noSidecarInWorkspace();

      // The resumed run forwards the recorded CLI session id as --resume
      // (proven by the fixture echoing it) and reuses the SAME workspace.
      const calls2: SpawnCall[] = [];
      const second = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'resume-echo' }, calls2),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(
        invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }),
      );
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(run2.stopReason).toBe('complete');
      expect(calls2[0]?.args).toContain('--resume');
      const resumeIndex = calls2[0]?.args.indexOf('--resume') ?? -1;
      expect(calls2[0]?.args[resumeIndex + 1]).toBe(cliId);

      // ONE session record carries both runs' turns; the store sidecar is
      // stable, and the workspace still carries NO resume handle.
      const record = await store.load(run1.sessionId as string);
      expect(
        record?.messages.some((m) => m.role === 'user' && m.content === 'resume run one'),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'user' && m.content === 'resume run two'),
      ).toBe(true);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes(`resumed from cli session ${cliId}`),
        ),
      ).toBe(true);
      expect((await readFile(sidecarPath, 'utf8')).trim()).toBe(cliId);
      await noSidecarInWorkspace();
    });
    // Real CLI resume argv plus the sidecar filesystem contract; this budget
    // covers two child process startups, not an in-process decision.
  }, 15_000);

  test('structured output: --json-schema + the fixture structured_output land in the result', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const schema = z.object({ answer: z.string() }).strict();
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'structured-ok' }, calls),
        outputSchema: schema,
      });
      const result = await driver.run(invocation({ prompt: 'structured run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
      // The serialized --json-schema arg carries NO draft-2020-12 meta key —
      // the CLI rejects that URI before the model runs (#209).
      const arg = jsonSchemaArgOf(calls[0]?.args ?? []);
      expect(arg['$schema']).toBeUndefined();
      expect(arg).toEqual(stripMetaSchema(z.toJSONSchema(schema)));
    });
  });

  test('usage mapping: the fixed fixture numbers become the frozen Usage shape', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const result = await driver.run(invocation({ prompt: 'usage run' }));
      expect(result.stopReason).toBe('complete');
      // error rides only stopReason 'error' (frozen WorkerResultSchema contract).
      expect(result.error).toBeUndefined();
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
      expect(typeof result.sessionId).toBe('string');
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content === 'ok')).toBe(true);
    });
  });

  test('costUSD via the pricing override: derived from real usage; unpriced → absent', async () => {
    await withScratch(async (scratchDir) => {
      const priced = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, []),
        pricing: (modelSpec) =>
          modelSpec.provider === CONFORMANCE_PROVIDER
            ? { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }
            : undefined,
      });
      const result = await priced.run(invocation({ prompt: 'priced run' }));
      // (10 + 5) tokens at 2 USD per million (cache terms at 0) = 30 / 1e6.
      expect(result.costUSD).toBeDefined();
      expect(result.costUSD).toBeCloseTo(0.00003, 12);

      const unpriced = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const unknown = await unpriced.run(invocation({ prompt: 'unpriced run' }));
      expect(unknown.costUSD).toBeUndefined(); // derived-only: never fabricated
    });
  });

  test('abort kills the whole process GROUP: a fixture-spawned grandchild dies with the CLI (#19-9)', async () => {
    await withScratch(async (scratchDir) => {
      const pidFile = join(scratchDir, 'grandchild.pid');
      const calls: SpawnCall[] = [];
      // The binary template carries the fixture-only probe flag: the CLI
      // spawns a sleeping grandchild in ITS process group and records the
      // pid, then ignores SIGTERM (forcing the SIGKILL rung).
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ignore-sigterm' }, calls),
        binary: ['node', FAKE_CLI, '--spawn-grandchild', pidFile],
        termGraceMs: 200,
        killGraceMs: 200,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'group kill run' })),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-group', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');

      // The grandchild pid was recorded; after the group kill it is DEAD —
      // poll process.kill(pid, 0) until ESRCH. A direct-child-only kill
      // would leave the (non-detached, group-inheriting) grandchild running.
      const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      let dead = false;
      for (let i = 0; i < 200 && !dead; i++) {
        try {
          process.kill(grandchildPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          dead = true; // ESRCH — the process is gone
        }
      }
      expect(dead).toBe(true);
    });
    // Structural OS-signal-ladder budget: SIGTERM grace, then SIGKILL, then
    // descendant teardown are each subject to host-load swings beyond the
    // five-second process-death poll above.
  }, 20_000);

  test('stdout retention is a bounded TAIL: droppedBytes counted, every line still observed (#19-10)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 64 * 1024;
      const lines = 20_000;
      const last = `line-${String(lines - 1).padStart(8, '0')}`;
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `for (let i = 0; i < ${lines}; i++) process.stdout.write('line-' + String(i).padStart(8, '0') + '\\n');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      // The buffer is evidence HYGIENE: past the cap only the tail is kept…
      expect(close.droppedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.stdout.endsWith(`${last}\n`)).toBe(true); // …the END of the stream
      // …while the line callbacks saw EVERY line.
      expect(seen).toHaveLength(lines);
      expect(seen[0]).toBe('line-00000000');
      expect(seen[lines - 1]).toBe(last);
      // The shipped default.
      expect(DEFAULT_MAX_RETAINED_BYTES).toBe(1_048_576);
    });
  });

  test('a single unterminated line ~3x the cap stays bounded: head dropped, tail emitted (review 3)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 16 * 1024;
      const tailMark = 'TAIL-MARKER';
      // ONE line of exactly 3× cap with NO trailing newline — the shape the
      // review flagged: the pending line used to grow `rest` unbounded.
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write('${'x'.repeat(3 * cap - tailMark.length - 1)}' + '-${tailMark}');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      // The memory bound is ABSOLUTE: after each chunk, BOTH buffers (the
      // retained tail and the pending line) are ≤ cap — at close only the
      // tail remains, ≤ cap, so total retained never approaches 3× cap.
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.droppedBytes).toBeGreaterThan(0); // the head was really dropped
      // The flushed pending line is its retained TAIL, not the dropped head.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.endsWith(`-${tailMark}`)).toBe(true);
      expect(seen[0]?.startsWith('x')).toBe(true); // the kept bytes are the line's own tail
    });
  }, 20_000);

  test('an unterminated final line is retained EXACTLY once — flush adds no phantom drops (review 4)', async () => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write('complete line\\n'); process.stdout.write('final-fragment');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: 64 * 1024,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      expect(seen).toEqual(['complete line', 'final-fragment']);
      // Nothing exceeded the cap → zero REAL drops; the old flush re-appended
      // the pending line to the already-retained text (double retention and,
      // past a cap, phantom droppedBytes).
      expect(close.droppedBytes).toBe(0);
      expect(close.stdout).toBe('complete line\nfinal-fragment');
      expect(close.stdout.split('final-fragment')).toHaveLength(2); // exactly one occurrence
    });
  }, 20_000);

  test('astral characters past the cap: byte-exact trim, no lone surrogate at the head (review 9-1)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 64 * 1024;
      // The whole stream is one giant unterminated line of emoji (4 UTF-8
      // bytes each) — the tail region is FULL of astral pairs, the exact
      // shape where a code-unit trim mis-measured 3+3 instead of 4 bytes
      // per pair, under-counted, and let the retained text exceed the cap.
      const child = spawnManaged({
        command: process.execPath,
        args: ['-e', `process.stdout.write('🦄'.repeat(40_000));`],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const close = await child.close;
      // The documented absolute bound holds BYTE-exactly.
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.droppedBytes).toBeGreaterThan(0);
      // The retained head starts with a COMPLETE code point — a code-unit
      // cut between the halves of a pair would strand a lone surrogate.
      expect(close.stdout.codePointAt(0)).toBe(0x1f984); // 🦄
    });
  }, 20_000);

  // -------------------------------------------------------------------------
  // Child env is default-deny (issue #183)
  // -------------------------------------------------------------------------

  test('a REAL spawned worker cannot see a marker secret in the entry env, while route env still reaches it; envAllowlist opts a name back in (#183)', async () => {
    await withScratch(async (scratchDir, store) => {
      // A probe worker: dumps its OWN process.env as a narration line (the
      // driver folds non-JSON lines into the session record) and then emits
      // the minimal stream-json run so the invocation completes.
      const probePath = join(scratchDir, 'env-probe.mjs');
      await writeFile(
        probePath,
        [
          'const env = { ...process.env };',
          "process.stdout.write('CQ_ENV_PROBE:' + JSON.stringify(env) + '\\n');",
          "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'env-probe', model: 'conformance-1' }) + '\\n');",
          "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'env-probe', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: 'conformance-1' }) + '\\n');",
        ].join('\n'),
        'utf8',
      );
      const marker = 'cq-env-leak-marker-7f3a';
      const savedMarker = process.env.CQ_ENV_LEAK_MARKER;
      const savedGh = process.env.GH_TOKEN;
      // GLOBAL process.env mutation, deliberately: the real spawnManaged path
      // reads the LIVE parent env, so withholding can only be proven against
      // it. Restored in finally; this file's tests run sequentially (no
      // vitest .concurrent), so no concurrent test observes the markers.
      process.env.CQ_ENV_LEAK_MARKER = marker;
      process.env.GH_TOKEN = 'ghp_marker_secret';
      const probeOptions: SubprocessDriverOptions = {
        binary: ['node', probePath],
        routingTable: conformanceRoutingTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: {
          ...defaultHarnessConfig,
          workspaceRoot: join(scratchDir, 'workspaces'),
        },
      };
      try {
        // NO spawn override: this is the production spawnManaged path.
        const denied = await new SubprocessDriver(probeOptions).run(
          invocation({ prompt: 'env probe run' }),
        );
        expect(denied.stopReason).toBe('complete');
        const deniedEnv = probeEnvOf(await narrationOf(store, denied.sessionId as string));
        // The marker secret never reaches the worker…
        expect(deniedEnv['CQ_ENV_LEAK_MARKER']).toBeUndefined();
        expect(deniedEnv['GH_TOKEN']).toBeUndefined();
        expect(JSON.stringify(deniedEnv)).not.toContain(marker);
        // …while terminal basics and the configured route env do. Derive the
        // expected values from the live env so an ambient CONFORMANCE_* var
        // cannot flip this test (r2).
        const expectedKey = process.env.CONFORMANCE_API_KEY as string;
        const expectedBaseUrl = process.env.CONFORMANCE_BASE_URL ?? 'http://127.0.0.1:1/anthropic';
        expect(typeof deniedEnv['PATH']).toBe('string');
        expect(deniedEnv['ANTHROPIC_BASE_URL']).toBe(expectedBaseUrl);
        expect(deniedEnv['ANTHROPIC_API_KEY']).toBe(expectedKey);
        expect(deniedEnv['ANTHROPIC_AUTH_TOKEN']).toBe(expectedKey);

        // The documented escape hatch is real end-to-end (r1): naming the
        // marker in envAllowlist copies ONLY that parent name back in.
        const allowed = await new SubprocessDriver({
          ...probeOptions,
          envAllowlist: ['CQ_ENV_LEAK_MARKER'],
        }).run(invocation({ prompt: 'allowlist probe run' }));
        expect(allowed.stopReason).toBe('complete');
        const allowedEnv = probeEnvOf(await narrationOf(store, allowed.sessionId as string));
        expect(allowedEnv['CQ_ENV_LEAK_MARKER']).toBe(marker);
        expect(allowedEnv['GH_TOKEN']).toBeUndefined(); // only the named extra is added

        // The per-instance list is a FROZEN COPY (r2): mutating the caller's
        // array after construction cannot weaken later spawns.
        const mutableAllowlist = ['CQ_ENV_LEAK_MARKER'];
        const frozenDriver = new SubprocessDriver({
          ...probeOptions,
          envAllowlist: mutableAllowlist,
        });
        mutableAllowlist.push('GH_TOKEN');
        const frozen = await frozenDriver.run(invocation({ prompt: 'frozen allowlist probe run' }));
        const frozenEnv = probeEnvOf(await narrationOf(store, frozen.sessionId as string));
        expect(frozenEnv['CQ_ENV_LEAK_MARKER']).toBe(marker);
        expect(frozenEnv['GH_TOKEN']).toBeUndefined(); // pushed AFTER construction — not honored
      } finally {
        if (savedMarker === undefined) delete process.env.CQ_ENV_LEAK_MARKER;
        else process.env.CQ_ENV_LEAK_MARKER = savedMarker;
        if (savedGh === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = savedGh;
      }
    });
  }, 20_000);
});
