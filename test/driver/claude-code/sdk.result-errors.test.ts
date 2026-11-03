// claude-code SDK transport specifics (mock sdk): error-verdict causes —
// the #204 result-frame cause derivation (errors array, result string,
// subtype fallback, query throws, missing result events) and abort-verdict
// alignment for a query that settles cleanly after the governed signal has
// fired.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { runLadder } from '../../../src/kernel/governor.js';
import {
  AGENT_USAGE,
  conformanceEndpointTable,
  conformanceHarnessConfig,
  initFrame,
  invocation,
  mockAdapters,
} from './sdk.helpers.js';

describe('claude-code sdk transport specifics (mock sdk)', () => {
  test('a failed result frame derives its cause from the errors array (#204)', async () => {
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
              yield initFrame(options, { session_id: 'agent-cli-err' });
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                session_id: 'agent-cli-err',
                usage: AGENT_USAGE,
                errors: ['boom one', 'boom two'],
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('provider-error');
      expect(result.error).toContain('boom one; boom two');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a failed result frame prefers the result string over the errors array (#204)', async () => {
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
              yield initFrame(options, { session_id: 'agent-cli-err' });
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                session_id: 'agent-cli-err',
                usage: AGENT_USAGE,
                result: 'boom from result string',
                errors: ['ignored'],
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('provider-error');
      expect(result.error).toContain('boom from result string');
      expect(result.error).not.toContain('ignored');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a failed result frame with no text falls back to the subtype (#204)', async () => {
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
              yield initFrame(options, { session_id: 'agent-cli-err' });
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                session_id: 'agent-cli-err',
                usage: AGENT_USAGE,
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('provider-error');
      expect(result.error).toContain("subtype 'error_during_execution'");
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a query throw surfaces its cause on the error verdict (#204)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => ({
          ...mockAdapters,
          query: () => {
            throw new Error('sdk boundary exploded');
          },
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // A dispatch throw (spawn/exit/crash of the CLI) is a local failure.
      expect(result.errorClass).toBe('harness');
      expect(result.error).toContain('sdk boundary exploded');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a query that yields no result event says so on the error verdict (#204)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => ({
          ...mockAdapters,
          query: (): AsyncGenerator<unknown, void> => (async function* () {})(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // A silent death with no result event is a local (harness) failure.
      expect(result.errorClass).toBe('harness');
      expect(result.error).toContain('without a result event');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('abort-verdict alignment: a CLEANLY-settling query still verdicts aborted once the governed signal has fired', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      // A misbehaving agent that IGNORES the wired cancellation root: the
      // for-await loop settles cleanly (no abort-shaped throw), but ONLY
      // after the governed signal has actually fired (the generator waits
      // for the signal itself — deterministic under any machine load, no
      // fixed-sleep race). The mapping table says a fired governed signal →
      // 'aborted', so 'complete' would be a false verdict.
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
                await new Promise((resolve) => setTimeout(resolve, 10)); // a tick past the abort
              }
              yield initFrame(options, { session_id: 'agent-cli-clean' });
              yield {
                type: 'assistant',
                session_id: 'agent-cli-clean',
                message: {
                  model: options['model'],
                  content: [{ type: 'text', text: 'settled cleanly' }],
                  usage: AGENT_USAGE,
                },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: 'agent-cli-clean',
                result: 'settled cleanly',
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
      const outcome = await runLadder(
        async (ctx) => driver.run(invocation(), { signal: ctx.signal }),
        { wallClockMs: 20 },
        { op: 'claude-agent', jobKey: 'claude-agent', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return; // narrow for TS
      expect(outcome.value.stopReason).toBe('aborted');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
