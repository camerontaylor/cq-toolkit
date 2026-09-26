// The subprocess driver instantiation — T1.5 slice 2.
//
// Two layers, mirroring test/driver/ai-sdk.test.ts:
//   1. THE CONFORMANCE SUITE (test/driver/conformance.ts, verbatim) run
//      against the real SubprocessDriver spawning a FAKE agent CLI
//      (test/fixtures/fake-agent-cli.mjs) through the driver's `spawn`
//      override — no real `claude` binary, no network, no vendor SDK. The
//      suite's ModelDirective maps onto FAKE_AGENT_* env vars for the
//      fixture; the fixture's scripted tool_use is EXECUTED FOR REAL
//      against the invocation workspace (read/run/edit with harness-
//      matching denial reasons), which is what makes the I6 isolation pair
//      observable through a genuine filesystem.
//   2. DRIVER-SPECIFIC tests: THE REMAP TEST (an unknown model name on the
//      default routing table throws BEFORE any spawn — the spawn-hook
//      counter stays at zero), the SIGTERM→SIGKILL grace ladder (both rungs
//      observed in order against a real stubborn child), the graceful
//      single-rung abort, junk-line tolerance, --resume argv + sidecar
//      continuation, denial/structured/usage/cost mapping, and the
//      budget-usage + unknown-model-mode error paths.
//
// All runs ride the conformance routing table (a 'conformance' +
// 'conformance-priced' endpoint extension of the default table) so no test
// needs a real provider key; the remap test alone uses the DEFAULT table to
// pin the DeepSeek footgun to the shipped config.
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import {
  SubprocessDriver,
  buildArgs,
  stopReasonOf,
  usageFromCli,
} from '../../src/driver/subprocess/index.js';
import type { SpawnFn, SubprocessDriverOptions } from '../../src/driver/subprocess/index.js';
import { fakeManagedSpawn, runFakeTool } from '../helpers/transport-fakes.js';
import type { JsonLineFrame, JsonLinePeer } from '../helpers/transport-fakes.js';
import { defaultRoutingTable, routeFor } from '../../src/driver/subprocess/routing.js';
import { DEFAULT_CHILD_ENV_ALLOWLIST, buildChildEnv } from '../../src/driver/subprocess/process.js';
import { agentPersonaSpawn } from '../helpers/persona-spawn.js';
import {
  baseDriverOptions,
  FAKE_CLI,
  invocation,
  narrationOf,
  personaEnv,
  withScratch,
} from './subprocess-harness.js';
import type { SpawnCall } from './subprocess-harness.js';
import { runDriverConformance } from './conformance.js';
import type { ConformanceSpec, ModelDirective } from './conformance.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER, CONFORMANCE_MODEL } from './conformance.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { Driver } from '../../src/driver/types.js';

/**
 * The in-process spawn override: records every call (argv/env evidence for
 * the resume and zero-spawn assertions) and runs the fake agent CLI's
 * persona over the transport fake with `extraEnv` merged over the driver's
 * child env — a real workspace, no child process.
 */
function recordingSpawn(calls: SpawnCall[], extraEnv: Record<string, string> = {}): SpawnFn {
  return (opts) => {
    calls.push({ args: [...opts.args], env: { ...opts.env } });
    return agentPersonaSpawn(personaEnv(opts.args, extraEnv))(opts);
  };
}

/** Base driver options for the in-process tests (the persona behind the spawn override). */
function baseOptions(
  scratchDir: string,
  extraEnv: Record<string, string>,
  calls: SpawnCall[],
): SubprocessDriverOptions {
  return baseDriverOptions(scratchDir, recordingSpawn(calls, extraEnv));
}

let fakeManagedSessionCounter = 0;

