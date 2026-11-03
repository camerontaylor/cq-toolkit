// The fail-closed init-surface assertion (W1.4, ADR-0002 Annex A.2):
// expected-surface derivation — the closing options (settingSources [] +
// strictMcpConfig) and their subscription-connector non-leak, the
// StructuredOutput entry under outputFormat, mode-none expectations, and
// governed aborts that outrank the unverified check.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { foldMessage } from '../../../src/driver/claude-code/sdk.js';
import { HARNESS_ERROR_PREFIX } from '../../../src/driver/claude-code/verdict.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { toOutputSchema } from '../../../src/driver/common/structured.js';
import { runLadder } from '../../../src/kernel/governor.js';
import type { OpInvocation } from '../../../src/driver/types.js';
import {
  AGENT_USAGE,
  conformanceEndpointTable,
  conformanceHarnessConfig,
  driverWithCalls,
  honestInitSurface,
  invocation,
  mockAdapters,
  mockSdkModule,
  optionsOf,
} from './sdk.helpers.js';
import type { MockQueryCall } from './sdk.helpers.js';

// ---------------------------------------------------------------------------
// 3. The fail-closed init-surface assertion (W1.4, ADR-0002 Annex A.2)
// ---------------------------------------------------------------------------

describe('claude-agent init-surface assertion (mock sdk)', () => {
  test('options close the surface: settingSources [] and strictMcpConfig true', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      await driver.run(invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }));
      for (const nth of [0, 1]) {
        expect(optionsOf(calls, nth)['settingSources']).toEqual([]);
        expect(optionsOf(calls, nth)['strictMcpConfig']).toBe(true);
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('subscription connectors do NOT leak: the closing options keep the honest init surface exact → complete', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls,
            subscriptionConnectors: true,
          }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.error).toBeUndefined();
      // The mock's derivation is not vacuous: WITHOUT the closing options
      // the same subscription posture would attach the connector.
      const leaky = honestInitSurface(
        { ...optionsOf(calls), settingSources: undefined, strictMcpConfig: undefined },
        { subscriptionConnectors: true },
      );
      expect(leaky.tools).toContain('mcp__claude_ai_Gmail__send_message');
      expect(honestInitSurface(optionsOf(calls), { subscriptionConnectors: true })).toEqual({
        tools: [
          'mcp__cq-harness__read',
          'mcp__cq-harness__edit',
          'mcp__cq-harness__bash',
          'mcp__cq-harness__write',
        ],
        mcp_servers: [{ name: 'cq-harness', status: 'connected' }],
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('outputFormat set → StructuredOutput is part of the expected surface (present: complete; absent: mismatch)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const schema = z.object({ answer: z.string() }).strict();
      const base = {
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      };
      const invocationWithSchema = (): Partial<OpInvocation> => ({
        toolPolicy: { allow: ['read'], mode: 'allowlist' },
        outputSchema: toOutputSchema('test/init-surface/v1', schema),
      });
      const calls: MockQueryCall[] = [];
      const ok = await new ClaudeCodeDriver({
        transport: 'sdk',
        ...base,
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"answer":"ok"}' }, calls }),
      }).run(invocation(invocationWithSchema()));
      expect(ok.stopReason).toBe('complete');
      expect(ok.structuredOutput).toEqual({ answer: 'ok' });
      expect(honestInitSurface(optionsOf(calls)).tools).toEqual([
        'mcp__cq-harness__read',
        'StructuredOutput',
      ]);

      const missing = await new ClaudeCodeDriver({
        transport: 'sdk',
        ...base,
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: '{"answer":"ok"}' },
            calls: [],
            tamperInit: (surface) => ({
              ...surface,
              tools: surface.tools.filter((t) => t !== 'StructuredOutput'),
            }),
          }),
      }).run(invocation(invocationWithSchema()));
      expect(missing.stopReason).toBe('error');
      expect(missing.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(missing.structuredOutput).toBeUndefined();

      // And without outputFormat a StructuredOutput entry is an EXTRA tool.
      const extra = await new ClaudeCodeDriver({
        transport: 'sdk',
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            tamperInit: (surface) => ({
              ...surface,
              tools: [...surface.tools, 'StructuredOutput'],
            }),
          }),
      }).run(invocation());
      expect(extra.stopReason).toBe('error');
      expect(extra.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('mode none expects NO servers and NO tools (or only StructuredOutput with outputFormat)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const { driver } = driverWithCalls(scratchDir, { directive: { kind: 'reply', text: 'ok' } });
      const none = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(none.stopReason).toBe('complete');

      const structured = await new ClaudeCodeDriver({
        transport: 'sdk',
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"answer":"x"}' }, calls }),
      }).run(
        invocation({
          toolPolicy: { allow: [], mode: 'none' },
          outputSchema: toOutputSchema('test/output-format/v1', z.object({ answer: z.string() })),
        }),
      );
      expect(structured.stopReason).toBe('complete');
      expect(honestInitSurface(optionsOf(calls))).toEqual({
        tools: ['StructuredOutput'],
        mcp_servers: [],
      });

      // Any server at all in mode none is a mismatch — even a connected harness.
      const leaked = await new ClaudeCodeDriver({
        transport: 'sdk',
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            tamperInit: () => ({
              tools: ['mcp__cq-harness__read'],
              mcp_servers: [{ name: 'cq-harness', status: 'connected' }],
            }),
          }),
      }).run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(leaked.stopReason).toBe('error');
      expect(leaked.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);

      // A leaked builtin (tools: [] no longer stripping) is a mismatch too.
      const builtin = await new ClaudeCodeDriver({
        transport: 'sdk',
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            tamperInit: (surface) => ({ ...surface, tools: [...surface.tools, 'Bash'] }),
          }),
      }).run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(builtin.stopReason).toBe('error');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a governed abort still yields aborted — even when the SDK never sent an init frame', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      // Settles CLEANLY with a result but NO init frame, only after the
      // governed signal fired: aborted outranks the unverified check.
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              const signal = (options['abortController'] as { signal?: AbortSignal } | undefined)
                ?.signal;
              if (signal !== undefined) {
                await new Promise<void>((resolve) => {
                  if (signal.aborted) resolve();
                  else signal.addEventListener('abort', () => resolve(), { once: true });
                });
              }
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: 'agent-cli-abort-noinit',
                result: 'late',
                usage: AGENT_USAGE,
                permission_denials: [],
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const outcome = await runLadder(
        async (ctx) => driver.run(invocation(), { signal: ctx.signal }),
        { wallClockMs: 20 },
        { op: 'claude-agent', jobKey: 'claude-agent', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.error).toBeUndefined();

      // And the scripted block-until-abort path (honest init first) too.
      const { driver: blocking } = driverWithCalls(scratchDir, {
        directive: { kind: 'block-until-abort' },
      });
      const blocked = await runLadder(
        async (ctx) => blocking.run(invocation(), { signal: ctx.signal }),
        { wallClockMs: 20 },
        { op: 'claude-agent', jobKey: 'claude-agent', attempt: 1 },
      );
      expect(blocked.outcome).toBe('completed');
      if (blocked.outcome !== 'completed') return;
      expect(blocked.value.stopReason).toBe('aborted');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('foldMessage asserts only the FIRST init frame', () => {
    const observation: Parameters<typeof foldMessage>[0] = {
      agentSessionId: undefined,
      servedModel: undefined,
      transcript: [],
      narration: [],
      assistantUsage: undefined,
      result: undefined,
      error: undefined,
      caughtCause: undefined,
      errorKind: undefined,
      assistantRateLimit: false,
      deniedToolUseIds: new Set<string>(),
      denials: [],
      expectedSurface: { harness: true, tools: ['read'], internalTools: [] },
      initSeen: false,
      harnessFailure: undefined,
      refusalSeen: false,
    };
    foldMessage(observation, {
      type: 'system',
      subtype: 'init',
      tools: ['mcp__cq-harness__read'],
      mcp_servers: [{ name: 'cq-harness', status: 'connected', source: 'sdk' }],
    });
    expect(observation.initSeen).toBe(true);
    expect(observation.harnessFailure).toBeUndefined(); // extra fields beyond {name,status} are ignored
    foldMessage(observation, { type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [] });
    expect(observation.harnessFailure).toBeUndefined(); // a later init is not re-asserted
  });
});
