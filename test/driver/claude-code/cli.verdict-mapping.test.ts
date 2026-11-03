// Split from test/driver/claude-code/cli.test.ts (pure move). The outer describe
// wrapper is reproduced so every full test title is unchanged.
// Subject: result mapping — usage, cost, structured output, verdict causes, errorClass.

import {
  baseOptions,
  invocation,
  jsonSchemaArgOf,
  markersOf,
  narrationOf,
  withScratch,
  SpawnCall,
} from './cli.helpers.js';
import { describe, expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import { HARNESS_ERROR_PREFIX, stopReasonOf } from '../../../src/driver/claude-code/verdict.js';
import { usageFromWire } from '../../../src/driver/claude-code/usage.js';
import type { SpawnFn } from '../../../src/driver/claude-code/cli.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { spawnManaged } from '../../../src/shared/proc.js';
import type { ProcessClose } from '../../../src/shared/proc.js';
import { CONFORMANCE_PROVIDER } from '../../../src/driver/conformance.js';
import { toOutputSchema } from '../../../src/driver/common/structured.js';

describe('claude-code driver, CLI transport specifics (fake agent CLI)', () => {
  test('junk lines are narration, never a crash: the result event still parses', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(
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

  test('deny-tool: the CLI permission denial maps to the frozen {tool, reason} shape under the HARNESS name', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'deny-tool' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'denial run' }));
      // The CLI's permission gate refused mcp__cq-harness__edit (frame +
      // its own text); the denial speaks OUR vocabulary — the harness name.
      expect(result.denials).toEqual([
        {
          tool: 'edit',
          reason:
            "Claude requested permissions to use mcp__cq-harness__edit, but you haven't granted it yet.",
        },
      ]);
      // result.is_error:true → an error verdict even though the stream closed cleanly.
      expect(result.stopReason).toBe('error');
      // A failed result frame is a provider-side outcome (ADR-0002 §2.2).
      expect(result.errorClass).toBe('provider-error');
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
    });
  });

  test('result-event error path: the error verdict names the result cause and stays bounded (#208)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new ClaudeCodeDriver(
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
      expect(result.errorClass).toBe('provider-error');
      // boundedErrorText contract: ≤500 chars, or the truncation marker.
      expect(/… \[truncated\]$/.test(error) || error.length <= 513).toBe(true);
    });
  });

  test('result-event cause precedence: result string wins over errors over subtype (#208)', async () => {
    await withScratch(async (scratchDir) => {
      const resultString = await new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'error-result' }, []),
      ).run(invocation({ prompt: 'result-string run' }));
      // The `result` string outranks the `errors` entries and the subtype.
      expect(resultString.error).toContain('result-string-cause');
      expect(resultString.error).not.toContain('errors-entry-cause');
      expect(resultString.errorClass).toBe('provider-error');

      const errorsOnly = await new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'error-errors' }, []),
      ).run(invocation({ prompt: 'errors run' }));
      // No `result` string → the joined `errors` entries are the cause.
      expect(errorsOnly.error).toContain('errors-entry-cause');
      expect(errorsOnly.error).not.toContain('error_during_execution');
      expect(errorsOnly.errorClass).toBe('provider-error');
    });
  });

  test('structured output: --json-schema + the fixture structured_output land in the result', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const schema = z.object({ answer: z.string() }).strict();
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'structured-ok' }, calls),
      );
      const result = await driver.run(
        invocation({
          prompt: 'structured run',
          outputSchema: toOutputSchema('test/structured/v1', schema),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
      // The serialized --json-schema arg carries NO draft-2020-12 meta key —
      // the CLI rejects that URI before the model runs (#209).
      const arg = jsonSchemaArgOf(calls[0]?.args ?? []);
      expect(arg['$schema']).toBeUndefined();
      expect(arg).toEqual(toOutputSchema('test/structured/v1', schema).schema);
    });
  });

  test('structured output: a schema-violating payload is the output-invalid verdict, never trusted (S3)', async () => {
    await withScratch(async (scratchDir) => {
      // The fixture emits the raw payload verbatim (a lying CLI — no fixture
      // schema checking), so the driver's own settle-time validation is what
      // stands between the vendor field and the seam.
      const driver = new ClaudeCodeDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'structured-ok', FAKE_AGENT_STRUCTURED_RAW: '{"answer":42}' },
          [],
        ),
      );
      const result = await driver.run(
        invocation({
          prompt: 'lying CLI run',
          outputSchema: toOutputSchema(
            'test/structured/v1',
            z.object({ answer: z.string() }).strict(),
          ),
        }),
      );
      // The §2.3 miss verdict (S3): the payload failed the schema, so the
      // run is an error/'output-invalid' — NOT a complete with a dropped
      // payload (the old behaviour is deleted), and the rejection is named.
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.error).toContain('structured output invalid');
      expect(result.error).toContain("schema 'test/structured/v1'");
      // A real measurement keeps its usage evidence on the miss verdict.
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
    });
  });

  test('usage mapping: the fixed fixture numbers become the frozen Usage shape', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new ClaudeCodeDriver(baseOptions(scratchDir, {}, []));
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
      const priced = new ClaudeCodeDriver({
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

      const unpriced = new ClaudeCodeDriver(baseOptions(scratchDir, {}, []));
      const unknown = await unpriced.run(invocation({ prompt: 'unpriced run' }));
      expect(unknown.costUSD).toBeUndefined(); // derived-only: never fabricated
    });
  });

  test('budget: maxTokens trips on the folded result usage (pre-verdict check only)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new ClaudeCodeDriver(
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
      const driver = new ClaudeCodeDriver(
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
      // A non-zero exit with no result event is a local (harness) failure.
      expect(result.errorClass).toBe('harness');
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
      const driver = new ClaudeCodeDriver({
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
      const driver = new ClaudeCodeDriver(
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
      expect(result.errorClass).toBe('harness');
    });
  });

  test('served-model pricing + mismatch marker: the price lookup gets the SERVED id (#19-1/#24, #19-2)', async () => {
    await withScratch(async (scratchDir, store) => {
      const pricedKeys: Array<{ provider: string; model: string }> = [];
      const driver = new ClaudeCodeDriver({
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
      usageFromWire({
        input_tokens: -200_000,
        output_tokens: 150_000,
        cache_read_input_tokens: -3,
        cache_creation_input_tokens: 2.5,
      }),
    ).toEqual({ input: 0, output: 150_000, cacheRead: 0, cacheWrite: 0 });
    // The bypass is closed: the OLD fold read -50,000 total (negative
    // input masking real spend), which could never trip `>= maxTokens`;
    // the tightened fold counts the real magnitude.
    const lying = usageFromWire({ input_tokens: -200_000, output_tokens: 150_000 });
    expect(lying).toBeDefined();
    if (lying === undefined) return;
    expect(
      stopReasonOf({ aborted: false, maxTokens: 1000, usage: lying, resultStatus: 'success' }),
    ).toBe('budget');
  });

  test.each([
    { aborted: true, harnessFailure: true, oversizedLine: true, expected: 'aborted' },
    { aborted: false, harnessFailure: true, oversizedLine: true, expected: 'error' },
    { aborted: false, harnessFailure: true, oversizedLine: false, expected: 'error' },
    { aborted: false, harnessFailure: false, oversizedLine: true, expected: 'error' },
    { aborted: false, harnessFailure: false, oversizedLine: false, expected: 'budget' },
  ])('stop reason precedence over budget: %j', ({ expected, ...flags }) => {
    expect(
      stopReasonOf({
        ...flags,
        maxTokens: 1,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        resultStatus: 'success',
      }),
    ).toBe(expected);
  });

  test.each(['harness', 'stock'] as const)(
    '%s: harness failure precedes oversized-line cause; both precede budget',
    async (toolSurface) => {
      await withScratch(async (scratchDir, store) => {
        // No init + a success frame creates the unverified-surface failure
        // only in harness mode. Both runs really exceed the line bound and
        // token budget, so stock is the oversized-line control.
        const frame = JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 10, output_tokens: 5 },
          structured_output: { answer: 'must be voided on harness failure' },
        });
        let childClose: Promise<ProcessClose> | undefined;
        const driver = new ClaudeCodeDriver({
          ...baseOptions(scratchDir, {}, []),
          toolSurface,
          spawn: (options) => {
            const child = spawnManaged({
              ...options,
              command: process.execPath,
              args: [
                '-e',
                `process.stdin.resume(); process.stdout.write('x'.repeat(2048) + '\\n' + ${JSON.stringify(frame)} + '\\n');`,
              ],
              maxRetainedBytes: 1024,
            });
            childClose = child.close;
            return child;
          },
        });
        const result = await driver.run(
          invocation({ toolPolicy: { allow: [], mode: 'none' }, budget: { maxTokens: 1 } }),
        );
        if (childClose === undefined) throw new Error('expected the driver to spawn a child');
        expect((await childClose).oversizedLine).toBe(true);
        expect(result.stopReason).toBe('error');
        expect(result.usage.input).toBe(10);
        if (toolSurface === 'harness') {
          expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
          expect(result.error).toContain('never reported its init surface');
          expect(result.error).not.toContain('oversized');
          expect(result.errorClass).toBe('harness');
          expect(result.structuredOutput).toBeUndefined();
          expect(
            await markersOf(store, result.sessionId as string, 'harness-surface-unverified'),
          ).toEqual([{ cq: 'harness-surface-unverified', errorClass: 'harness' }]);
        } else {
          expect(result.error).toContain('oversized stdout/stderr line');
          expect(result.errorClass).toBe('harness'); // an oversized line is a protocol break
        }
      });
    },
  );

  test('a SYNCHRONOUS spawn failure is an error verdict, not a rejection (#19-5)', async () => {
    await withScratch(async (scratchDir, store) => {
      const throwingSpawn: SpawnFn = () => {
        throw new TypeError('spawn args must be strings');
      };
      const driver = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, {}, []),
        spawn: throwingSpawn,
      });
      // The run RESOLVES with an honest error verdict — the spawn throw is
      // contained behind the frozen seam.
      const result = await driver.run(invocation({ prompt: 'boom run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      // Seam v3: a spawn failure measured nothing — declared unmeasured.
      expect(result.usageProvenance).toBe('unmeasured');
      expect(result.costUSD).toBeUndefined(); // nothing was measured — no cost claim
      // #208: the spawn cause reaches WorkerResult.error too, not just narration.
      expect(result.error).toContain('spawn failed');
      expect(result.error).toContain('spawn args must be strings');
      expect(result.errorClass).toBe('harness');
      // The failure is narrated best-effort (same swallow rule as persistence).
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"spawn-failed"'));
      expect(marker).toBeDefined();
      expect(marker).toContain('spawn args must be strings');
    });
  });
});