function fakeManagedScript(
  opts: { cwd: string; args: readonly string[] },
  directive: ModelDirective | undefined,
  hasOutputSchema: boolean,
): (frame: JsonLineFrame, peer: JsonLinePeer) => void {
  const modelIndex = opts.args.indexOf('--model');
  const model =
    modelIndex === -1 ? 'conformance-1' : (opts.args[modelIndex + 1] ?? 'conformance-1');
  const allowedIndex = opts.args.indexOf('--allowedTools');
  const allowed = new Set(
    allowedIndex === -1 ? [] : (opts.args[allowedIndex + 1] ?? '').split(' ').filter(Boolean),
  );
  const sessionId = `fake-cli-${fakeManagedSessionCounter++}`;
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 3,
  };
  return (frame, peer) => {
    if (frame['method'] !== 'stdin') return;
    if (directive?.kind === 'block-until-abort') return;
    if (directive?.kind === 'fail') {
      peer.stderr('simulated hard failure');
      peer.finish(1);
      return;
    }
    peer.send({ type: 'system', subtype: 'init', session_id: sessionId, model });
    if (directive?.kind === 'tool-then-reply' && allowed.has(directive.tool)) {
      peer.send({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'fake-tool', name: directive.tool, input: directive.input },
          ],
        },
      });
      void runFakeTool(opts.cwd, directive.tool, directive.input)
        .then((outcome) => {
          peer.send({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'fake-tool',
                  is_error: !outcome.ok,
                  content: outcome.text,
                },
              ],
            },
          });
          peer.send({
            type: 'assistant',
            message: { content: [{ type: 'text', text: directive.reply }] },
          });
          peer.send({
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: sessionId,
            model,
            usage,
            ...(hasOutputSchema ? { structured_output: { answer: 'ok' } } : {}),
          });
          peer.finish();
        })
        .catch((error: unknown) => {
          peer.stderr(`fake tool error: ${String(error)}`);
          peer.finish(1);
        });
      return;
    }
    const text = directive?.kind === 'reply' ? directive.text : 'ok';
    peer.send({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    peer.send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      model,
      usage,
      ...(hasOutputSchema ? { structured_output: { answer: 'ok' } } : {}),
    });
    peer.finish();
  };
}

