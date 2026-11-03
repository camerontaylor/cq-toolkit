import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { AcpEndpointTableSchema } from '../../src/driver/acp/binaries.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { SESSIONS_DIR } from '../../src/driver/conformance.js';
import { WorkerResultSchema } from '../../src/kernel/schema.js';
import type { OutputSchema, WorkerResult } from '../../src/driver/types.js';
import type { SpawnCall } from './acp.helpers.js';
import { recordingSpawn, driverOptions, invocation, withScratch, thrownBy } from './acp.helpers.js';

// ---------------------------------------------------------------------------
// Seam v2 §2.3 (S3) — invocation outputSchema, the uniform output-invalid
// verdict, the §2.2 classifier rows, DispatchError config throws
// ---------------------------------------------------------------------------

/** The invocation schema the §2.3 tests carry: `{answer: string}`, closed. */
const S3_ANSWER_SCHEMA: OutputSchema = {
  name: 'test.answer/v1',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
};

/** The fixed usage the scripted agent reports (the fixture's numbers). */
const S3_USAGE_WIRE = {
  totalTokens: 20,
  inputTokens: 15,
  outputTokens: 5,
  thoughtTokens: 0,
  cachedReadTokens: 2,
  cachedWriteTokens: 3,
};

/**
 * A MINIMAL scripted ACP agent for the classifier rows the fixture cannot
 * persona: a complete handshake (initialize → session/new → the confirmed
 * mode pin), then the prompt settles with a CHOSEN wire stopReason — or a
 * JSON-RPC error response. Written into the scratch dir; spawned through the
 * driver's `command` option (the same PATH-resolved `node` the fixture uses).
 */
async function writeScriptedAgent(
  scratchDir: string,
  opts: { stopReason: string } | { promptError: true },
): Promise<string> {
  const promptScript =
    'promptError' in opts
      ? `send({ jsonrpc: '2.0', id: frame.id, error: { code: -32001, message: 'the vendor refused the prompt' } });`
      : `send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: ${JSON.stringify(opts.stopReason)}, usage: USAGE } });`;
  const path = join(scratchDir, 'scripted-acp-agent.mjs');
  await writeFile(
    path,
    `import process from 'node:process';
const USAGE = ${JSON.stringify(S3_USAGE_WIRE)};
let buffer = '';
const send = (frame) => process.stdout.write(\`\${JSON.stringify(frame)}\\n\`);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    const frame = JSON.parse(line);
    if (frame.method === 'initialize') {
      send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } });
    } else if (frame.method === 'session/new') {
      send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'scripted-s3' } });
    } else if (frame.method === 'session/set_config_option') {
      send({ jsonrpc: '2.0', id: frame.id, result: { modes: { currentModeId: 'build' } } });
    } else if (frame.method === 'session/prompt') {
      ${promptScript}
    } else if (frame.id !== undefined) {
      send({ jsonrpc: '2.0', id: frame.id, result: {} });
    }
  }
});
`,
    'utf8',
  );
  return path;
}

/** An S3 driver over the scripted agent (no modelEnv — the script reads no env). */
function scriptedDriver(scratchDir: string, agentPath: string): AcpDriver {
  return new AcpDriver({
    command: ['node', agentPath],
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    workspaceRoot: join(scratchDir, 'workspaces'),
    spawn: recordingSpawn([]),
  });
}

