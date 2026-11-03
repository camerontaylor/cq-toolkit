// The fail-closed init-surface assertion (W1.4, ADR-0002 Annex A.2):
// mismatch detection — tampered init surfaces (an extra connector server,
// a missing/failed harness server, a subset tools list), the narration
// markers persisted for a mismatch or an unverified (init-less) run, and
// the generator that is never resumed after the mismatch.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { HARNESS_ERROR_PREFIX } from '../../../src/driver/claude-code/verdict.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { toOutputSchema } from '../../../src/driver/common/structured.js';
import { SessionStore } from '../../../src/harness/session.js';
import {
  AGENT_USAGE,
  MOCK_CONNECTOR_SERVER,
  MOCK_CONNECTOR_TOOLS,
  conformanceEndpointTable,
  conformanceHarnessConfig,
  honestInitSurface,
  initFrame,
  invocation,
  mockAdapters,
  mockSdkModule,
} from './sdk.helpers.js';
import type { MockQueryCall, MockSdkTool } from './sdk.helpers.js';

// ---------------------------------------------------------------------------
// 3. The fail-closed init-surface assertion (W1.4, ADR-0002 Annex A.2)
// ---------------------------------------------------------------------------

describe('claude-agent init-surface assertion (mock sdk)', () => {
  /** The narration marker objects persisted for one run (parsed JSON lines). */
  async function narrationMarkers(
    scratchDir: string,
    sessionId: string | undefined,
  ): Promise<Array<Record<string, unknown>>> {
    const record = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(sessionId as string);
    const narration = record?.messages.find(
      (m) => m.role === 'tool' && m.toolName === 'agent-narration',
    );
    if (narration === undefined) return [];
    return (JSON.parse(narration.content) as string[]).flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return typeof parsed === 'object' && parsed !== null
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  }

  /** The session record's executed-tool messages (role 'tool', excluding narration). */
  async function executedToolMessages(
    scratchDir: string,
    sessionId: string | undefined,
  ): Promise<string[]> {
    const record = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(sessionId as string);
    return (record?.messages ?? [])
      .filter((m) => m.role === 'tool' && m.toolName !== 'agent-narration')
      .map((m) => m.toolName ?? '');
  }

  test('init MISMATCH (an extra claude.ai connector server + its tools) → error, harness prefix, narration marker; no later frame is consumed', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      let handlerCalled = false;
      let framesAfterInit = 0;
      let generatorClosed = false;
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
              try {
                const surface = honestInitSurface(options);
                // A host that IGNORES the closing options: the account's
                // connector rides the worker's surface anyway.
                yield initFrame(options, {
                  session_id: 'agent-cli-leak',
                  tools: [...surface.tools, ...MOCK_CONNECTOR_TOOLS],
                  mcp_servers: [...surface.mcp_servers, MOCK_CONNECTOR_SERVER],
                });
                framesAfterInit += 1;
                const server = (options['mcpServers'] as Record<string, { tools?: MockSdkTool[] }>)[
                  'cq-harness'
                ];
                const runTool = server?.tools?.find((t) => t.name === 'run');
                yield {
                  type: 'assistant',
                  session_id: 'agent-cli-leak',
                  message: {
                    model: options['model'],
                    content: [
                      {
                        type: 'tool_use',
                        id: 'leak-1',
                        name: 'mcp__cq-harness__run',
                        input: { command: 'echo x > note.txt' },
                      },
                    ],
                    usage: AGENT_USAGE,
                  },
                };
                framesAfterInit += 1;
                handlerCalled = true;
                await runTool?.handler({ command: 'echo x > note.txt' }, undefined);
                yield {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  session_id: 'agent-cli-leak',
                  result: 'done',
                  usage: AGENT_USAGE,
                  permission_denials: [],
                };
              } finally {
                generatorClosed = true;
              }
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('init surface mismatch');
      expect(result.error).toContain('mcp__claude_ai_Gmail__send_message');
      // The loop broke on the init frame: the generator was returned
      // (closed) and never resumed — the later tool call never executed.
      expect(framesAfterInit).toBe(0);
      expect(handlerCalled).toBe(false);
      expect(generatorClosed).toBe(true);
      expect(await executedToolMessages(scratchDir, result.sessionId)).toEqual([]);
      const marker = (await narrationMarkers(scratchDir, result.sessionId)).find(
        (m) => m['cq'] === 'harness-surface-mismatch',
      );
      expect(marker).toMatchObject({
        cq: 'harness-surface-mismatch',
        errorClass: 'harness',
        expected: {
          mcp_servers: [{ name: 'cq-harness', status: 'connected' }],
          tools: [
            'mcp__cq-harness__bash',
            'mcp__cq-harness__edit',
            'mcp__cq-harness__read',
            'mcp__cq-harness__write',
          ],
        },
      });
      const observed = marker?.['observed'] as { mcp_servers: unknown; tools: string[] };
      expect(observed.mcp_servers).toContainEqual({ name: 'claude.ai Gmail', status: 'connected' });
      expect(observed.tools).toContain('mcp__claude_ai_Gmail__send_message');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the scripted mock with a tampered init: an extra server alone is a mismatch (tools exact)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({
            directive: {
              kind: 'tool-then-reply',
              tool: 'run',
              input: { command: 'echo x > note.txt' },
              reply: 'unused',
            },
            calls,
            tamperInit: (surface) => ({
              ...surface,
              mcp_servers: [...surface.mcp_servers, MOCK_CONNECTOR_SERVER],
            }),
          }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(await executedToolMessages(scratchDir, result.sessionId)).toEqual([]);
      expect(result.denials).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('MISSING harness server (status failed) → error with the harness prefix and marker', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            // A failed server contributes no tools and reports 'failed'.
            tamperInit: (surface) => ({
              tools: surface.tools.filter((t) => !t.startsWith('mcp__cq-harness__')),
              mcp_servers: surface.mcp_servers.map((server) => ({ ...server, status: 'failed' })),
            }),
          }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      const marker = (await narrationMarkers(scratchDir, result.sessionId)).find(
        (m) => m['cq'] === 'harness-surface-mismatch',
      );
      expect(marker).toMatchObject({
        errorClass: 'harness',
        expected: {
          mcp_servers: [{ name: 'cq-harness', status: 'connected' }],
          tools: ['mcp__cq-harness__read'],
        },
        observed: { mcp_servers: [{ name: 'cq-harness', status: 'failed' }], tools: [] },
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a harness tool the init frame does not list (only a subset connected) → mismatch', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            tamperInit: (surface) => ({
              ...surface,
              tools: surface.tools.filter((t) => t !== 'mcp__cq-harness__bash'),
            }),
          }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('MISSING init frame: a run with a result but no init → unverified harness error', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
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
              yield {
                type: 'assistant',
                session_id: 'agent-cli-noinit',
                message: {
                  model: options['model'],
                  content: [{ type: 'text', text: 'looks fine' }],
                  usage: AGENT_USAGE,
                },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: 'agent-cli-noinit',
                result: 'looks fine',
                usage: AGENT_USAGE,
                permission_denials: [],
                structured_output: { answer: 'ok' }, // schema-valid, but unverified
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({
          outputSchema: toOutputSchema(
            'test/unverified/v1',
            z.object({ answer: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('never reported its init surface');
      const markers = await narrationMarkers(scratchDir, result.sessionId);
      expect(markers).toContainEqual({ cq: 'harness-surface-unverified', errorClass: 'harness' });
      // A real measurement still rides the error verdict (usage is honest)…
      expect(result.usage).toEqual({ input: 120, output: 12, cacheRead: 15, cacheWrite: 5 });
      // …but the payload produced on an unverified surface never does (review r1).
      expect(result.structuredOutput).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