/** Fresh mock-backed SubprocessDriver honoring the ConformanceSpec contract. */
function makeDriver(spec: ConformanceSpec): Driver {
  return new SubprocessDriver({
    ...baseOptions(spec.scratchDir, {}, []),
    spawn: fakeManagedSpawn((opts) =>
      fakeManagedScript(opts, spec.directive, spec.outputSchema !== undefined),
    ),
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
// 1. The conformance suite, fake-CLI-backed
// ---------------------------------------------------------------------------

runDriverConformance(makeDriver, { label: 'subprocess driver (fake agent CLI)' });

// ---------------------------------------------------------------------------
// 2. Driver-specific tests
// ---------------------------------------------------------------------------

describe('subprocess driver specifics (fake agent CLI)', () => {
  test('routeFor rejects prototype keys — constructor/toString are not providers (mirror of the claude-agent guard)', () => {
    expect(() =>
      routeFor({ provider: 'constructor', model: 'deepseek-chat' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'constructor'/);
    expect(() =>
      routeFor({ provider: 'toString', model: 'deepseek-chat' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'toString'/);
  });

  test('buildArgs: the exact headless argv — undocumented flags removed (#19-8)', () => {
    const route = {
      endpoint: 'conformance',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      env: {
        ANTHROPIC_AUTH_TOKEN: 'CONFORMANCE_API_KEY',
        ANTHROPIC_API_KEY: 'CONFORMANCE_API_KEY',
      },
      model: 'conformance-1',
    };
    const args = buildArgs({
      route,
      allowedToolNames: ['read', 'edit'],
      outputJsonSchema: '{"type":"object"}',
      resumeCliSessionId: 'cli-9',
    });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose', // the real CLI refuses stream-json print mode without it (found live, T1.6)
      '--json-schema',
      '{"type":"object"}',
      '--allowedTools',
      'read edit',
      '--model',
      'conformance-1',
      '--resume',
      'cli-9',
    ]);
    // ToolPolicy mode 'none' shape: --allowedTools ALWAYS present with an
    // EMPTY value (nothing pre-approved; headless -p cannot prompt, so a
    // tool outside the list is CLI-DENIED — the WorkerResult.denials source).
    const none = buildArgs({
      route,
      allowedToolNames: [],
      outputJsonSchema: undefined,
      resumeCliSessionId: undefined,
    });
    expect(none).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      '',
      '--model',
      'conformance-1',
    ]);
    expect(none).not.toContain('--permission-prompts'); // undocumented — removed (issue #19)
    expect(none).not.toContain('--bare'); // undocumented — removed (issue #19)
  });

  test('THE REMAP TEST: unknown model on the default routing table throws BEFORE any spawn', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      // DEFAULT table — the shipped deepseek endpoint config, no overrides.
      const driver = new SubprocessDriver({
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: { ...defaultHarnessConfig, workspaceRoot: join(scratchDir, 'workspaces') },
        spawn: recordingSpawn(calls),
      });
      // DeepSeek-style gateways silently serve their default model for ANY
      // model name; the driver refuses to dispatch an unknown name instead.
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'deepseek', model: 'gpt-9-imaginary' } })),
      ).rejects.toThrow(
        /not on the deepseek allowlist .* silently remap unknown model names; refusing to dispatch/,
      );
      // The same rule is table-wide: unknown names on ANY endpoint refuse.
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'zai', model: 'gpt-9-imaginary' } })),
      ).rejects.toThrow(/silently remap unknown model names; refusing to dispatch/);
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'nope', model: 'whatever' } })),
      ).rejects.toThrow(/unknown provider 'nope'/);
      // Pre-dispatch means PRE-dispatch: zero spawns — the sessions dir is
      // never even created (store.create would have mkdir'd it).
      expect(calls).toEqual([]);
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // The routeFor throw is only the OUTER guard; a gateway can still remap
      // an ALLOWED name server-side. The driver therefore surfaces the model
      // the endpoint actually served — the fact the shared conformance suite's
      // observed-model check (leg m) keys on — and a remapped run fails that
      // check loudly.
      const remapping = new SubprocessDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_SERVED_MODEL: 'actually-served-model' },
          [],
        ),
      );
      const remapped = await remapping.run(
        invocation({ modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL } }),
      );
      expect(remapped.model).toBe('actually-served-model'); // the honest observation
      expect(remapped.model).not.toBe(CONFORMANCE_MODEL); // the suite's leg m fails this run loudly
    });
  });

  test('junk lines are narration, never a crash: the result event still parses', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'emit-junk' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'junky run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
      const record = await store.load(result.sessionId as string);
      const narration = record?.messages.find(
        (m) => m.role === 'tool' && m.toolName === 'cli-narration',
      );
      expect(narration?.content).toContain('transient bootstrapping noise');
      // The non-contract system event is narration too — unknown subtypes
      // never crash the fold.
      expect(narration?.content).toContain('worthless non-contract event');
    });
  });

  test('deny-tool: the CLI tool_result denial maps to the frozen {tool, reason} shape', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'deny-tool' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'denial run' }));
      expect(result.denials).toEqual([
        { tool: 'edit', reason: 'permission denied: edit is not allowed' },
      ]);
      // result.is_error:true → an error verdict even though the stream closed cleanly.
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
    });
  });

  test('result-event error path: the error verdict names the result cause and stays bounded (#208)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'deny-tool' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'result error run' }));
      expect(result.stopReason).toBe('error');
      const error = result.error;
      if (error === undefined) throw new Error('an error verdict must carry a cause (#208)');
      // The failed result frame (is_error:true, subtype error_during_execution)
      // is what the journal must show — not a bare "no cause".
      expect(error).toContain('result event error');
      expect(error).toContain('error_during_execution');
      // boundedErrorText contract: ≤500 chars, or the truncation marker.
      expect(/… \[truncated\]$/.test(error) || error.length <= 513).toBe(true);
    });
  });

  test('result-event cause precedence: result string wins over errors over subtype (#208)', async () => {
    await withScratch(async (scratchDir) => {
      const resultString = await new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'error-result' }, []),
      ).run(invocation({ prompt: 'result-string run' }));
      // The `result` string outranks the `errors` entries and the subtype.
      expect(resultString.error).toContain('result-string-cause');
      expect(resultString.error).not.toContain('errors-entry-cause');

      const errorsOnly = await new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'error-errors' }, []),
      ).run(invocation({ prompt: 'errors run' }));
      // No `result` string → the joined `errors` entries are the cause.
      expect(errorsOnly.error).toContain('errors-entry-cause');
      expect(errorsOnly.error).not.toContain('error_during_execution');
    });
  });

  test('structured output: a schema-violating payload is dropped to narration, never trusted', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture emits the raw payload verbatim (a lying CLI — no fixture
      // schema checking), so the driver's own settle-time validation is what
      // stands between the vendor field and the seam.
      const driver = new SubprocessDriver({
        ...baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'structured-ok', FAKE_AGENT_STRUCTURED_RAW: '{"answer":42}' },
          [],
        ),
        outputSchema: z.object({ answer: z.string() }).strict(),
      });
      const result = await driver.run(invocation({ prompt: 'lying CLI run' }));
      // The run itself succeeded; only the unrepresentable payload is gone.
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      // The rejection is evidence, not silence: a plain-JSON narration
      // marker carrying the zod issue count and paths.
      const narration = await narrationOf(store, result.sessionId as string);
      const rejected = narration.find((line) => line.includes('"structured-output-rejected"'));
      expect(rejected !== undefined && rejected.includes('"issues":1')).toBe(true);
      expect(rejected !== undefined && rejected.includes('"paths":["answer"]')).toBe(true);
    });
  });

  test('budget: maxTokens trips on the folded result usage (pre-verdict check only)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'budget-usage' }, []),
      );
      const result = await driver.run(
        invocation({ prompt: 'budget run', budget: { maxTokens: 1000 } }),
      );
      expect(result.stopReason).toBe('budget');
      // error rides only stopReason 'error' (frozen WorkerResultSchema contract).
      expect(result.error).toBeUndefined();
      expect(result.usage.input).toBe(120_000);
    });
  });

  test('unknown-model mode: a nonzero CLI exit with no result event is an honest error verdict', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'unknown-model' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'doomed run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.costUSD).toBeUndefined(); // no cost claim without a measurement
      // #208: the verdict POPULATES WorkerResult.error — the nonzero exit code
      // plus the CLI's stderr text — instead of an unexplained "no cause".
      const error = result.error;
      if (error === undefined) throw new Error('an error verdict must carry a cause (#208)');
      expect(error).toMatch(/exited with code 1/);
      expect(error).toContain('fake-agent-cli');
      expect(error).toContain('not served by this endpoint');
    });
  });

  test('error-cause text is bounded and never echoes an environment secret (#208)', async () => {
    const secret = 'cq-test-secret-value-9f3a';
    process.env.CQ_TEST_API_KEY = secret;
    onTestFinished(() => {
      delete process.env.CQ_TEST_API_KEY;
    });
    await withScratch(async (scratchDir) => {
      // POSITIVE redaction + bound exercise: a spawn failure whose message
      // carries the secret value and overshoots the 500-char bound, so the
      // persisted cause must contain the redaction marker AND the truncation
      // marker (the shared boundedErrorText contract).
      const throwingSpawn: SpawnFn = () => {
        throw new Error(`spawn blew up with ${secret}: ${'x'.repeat(600)}`);
      };
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, []),
        spawn: throwingSpawn,
      });
      const result = await driver.run(invocation({ prompt: 'secret run' }));
      const error = result.error;
      if (error === undefined) throw new Error('an error verdict must carry a cause (#208)');
      expect(error).not.toContain(secret);
      expect(error).toContain('[redacted]');
      expect(error.length).toBeLessThanOrEqual(513);
      expect(error.endsWith('… [truncated]')).toBe(true);
    });
  });

  test('a signal death with no result event names the signal in error (#208)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'self-kill' }, []),
      );
      // NOT a governed run: no governor signal fires, so this cannot settle
      // 'aborted' — the child dies by its own real SIGKILL and the error
      // cause must name the signal.
      const result = await driver.run(invocation({ prompt: 'signal run' }));
      expect(result.stopReason).toBe('error');
      const error = result.error;
      if (error === undefined) throw new Error('an error verdict must carry a cause (#208)');
      expect(error).toContain('killed by signal');
      expect(error).toContain('SIGKILL');
    });
  });

  test('echo-workspace: the fixture executes a real read in the resumed workspace', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const first = new SubprocessDriver(baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls));
      const run1 = await first.run(invocation({ prompt: 'seed run' }));
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      await writeFile(join(workspace, 'note.txt'), 'hello note', 'utf8');

      const second = new SubprocessDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'echo-workspace', FAKE_AGENT_PATH: 'note.txt' },
          [],
        ),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(invocation({ prompt: 'echo run', sessionRef: run1.sessionId }));
      expect(run2.stopReason).toBe('complete');
      expect(run2.denials).toEqual([]); // the file is really there
      const record = await store.load(run1.sessionId as string);
      const toolMessage = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'read');
      expect(toolMessage === undefined).toBe(false);
      const folded = JSON.parse((toolMessage?.content ?? '{}') as string) as {
        input: { path: string };
        ok: boolean;
        output: string;
      };
      expect(folded.input.path).toBe('note.txt');
      expect(folded.ok).toBe(true);
      expect(folded.output).toBe('hello note');
    });
  });

  // -------------------------------------------------------------------------

  test('served-model pricing + mismatch marker: the price lookup gets the SERVED id (#19-1/#24, #19-2)', async () => {
    await withScratch(async (scratchDir, store) => {
      const pricedKeys: Array<{ provider: string; model: string }> = [];
      const driver = new SubprocessDriver({
        ...baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_SERVED_MODEL: 'actually-served-model' },
          [],
        ),
        pricing: (modelSpec) => {
          pricedKeys.push({ provider: modelSpec.provider, model: modelSpec.model });
          return { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 };
        },
      });
      const result = await driver.run(invocation({ prompt: 'served pricing run' }));
      // WorkerResult.model keeps the observed served id…
      expect(result.model).toBe('actually-served-model');
      // …and the price lookup was keyed on the SERVED id with the REQUESTED
      // provider (pricing the requested id would attribute the wrong rates).
      expect(pricedKeys).toEqual([
        { provider: CONFORMANCE_PROVIDER, model: 'actually-served-model' },
      ]);
      // usage {10,5,2,3} at 2/2 per million (cache terms 0) = 30 / 1e6.
      expect(result.costUSD).toBeCloseTo(0.00003, 12);
      // The mismatch is OBSERVABLE, not silent (issue #19): a narration
      // marker naming requested and served, persisted via the diagnostics
      // path (the conformance suite fails this run loudly; production records it).
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"served-model-mismatch"'));
      expect(marker).toBeDefined();
      expect(marker).toContain('"requested":"conformance-1"');
      expect(marker).toContain('"served":"actually-served-model"');
    });
  });

  test('CLI token fields must be finite non-negative integers: lying fields fold to 0 (#19-3)', () => {
    expect(
      usageFromCli({
        input_tokens: -200_000,
        output_tokens: 150_000,
        cache_read_input_tokens: -3,
        cache_creation_input_tokens: 2.5,
      }),
    ).toEqual({ input: 0, output: 150_000, cacheRead: 0, cacheWrite: 0 });
    // The bypass is closed: the OLD fold read -50,000 total (negative
    // input masking real spend), which could never trip `>= maxTokens`;
    // the tightened fold counts the real magnitude.
    const lying = usageFromCli({ input_tokens: -200_000, output_tokens: 150_000 });
    expect(lying).toBeDefined();
    if (lying === undefined) return;
    expect(
      stopReasonOf({ aborted: false, maxTokens: 1000, usage: lying, resultStatus: 'success' }),
    ).toBe('budget');
  });

  test('binary validation: an empty template throws at construction, never at spawn (#19-4)', () => {
    expect(() => new SubprocessDriver({ binary: [] })).toThrow(
      /non-empty string or a non-empty array of non-empty strings/,
    );
    expect(() => new SubprocessDriver({ binary: ['node', ''] })).toThrow(
      /non-empty string or a non-empty array of non-empty strings/,
    );
    expect(() => new SubprocessDriver({ binary: '' })).toThrow(/non-empty string/);
    // The valid forms still construct.
    expect(() => new SubprocessDriver({ binary: 'claude' })).not.toThrow();
    expect(() => new SubprocessDriver({ binary: ['node', FAKE_CLI] })).not.toThrow();
  });

  test('a SYNCHRONOUS spawn failure is an error verdict, not a rejection (#19-5)', async () => {
    await withScratch(async (scratchDir, store) => {
      const throwingSpawn: SpawnFn = () => {
        throw new TypeError('spawn args must be strings');
      };
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, []),
        spawn: throwingSpawn,
      });
      // The run RESOLVES with an honest error verdict — the spawn throw is
      // contained behind the frozen seam.
      const result = await driver.run(invocation({ prompt: 'boom run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.costUSD).toBeUndefined(); // nothing was measured — no cost claim
      // #208: the spawn cause reaches WorkerResult.error too, not just narration.
      expect(result.error).toContain('spawn failed');
      expect(result.error).toContain('spawn args must be strings');
      // The failure is narrated best-effort (same swallow rule as persistence).
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"spawn-failed"'));
      expect(marker).toBeDefined();
      expect(marker).toContain('spawn args must be strings');
    });
  });

  test('grace validation: negative/NaN/Infinity/fractional graces throw at construction (#19-6)', () => {
    expect(() => new SubprocessDriver({ termGraceMs: -1 })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new SubprocessDriver({ termGraceMs: Number.NaN })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new SubprocessDriver({ termGraceMs: Number.POSITIVE_INFINITY })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new SubprocessDriver({ termGraceMs: 0.5 })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new SubprocessDriver({ killGraceMs: -5 })).toThrow(
      /killGraceMs must be an integer >= 0/,
    );
    // Zero and positive integers are legitimate.
    expect(() => new SubprocessDriver({ killGraceMs: 0 })).not.toThrow();
    expect(() => new SubprocessDriver({ termGraceMs: 100, killGraceMs: 200 })).not.toThrow();
  });

  test('sandbox-level-unenforced marker: a requested level is recorded as unenforced (#19-7)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      // The default invocation requests workspace-write — the marker must
      // record that THIS driver does not enforce it (trust statement, header).
      const result = await driver.run(invocation({ prompt: 'sandbox marker run' }));
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"sandbox-level-unenforced"'));
      expect(marker).toBeDefined();
      expect(marker).toContain('"level":"workspace-write"');

      // level 'none' asks for nothing extra → no marker…
      const noneDriver = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const noneResult = await noneDriver.run(
        invocation({ prompt: 'no sandbox run', sandboxPolicy: { level: 'none' } }),
      );
      const noneNarration = await narrationOf(store, noneResult.sessionId as string);
      expect(noneNarration.some((line) => line.includes('"sandbox-level-unenforced"'))).toBe(false);
      // …and a level over an EMPTY tool surface (mode 'none': nothing
      // pre-approved, headless-denied) has nothing unenforced to observe —
      // no marker (the conformance contract also pins such records to zero
      // tool-role messages).
      const emptySurface = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const emptyResult = await emptySurface.run(
        invocation({ prompt: 'empty surface run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      const emptyNarration = await narrationOf(store, emptyResult.sessionId as string);
      expect(emptyNarration.some((line) => line.includes('"sandbox-level-unenforced"'))).toBe(
        false,
      );
    });
  });

  test('buildChildEnv: CQ_RUN_ENV_PASSTHROUGH copies only validated, configured names', () => {
    const parent = { FOO: 'foo', BAR: 'bar', MISSING: undefined, GH_TOKEN: 'must-not-copy' };
    const child = buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'FOO BAR,MISSING' });
    expect(child['FOO']).toBe('foo');
    expect(child['BAR']).toBe('bar');
    expect(child['MISSING']).toBeUndefined();
    expect(child['GH_TOKEN']).toBeUndefined();
    expect(() => buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'A=1' })).toThrow(
      /CQ_RUN_ENV_PASSTHROUGH entries must be env var names matching/,
    );
    expect(() => buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'BAD.NAME' })).toThrow(
      /CQ_RUN_ENV_PASSTHROUGH entries must be env var names matching/,
    );
  });

  test('buildChildEnv: allowlisted basics + explicit route values pass, credential-shaped parent names are withheld (#183)', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/worker',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      PWD: '/parent/dir',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      HTTPS_PROXY: 'http://proxy.example:8080',
      https_proxy: 'http://proxy.example:8080',
      GH_TOKEN: 'ghp_marker_secret',
      CQ_ENV_LEAK_MARKER: 'do-not-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-marker',
      NPM_TOKEN: 'npm-marker',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_OPTIONS: '--require=/tmp/evil.cjs',
      NODE_PATH: '/tmp/evil-modules',
    };
    const child = buildChildEnv(parent, { ANTHROPIC_API_KEY: 'route-key-value' });
    // Allowlisted basics are inherited…
    expect(child['PATH']).toBe('/usr/bin');
    expect(child['HOME']).toBe('/home/worker');
    expect(child['TERM']).toBe('xterm-256color');
    expect(child['LANG']).toBe('en_US.UTF-8');
    // …including network-egress/TLS config a routed CLI needs (r1)…
    expect(child['NODE_EXTRA_CA_CERTS']).toBe('/etc/ssl/corp.pem');
    expect(child['HTTPS_PROXY']).toBe('http://proxy.example:8080');
    // …both proxy spellings: curl ignores uppercase HTTP_PROXY and honors
    // only lowercase (r2).
    expect(child['https_proxy']).toBe('http://proxy.example:8080');
    // …the explicit route value passes (it is composed deliberately, so the
    // allowlist must never filter it)…
    expect(child['ANTHROPIC_API_KEY']).toBe('route-key-value');
    // …and every credential-shaped parent name is withheld.
    expect(child['GH_TOKEN']).toBeUndefined();
    expect(child['CQ_ENV_LEAK_MARKER']).toBeUndefined();
    expect(child['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child['NPM_TOKEN']).toBeUndefined();
    expect(child['SSH_AUTH_SOCK']).toBeUndefined();
    expect(child['NODE_OPTIONS']).toBeUndefined(); // code-execution vector, deliberately excluded
    expect(child['NODE_PATH']).toBeUndefined(); // module-resolution vector
    // PWD is NOT inherited: spawn does not rewrite it for cwd, so a copied
    // PWD would be the parent's stale directory (CodeRabbit r1).
    expect(child['PWD']).toBeUndefined();
    // The override layer ALWAYS wins over a copied allowlist value (r1).
    expect(buildChildEnv(parent, { PATH: '/route/bin' })['PATH']).toBe('/route/bin');
    // The shipped allowlist itself must not carry credential-shaped names —
    // an explicit deny-set (the regex alone misses AWS_PROFILE,
    // GOOGLE_APPLICATION_CREDENTIALS, SSH_AUTH_SOCK, …) plus a shape guard.
    for (const name of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'SSH_AUTH_SOCK',
      'KRB5CCNAME',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'ZAI_API_KEY',
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
    ]) {
      expect(DEFAULT_CHILD_ENV_ALLOWLIST).not.toContain(name);
    }
    expect(
      DEFAULT_CHILD_ENV_ALLOWLIST.some((name) => /TOKEN|SECRET|KEY|PASSWORD/i.test(name)),
    ).toBe(false);
    // FROZEN (r1): an in-process push cannot weaken default-deny for later spawns.
    expect(Object.isFrozen(DEFAULT_CHILD_ENV_ALLOWLIST)).toBe(true);
    // The explicit extra allowlist is the only route for a non-default name.
    const extended = buildChildEnv(parent, undefined, ['CQ_ENV_LEAK_MARKER']);
    expect(extended['CQ_ENV_LEAK_MARKER']).toBe('do-not-leak');
    expect(extended['GH_TOKEN']).toBeUndefined();
    // A malformed extra name is rejected at the seam, not silently no-oped (r1/r2).
    expect(() => buildChildEnv(parent, undefined, [''])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => buildChildEnv(parent, undefined, ['A=B'])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => buildChildEnv(parent, undefined, ['BAD NAME'])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    // A null-prototype child carries a `__proto__` override as an OWN property
    // instead of silently dropping it through the inherited setter (r2).
    const protoOverride = Object.create(null) as Record<string, string>;
    protoOverride['__proto__'] = 'carried';
    const protoChild = buildChildEnv(parent, protoOverride);
    expect(Object.prototype.hasOwnProperty.call(protoChild, '__proto__')).toBe(true);
    expect(protoChild['__proto__']).toBe('carried');
    // The parent env object is never mutated.
    expect(parent.GH_TOKEN).toBe('ghp_marker_secret');
  });

  test('envAllowlist validation: malformed names throw at construction (#183)', () => {
    expect(() => new SubprocessDriver({ envAllowlist: [''] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new SubprocessDriver({ envAllowlist: ['A=B'] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new SubprocessDriver({ envAllowlist: ['BAD NAME'] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new SubprocessDriver({ envAllowlist: ['CLAUDE_CONFIG_DIR'] })).not.toThrow();
  });
});
