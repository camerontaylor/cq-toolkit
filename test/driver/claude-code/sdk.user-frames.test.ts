// claude-code SDK transport specifics (mock sdk): foldMessage over SDK user
// frames — tool_result deliveries fold into our vocabulary (never narrated
// as raw vendor frame JSON), TEXT-bearing frames are narrated as unusual
// evidence, malformed frames are dropped, and junk frames never crash the
// fold.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { foldMessage } from '../../../src/driver/claude-code/sdk.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { SessionStore } from '../../../src/harness/session.js';
import {
  AGENT_USAGE,
  conformanceEndpointTable,
  conformanceHarnessConfig,
  initFrame,
  invocation,
  mockAdapters,
} from './sdk.helpers.js';

describe('claude-code sdk transport specifics (mock sdk)', () => {
  test('foldMessage drops SDK user frames: tool outcomes live in our vocabulary, narration carries no vendor frame JSON', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      // A scripted round WITH a tool call: assistant tool_use → the
      // registered harness tool executes in-process → an SDKUserMessage
      // (type 'user') delivering the tool_result → success result. The
      // execute boundary records the outcome in OUR vocabulary; the user
      // frame must be dropped, not narrated as raw vendor JSON.
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
              const sessionId = 'agent-cli-userframe';
              const model = options['model'] as string;
              yield initFrame(options, { session_id: sessionId, model });
              const server = (
                options['mcpServers'] as
                  | Record<
                      string,
                      {
                        tools?: Array<{
                          name: string;
                          handler: (args: unknown, extra: unknown) => Promise<unknown>;
                        }>;
                      }
                    >
                  | undefined
              )?.['cq-harness'];
              const toolRecord = server?.tools?.find((t) => t.name === 'read');
              yield {
                type: 'assistant',
                session_id: sessionId,
                message: {
                  model,
                  content: [
                    {
                      type: 'tool_use',
                      id: 'u1',
                      name: 'mcp__cq-harness__read',
                      input: { path: 'absent.txt' },
                    },
                  ],
                  usage: AGENT_USAGE,
                },
              };
              await toolRecord?.handler({ path: 'absent.txt' }, undefined);
              // The frame under test: an SDK user-role tool_result delivery.
              yield {
                type: 'user',
                session_id: sessionId,
                message: {
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: 'u1',
                      content: [{ type: 'text', text: 'file body' }],
                    },
                  ],
                },
              };
              yield {
                type: 'assistant',
                session_id: sessionId,
                message: { model, content: [{ type: 'text', text: 'done' }], usage: AGENT_USAGE },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: sessionId,
                result: 'done',
                usage: AGENT_USAGE,
                modelUsage: {},
                permission_denials: [],
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: [], mode: 'unrestricted' } }),
      );
      expect(result.stopReason).toBe('complete');
      const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
      const record = await store.load(result.sessionId as string);
      expect(record).toBeDefined();
      // The tool outcome IS recorded — in OUR vocabulary, at the execute
      // boundary (the read executed and was denied on the merits).
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(true);
      // The user frame did NOT become narration: no narration message at
      // all (every frame in this stream is folded), hence no raw
      // vendor 'tool_result' JSON in persisted session data.
      const narration = record?.messages.find(
        (m) => m.role === 'tool' && m.toolName === 'agent-narration',
      );
      expect(narration).toBeUndefined();
      expect(
        record?.messages.some((m) => m.role === 'tool' && m.content.includes('tool_result')),
      ).toBe(false);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a TEXT-bearing SDK user frame is narrated (unusual evidence, never silently dropped)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const unusualText = 'cq-unusual-user-text-evidence';
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
              const sessionId = 'agent-cli-usertext';
              const model = options['model'] as string;
              yield initFrame(options, { session_id: sessionId, model });
              // The frame under test: a user frame whose MessageParam
              // content carries an ordinary TEXT block — the normal flow
              // never emits one.
              yield {
                type: 'user',
                session_id: sessionId,
                message: {
                  role: 'user',
                  content: [{ type: 'text', text: unusualText }],
                },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: sessionId,
                result: 'done',
                usage: AGENT_USAGE,
                modelUsage: {},
                permission_denials: [],
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
      const record = await store.load(result.sessionId as string);
      expect(record).toBeDefined();
      const narration = record?.messages.find(
        (m) => m.role === 'tool' && m.toolName === 'agent-narration',
      );
      expect(narration).toBeDefined(); // the unusual frame is preserved as evidence
      expect(narration?.content).toContain(unusualText); // our vocabulary: the text is IN the narration
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a MALFORMED SDK user frame (message not a record) is dropped — the subprocess lane drop-if-unshapeable posture', async () => {
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
              const sessionId = 'agent-cli-userjunk';
              const model = options['model'] as string;
              yield initFrame(options, { session_id: sessionId, model });
              // Malformed: message is a string, not a record — nothing
              // shapeable to fold (subprocess lane: content undefined →
              // return). Dropped, not narrated, never a crash.
              yield { type: 'user', session_id: sessionId, message: 'garbage-not-a-record' };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: sessionId,
                result: 'done',
                usage: AGENT_USAGE,
                modelUsage: {},
                permission_denials: [],
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
      const record = await store.load(result.sessionId as string);
      expect(record).toBeDefined();
      // Dropped silently (no narration for an unshapeable user frame), and
      // the run settled honestly regardless.
      expect(
        record?.messages.some((m) => m.role === 'tool' && m.toolName === 'agent-narration'),
      ).toBe(false);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('foldMessage: init/assistant/result fold; junk frames become narration, never crashes', () => {
    const observation = {
      agentSessionId: undefined as string | undefined,
      servedModel: undefined as string | undefined,
      transcript: [] as string[],
      narration: [] as string[],
      assistantUsage: undefined,
      result: undefined,
      error: undefined as string | undefined,
      caughtCause: undefined as string | undefined,
      errorKind: undefined as 'dispatch-threw' | 'result-frame' | undefined,
      assistantRateLimit: false,
      deniedToolUseIds: new Set<string>(),
      denials: [],
      expectedSurface: undefined,
      initSeen: false,
      harnessFailure: undefined,
      refusalSeen: false,
    };
    foldMessage(observation, 'not even an object');
    foldMessage(observation, { type: 'system', subtype: 'init', session_id: 's1', model: 'm-1' });
    foldMessage(observation, {
      type: 'assistant',
      session_id: 's1',
      message: {
        model: 'm-2',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    foldMessage(observation, { type: 'system', subtype: 'something-new', payload: 'evidence' });
    foldMessage(observation, {
      type: 'result',
      session_id: 's1',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 3 },
    });
    expect(observation.agentSessionId).toBe('s1');
    // The RESPONSE-reported id (m-2) wins over the init-reported one (m-1).
    expect(observation.servedModel).toBe('m-2');
    expect(observation.transcript).toEqual(['hi']);
    expect(observation.assistantUsage).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(observation.narration).toHaveLength(2); // the string + the unknown subtype
    expect(observation.result?.['subtype']).toBe('success');
  });
});
