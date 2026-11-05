// ---------------------------------------------------------------------------
// Seam v2 §2.3 (S3) — invocation outputSchema, the uniform output-invalid
// verdict, the §2.2 CLI classifier rows, and providerSignals
// ---------------------------------------------------------------------------
// Split from test/driver/claude-code/cli.test.ts (pure move).

import {
  baseOptions,
  invocation,
  jsonSchemaArgOf,
  s3Driver,
  s3ErrorResultLine,
  s3InitLine,
  S3_ANSWER_SCHEMA,
  S3_USAGE,
  SpawnCall,
  thrownBy,
  withScratch,
} from './cli.helpers.js';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { WorkerResultSchema } from '../../../src/kernel/schema.js';
import { DispatchError, errorClassOf } from '../../../src/driver/errors.js';
import { RoutingTableSchema } from '../../../src/driver/claude-code/routing.js';
import { spawnManaged } from '../../../src/shared/proc.js';
import type { ManagedChild, SpawnOptions } from '../../../src/shared/proc.js';
import { CONFORMANCE_MODEL } from '../../../src/driver/conformance.js';
import { toOutputSchema } from '../../../src/driver/common/structured.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import type { WorkerResult } from '../../../src/driver/types.js';

describe('claude-code CLI transport seam v2 §2.3 (S3): invocation outputSchema + output-invalid + classifier', () => {
  test('round-trip: an invocation outputSchema rides --json-schema and the validated payload completes', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'structured-ok' }, calls),
      );
      const result = await driver.run(
        invocation({ outputSchema: S3_ANSWER_SCHEMA, toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
      // PRODUCER RULE: no class (and no error) on a non-error verdict.
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
      // The transport carries the EXACT invocation document, meta-URI
      // stripped; the same document is what the validator judged over.
      const sent = jsonSchemaArgOf(calls[0]?.args ?? []);
      expect(sent).toEqual(S3_ANSWER_SCHEMA.schema);
      expect(sent['$schema']).toBeUndefined();
    });
  });

  test('no schema requested: structuredOutput is ABSENT and no --json-schema is sent', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_REPLY: '{"answer":"ok"}' },
          calls,
        ),
      );
      const result = await driver.run(invocation({ prompt: 'no schema run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.errorClass).toBeUndefined();
      expect(calls[0]?.args).not.toContain('--json-schema');
    });
  });

  test('carve-outs: a token cap that fires with a schema in force is budget; a pre-aborted run is aborted', async () => {
    await withScratch(async (scratchDir) => {
      // A success frame with NO structured_output (a miss) whose usage trips
      // the cap: the missing object is the cap's consequence — budget, no
      // error, no class.
      const capped = s3Driver(scratchDir, [
        s3InitLine(['StructuredOutput']),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'cli-s3',
          model: CONFORMANCE_MODEL,
          usage: {
            input_tokens: 120_000,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
      ]);
      const cappedResult = await capped.run(
        invocation({
          outputSchema: S3_ANSWER_SCHEMA,
          toolPolicy: { allow: [], mode: 'none' },
          budget: { maxTokens: 1000 },
        }),
      );
      expect(cappedResult.stopReason).toBe('budget');
      expect(cappedResult.error).toBeUndefined();
      expect(cappedResult.errorClass).toBeUndefined();
      expect(cappedResult.structuredOutput).toBeUndefined();

      // An already-fired signal never dispatches: 'aborted', no class.
      const dead = new AbortController();
      dead.abort();
      const aborted = s3Driver(scratchDir, [s3InitLine(['StructuredOutput'])]);
      const abortedResult = await aborted.run(
        invocation({ outputSchema: S3_ANSWER_SCHEMA, toolPolicy: { allow: [], mode: 'none' } }),
        { signal: dead.signal },
      );
      expect(abortedResult.stopReason).toBe('aborted');
      expect(abortedResult.errorClass).toBeUndefined();
    });
  });

  test('a PARSED payload on a budget verdict stays absent (the served-model check judges completes)', async () => {
    await withScratch(async (scratchDir) => {
      // The cap fired AFTER the CLI produced a valid object: the payload is
      // still not a consumable outcome — withServedModelAssertion judges
      // only completes, so a payload riding a budget verdict would bypass
      // the observed-model check (parity with the ai-sdk lane; PR #238
      // review).
      const capped = s3Driver(scratchDir, [
        s3InitLine(['StructuredOutput']),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'cli-s3',
          model: CONFORMANCE_MODEL,
          structured_output: { answer: 'ok' },
          usage: {
            input_tokens: 120_000,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
      ]);
      const cappedResult = await capped.run(
        invocation({
          outputSchema: S3_ANSWER_SCHEMA,
          toolPolicy: { allow: [], mode: 'none' },
          budget: { maxTokens: 1000 },
        }),
      );
      expect(cappedResult.stopReason).toBe('budget');
      expect(cappedResult.structuredOutput).toBeUndefined();
      expect(cappedResult.usage).toBeDefined();
    });
  });

  test('an uncompilable outputSchema is the LOCAL output-invalid verdict before any spawn (PR #238 review round 2)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver(baseOptions(scratchDir, {}, calls));
      const result = await driver.run(
        invocation({
          outputSchema: { name: 'test.broken/v1', schema: { type: 'not-a-json-schema-type' } },
          toolPolicy: { allow: [], mode: 'none' },
        }),
      );
      // The uniform schema-miss verdict, compiled locally — the same shape
      // the settle-time miss flow produces, never a provider/harness
      // failure from a request-setup rejection. Nothing was spawned and no
      // session state exists.
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.error).toContain('test.broken/v1');
      expect(result.error).toContain('could not be compiled');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.denials).toEqual([]);
      expect(result.sessionId).toBeUndefined();
      expect(calls).toEqual([]); // the CLI never ran
    });
  });

  test('I8 precedence: an already-aborted signal outranks an uncompilable outputSchema (PR #241)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver(baseOptions(scratchDir, {}, calls));
      const controller = new AbortController();
      controller.abort();
      const result = await driver.run(
        invocation({
          outputSchema: { name: 'test.broken/v1', schema: { type: 'not-a-json-schema-type' } },
          toolPolicy: { allow: [], mode: 'none' },
        }),
        { signal: controller.signal },
      );
      // The governed cancellation outranks the schema fault: the run settles
      // the plain abort verdict, never the LOCAL output-invalid one.
      expect(result.stopReason).toBe('aborted');
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(calls).toEqual([]); // the CLI never ran
    });
  });

  test('classifier rows through the lane: quota (claude limit text, spend limit, opencode funds) and rate-limit rows', async () => {
    await withScratch(async (scratchDir) => {
      let runCount = 0;
      const fresh = (): string => join(scratchDir, `run-${(runCount += 1)}`);

      // The claude CLI's usage-limit result → quota WITH the window reset.
      const limited = s3Driver(fresh(), [
        s3InitLine([]),
        s3ErrorResultLine({
          result: "You've hit your session limit · resets 3pm (Asia/Singapore)",
        }),
      ]);
      const limitedResult = await limited.run(
        invocation({ prompt: 'limited run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(limitedResult.stopReason).toBe('error');
      expect(limitedResult.errorClass).toBe('quota');
      const resetAt = limitedResult.providerSignals?.windows?.[0]?.resetAt;
      expect(resetAt).toBeDefined();
      const instant = Date.parse(resetAt as string);
      expect(instant).toBeGreaterThan(Date.now() - 60_000);
      expect(instant).toBeLessThan(Date.now() + 36 * 3_600_000);
      expect(limitedResult.providerSignals?.windows?.[0]?.id).toBe('5h');

      // The weekly window is named '7d'.
      const weekly = s3Driver(fresh(), [
        s3InitLine([]),
        s3ErrorResultLine({
          result: "You've hit your weekly limit · resets 2026-12-31 3pm (Asia/Singapore)",
        }),
      ]);
      const weeklyResult = await weekly.run(
        invocation({ prompt: 'weekly run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(weeklyResult.errorClass).toBe('quota');
      expect(weeklyResult.providerSignals?.windows?.[0]?.id).toBe('7d');

      // Gateway funded-allowance prose → quota.
      const spend = s3Driver(fresh(), [
        s3InitLine([]),
        s3ErrorResultLine({ result: 'gateway upstream: spend limit reached for this account' }),
      ]);
      const spendResult = await spend.run(
        invocation({ prompt: 'spend run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(spendResult.errorClass).toBe('quota');

      // The opencode funded-balance row → quota.
      const funds = s3Driver(fresh(), [
        s3InitLine([]),
        s3ErrorResultLine({ errors: ['HTTP 402: Insufficient account funds'] }),
      ]);
      const fundsResult = await funds.run(
        invocation({ prompt: 'funds run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(fundsResult.errorClass).toBe('quota');

      // The throttle rows → rate-limit (result-frame text AND stderr).
      const throttled = s3Driver(fresh(), [
        s3InitLine([]),
        s3ErrorResultLine({ result: 'Server is temporarily limiting requests' }),
      ]);
      const throttledResult = await throttled.run(
        invocation({ prompt: 'throttled run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(throttledResult.errorClass).toBe('rate-limit');

      // "Request rejected (429)" arrives on STDERR with a non-zero exit —
      // the throttle row still outranks the close-cause branch.
      const rejectedViaStderr = new ClaudeCodeDriver({
        ...baseOptions(fresh(), {}, []),
        spawn: (opts) =>
          spawnManaged({
            ...opts,
            command: process.execPath,
            args: [
              '-e',
              `process.stdin.resume(); process.stderr.write('Request rejected (429)\\n'); process.exitCode = 1;`,
            ],
          }),
      });
      const rejectedResult = await rejectedViaStderr.run(
        invocation({ prompt: 'rejected run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(rejectedResult.stopReason).toBe('error');
      expect(rejectedResult.errorClass).toBe('rate-limit');
    });
  });

  test('the codex row: non-zero exit with folded usage and no result event → provider-error', async () => {
    await withScratch(async (scratchDir) => {
      const usageThenExit = (opts: SpawnOptions): ManagedChild =>
        spawnManaged({
          ...opts,
          command: process.execPath,
          args: [
            '-e',
            `process.stdin.resume();
             process.stdout.write(${JSON.stringify(s3InitLine([]))} + '\\n');
             process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial work' }], usage: S3_USAGE_FIXTURE } }) + '\\n');
             process.exitCode = 1;`.replaceAll('S3_USAGE_FIXTURE', JSON.stringify(S3_USAGE)),
          ],
        });
      // A codex CLI: the provider's failure surfaced through the CLI.
      const codex = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, {}, []),
        binary: ['/opt/vendor/codex'],
        spawn: usageThenExit,
      });
      const codexResult = await codex.run(
        invocation({ prompt: 'codex run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(codexResult.stopReason).toBe('error');
      expect(codexResult.errorClass).toBe('provider-error');
      expect(codexResult.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });

      // CONTROL: the same stream from a non-codex binary stays 'harness'
      // (the exit is the CLI's own crash, not a provider classification).
      const plain = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, {}, []),
        spawn: usageThenExit,
      });
      const plainResult = await plain.run(
        invocation({ prompt: 'plain run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(plainResult.stopReason).toBe('error');
      expect(plainResult.errorClass).toBe('harness');
    });
  });

  test('a missing route key env throws DispatchError config before any spawn', async () => {
    await withScratch(async (scratchDir) => {
      const keyName = 'CQ_TEST_SUBPROCESS_MISSING_KEY';
      const saved = process.env[keyName];
      delete process.env[keyName];
      try {
        const driver = new ClaudeCodeDriver({
          ...baseOptions(scratchDir, {}, []),
          routingTable: RoutingTableSchema.parse({
            endpoints: {
              conformance: {
                baseUrlEnv: 'CONFORMANCE_BASE_URL',
                baseUrlDefault: 'http://127.0.0.1:1/anthropic',
                keyEnv: keyName,
                models: ['conformance-1'],
                notes: 'key-less endpoint for the missing-key pre-dispatch test',
              },
            },
          }),
        });
        const err = await thrownBy(driver.run(invocation()));
        expect(err).toBeInstanceOf(DispatchError);
        expect(errorClassOf(err)).toBe('config');
        expect((err as Error).message).toMatch(new RegExp(keyName));
      } finally {
        if (saved !== undefined) process.env[keyName] = saved;
      }
    });
  });

  test('producer rule: errorClass rides every error verdict and NO non-error verdict; the mirror still parses them', async () => {
    await withScratch(async (scratchDir) => {
      let runCount = 0;
      const fresh = (): string => join(scratchDir, `run-${(runCount += 1)}`);
      const runs: Array<{ label: string; result: WorkerResult }> = [];

      // 1. exit 1 with no result event → error/'harness'.
      const fail = s3Driver(fresh(), [s3InitLine([])], { exitCode: 1 });
      runs.push({
        label: 'fail',
        result: await fail.run(
          invocation({ prompt: 'producer fail run', toolPolicy: { allow: [], mode: 'none' } }),
        ),
      });

      // 2. a structured-output miss → error/'output-invalid'.
      const miss = new ClaudeCodeDriver(
        baseOptions(
          fresh(),
          { FAKE_AGENT_MODE: 'structured-ok', FAKE_AGENT_STRUCTURED_RAW: '{"answer":42}' },
          [],
        ),
      );
      runs.push({
        label: 'output-invalid',
        result: await miss.run(
          invocation({
            prompt: 'producer miss run',
            toolPolicy: { allow: [], mode: 'none' },
            outputSchema: toOutputSchema(
              'test/producer-miss/v1',
              z.object({ answer: z.string() }).strict(),
            ),
          }),
        ),
      });

      // 3. the CLI usage-limit result → error/'quota' with the window.
      const quota = s3Driver(fresh(), [
        s3InitLine([]),
        s3ErrorResultLine({
          result: "You've hit your session limit · resets 3pm (Asia/Singapore)",
        }),
      ]);
      runs.push({
        label: 'quota',
        result: await quota.run(
          invocation({ prompt: 'producer quota run', toolPolicy: { allow: [], mode: 'none' } }),
        ),
      });

      // 4. complete → NO class.
      const ok = s3Driver(fresh(), [
        s3InitLine([]),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'cli-s3',
          model: CONFORMANCE_MODEL,
          usage: S3_USAGE,
        }),
      ]);
      runs.push({
        label: 'complete',
        result: await ok.run(
          invocation({ prompt: 'producer ok run', toolPolicy: { allow: [], mode: 'none' } }),
        ),
      });

      // 5. pre-aborted → 'aborted', NO class (a cancellation is not a failure).
      const dead = new AbortController();
      dead.abort();
      const aborted = s3Driver(fresh(), [s3InitLine([])]);
      runs.push({
        label: 'aborted',
        result: await aborted.run(
          invocation({ prompt: 'producer aborted run', toolPolicy: { allow: [], mode: 'none' } }),
          { signal: dead.signal },
        ),
      });

      for (const { label, result } of runs) {
        if (result.stopReason === 'error') {
          expect(result.errorClass, `${label}: error verdicts carry a class`).toBeDefined();
        } else {
          expect(result.errorClass, `${label}: non-error verdicts carry none`).toBeUndefined();
        }
        // The strict v2 mirror parses every verdict (errorClass is
        // one-directional: present ⇒ error).
        const reparsed = WorkerResultSchema.parse(JSON.parse(JSON.stringify(result)));
        expect(reparsed.stopReason).toBe(result.stopReason);
      }
      expect(runs.map((r) => r.result.stopReason)).toEqual([
        'error',
        'error',
        'error',
        'complete',
        'aborted',
      ]);
    });
  });
});