describe('acp driver seam v2 §2.3 (S3): invocation outputSchema + output-invalid + classifier', () => {
  test('round-trip: an invocation outputSchema completes with the validated payload', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: '{"answer":"ok"}' }, []),
      );
      const result = await driver.run(
        invocation({ outputSchema: S3_ANSWER_SCHEMA, prompt: 'produce the answer' }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
      // PRODUCER RULE: no class (and no error) on a non-error verdict.
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
    });
  });

  test('no schema requested: structuredOutput is ABSENT even when the reply is JSON', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: '{"answer":"ok"}' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'no schema run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.errorClass).toBeUndefined();
    });
  });

  test('an invocation-source miss settles output-invalid (an unparseable reply and a schema-invalid one alike)', async () => {
    await withScratch(async (scratchDir) => {
      const prose = new AcpDriver(
        driverOptions(
          scratchDir,
          { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: 'no json here at all' },
          [],
        ),
      );
      const proseResult = await prose.run(
        invocation({ outputSchema: S3_ANSWER_SCHEMA, prompt: 'prose miss run' }),
      );
      expect(proseResult.stopReason).toBe('error');
      expect(proseResult.errorClass).toBe('output-invalid');
      expect(proseResult.structuredOutput).toBeUndefined();

      const schemaInvalid = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: '{"answer":42}' }, []),
      );
      const invalidResult = await schemaInvalid.run(
        invocation({ outputSchema: S3_ANSWER_SCHEMA, prompt: 'schema-invalid run' }),
      );
      expect(invalidResult.stopReason).toBe('error');
      expect(invalidResult.errorClass).toBe('output-invalid');
      expect(invalidResult.error).toContain('test.answer/v1');
    });
  });

  test('carve-outs: a token cap that fires with a schema in force is budget; a pre-aborted run is aborted', async () => {
    await withScratch(async (scratchDir) => {
      // A prose reply (a miss) whose measured usage trips the cap: the
      // missing object is the cap's consequence — budget, no error, no class.
      const capped = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: 'prose, not JSON' }, []),
      );
      const cappedResult = await capped.run(
        invocation({
          outputSchema: S3_ANSWER_SCHEMA,
          prompt: 'capped run',
          budget: { maxTokens: 1 },
        }),
      );
      expect(cappedResult.stopReason).toBe('budget');
      expect(cappedResult.error).toBeUndefined();
      expect(cappedResult.errorClass).toBeUndefined();
      expect(cappedResult.structuredOutput).toBeUndefined();

      // An already-fired signal never dispatches: 'aborted', no class.
      const dead = new AbortController();
      dead.abort();
      const aborted = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: '{"answer":"ok"}' }, []),
      );
      const abortedResult = await aborted.run(
        invocation({ outputSchema: S3_ANSWER_SCHEMA, prompt: 'aborted run' }),
        { signal: dead.signal },
      );
      expect(abortedResult.stopReason).toBe('aborted');
      expect(abortedResult.errorClass).toBeUndefined();
    });
  });

  test('a PARSED payload on a budget verdict stays absent (the served-model check judges completes)', async () => {
    await withScratch(async (scratchDir) => {
      // The cap fired AFTER the turn produced a valid object: the payload
      // is still not a consumable outcome — withServedModelAssertion judges
      // only completes, so a payload riding a budget verdict would bypass
      // the observed-model check (parity with the ai-sdk lane; PR #238
      // review).
      const capped = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: '{"answer":"ok"}' }, []),
      );
      const cappedResult = await capped.run(
        invocation({
          outputSchema: S3_ANSWER_SCHEMA,
          prompt: 'capped payload run',
          budget: { maxTokens: 1 },
        }),
      );
      expect(cappedResult.stopReason).toBe('budget');
      expect(cappedResult.structuredOutput).toBeUndefined();
      expect(cappedResult.usage).toBeDefined();
    });
  });

  test('classifier rows: connection failure → harness; refusal → provider-error; an unresolved stop reason → unknown; child death → harness; a JSON-RPC prompt error → provider-error', async () => {
    await withScratch(async (scratchDir) => {
      let runCount = 0;
      const fresh = async (): Promise<string> => {
        const dir = join(scratchDir, `run-${(runCount += 1)}`);
        await mkdir(dir, { recursive: true });
        return dir;
      };

      // The oversized-frame connection failure (wire integrity broke) → harness.
      const connectionFailed = new AcpDriver(
        driverOptions(scratchDir, { FAKE_ACP_MODE: 'ok', FAKE_ACP_HUGE_FRAME: '1' }, []),
      );
      const connectionResult = await connectionFailed.run(invocation({ prompt: 'huge frame run' }));
      expect(connectionResult.stopReason).toBe('error');
      expect(connectionResult.errorClass).toBe('harness');

      // The wire stopReason 'refusal' is the provider-reported row → provider-error.
      const refusal = scriptedDriver(
        scratchDir,
        await writeScriptedAgent(await fresh(), { stopReason: 'refusal' }),
      );
      const refusalResult = await refusal.run(invocation({ prompt: 'refusal run' }));
      expect(refusalResult.stopReason).toBe('error');
      expect(refusalResult.errorClass).toBe('provider-error');
      expect(refusalResult.error).toContain("stopReason 'refusal'");

      // An UNRECOGNIZED vendor stopReason is unresolved → unknown (never a
      // guessed class).
      const weird = scriptedDriver(
        scratchDir,
        await writeScriptedAgent(await fresh(), { stopReason: 'vendor_surprise' }),
      );
      const weirdResult = await weird.run(invocation({ prompt: 'weird reason run' }));
      expect(weirdResult.stopReason).toBe('error');
      expect(weirdResult.errorClass).toBe('unknown');

      // The child died after the pin, before any prompt response → harness.
      const died = new AcpDriver(driverOptions(scratchDir, { FAKE_ACP_MODE: 'fail' }, []));
      const diedResult = await died.run(invocation({ prompt: 'child death run' }));
      expect(diedResult.stopReason).toBe('error');
      expect(diedResult.errorClass).toBe('harness');

      // The vendor ANSWERED the prompt with a JSON-RPC error → provider-error.
      const rpc = scriptedDriver(
        scratchDir,
        await writeScriptedAgent(await fresh(), { promptError: true }),
      );
      const rpcResult = await rpc.run(invocation({ prompt: 'rpc error run' }));
      expect(rpcResult.stopReason).toBe('error');
      expect(rpcResult.errorClass).toBe('provider-error');
      expect(rpcResult.error).toContain('the vendor refused the prompt');
    });
  });

  test('DispatchError config: absent binary + unknown endpoint carry the config class pre-dispatch', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const table = AcpEndpointTableSchema.parse({
        endpoints: {
          'absent-harness': {
            command: ['cq-absent-s3-bin'],
            installHint: 'npm install -g some-absent-harness',
            notes: 'test endpoint: a registry name whose binary does not exist on this host',
          },
        },
      });
      const absent = new AcpDriver({
        endpoint: 'absent-harness',
        endpointTable: table,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        spawn: recordingSpawn(calls),
      });
      const absentErr = await thrownBy(absent.run(invocation()));
      expect(absentErr).toBeInstanceOf(DispatchError);
      expect(errorClassOf(absentErr)).toBe('config');

      const unknown = new AcpDriver({
        endpoint: 'nope',
        endpointTable: table,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        workspaceRoot: join(scratchDir, 'workspaces'),
        spawn: recordingSpawn(calls),
      });
      const unknownErr = await thrownBy(unknown.run(invocation()));
      expect(unknownErr).toBeInstanceOf(DispatchError);
      expect(errorClassOf(unknownErr)).toBe('config');
      expect(calls).toEqual([]); // pre-dispatch: never spawned
    });
  });

  test('producer rule: errorClass rides every error verdict and NO non-error verdict; the mirror still parses them', async () => {
    await withScratch(async (scratchDir) => {
      let runCount = 0;
      const fresh = async (): Promise<string> => {
        const dir = join(scratchDir, `run-${(runCount += 1)}`);
        await mkdir(dir, { recursive: true });
        return dir;
      };
      const runs: Array<{ label: string; result: WorkerResult }> = [];

      // 1. a structured-output miss → error/'output-invalid'.
      const miss = new AcpDriver(
        driverOptions(
          await fresh(),
          { FAKE_ACP_MODE: 'ok', FAKE_ACP_REPLY: 'prose, not JSON' },
          [],
        ),
      );
      runs.push({
        label: 'output-invalid',
        result: await miss.run(
          invocation({ outputSchema: S3_ANSWER_SCHEMA, prompt: 'producer miss run' }),
        ),
      });

      // 2. child death mid-prompt → error/'harness'.
      const died = new AcpDriver(driverOptions(await fresh(), { FAKE_ACP_MODE: 'fail' }, []));
      runs.push({
        label: 'harness',
        result: await died.run(invocation({ prompt: 'producer harness run' })),
      });

      // 3. refusal → error/'provider-error'.
      const refusal = scriptedDriver(
        scratchDir,
        await writeScriptedAgent(await fresh(), { stopReason: 'refusal' }),
      );
      runs.push({
        label: 'provider-error',
        result: await refusal.run(invocation({ prompt: 'producer refusal run' })),
      });

      // 4. complete → NO class.
      const ok = new AcpDriver(driverOptions(await fresh(), { FAKE_ACP_MODE: 'ok' }, []));
      runs.push({
        label: 'complete',
        result: await ok.run(invocation({ prompt: 'producer ok run' })),
      });

      // 5. pre-aborted → 'aborted', NO class (a cancellation is not a failure).
      const dead = new AbortController();
      dead.abort();
      const aborted = new AcpDriver(driverOptions(await fresh(), { FAKE_ACP_MODE: 'ok' }, []));
      runs.push({
        label: 'aborted',
        result: await aborted.run(invocation({ prompt: 'producer aborted run' }), {
          signal: dead.signal,
        }),
      });

      // 6. capped → 'budget', NO class.
      const capped = new AcpDriver(driverOptions(await fresh(), { FAKE_ACP_MODE: 'ok' }, []));
      runs.push({
        label: 'budget',
        result: await capped.run(
          invocation({ prompt: 'producer budget run', budget: { maxTokens: 1 } }),
        ),
      });

      for (const { label, result } of runs) {
        if (result.stopReason === 'error') {
          expect(result.errorClass, `${label}: error verdicts carry a class`).toBeDefined();
          expect(result.error, `${label}: error verdicts carry a bounded cause`).toBeDefined();
        } else {
          expect(result.errorClass, `${label}: non-error verdicts carry none`).toBeUndefined();
          expect(result.error, `${label}: non-error verdicts carry no error`).toBeUndefined();
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
        'budget',
      ]);
    });
  });
});
