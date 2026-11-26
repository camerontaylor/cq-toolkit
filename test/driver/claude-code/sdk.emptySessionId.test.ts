// A result frame carrying `session_id: ''` must not replace the id an earlier
// frame reported: the empty value would fail the WorkerResult non-empty schema.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import {
  AGENT_USAGE,
  conformanceEndpointTable,
  conformanceHarnessConfig,
  initFrame,
  invocation,
  mockAdapters,
} from './sdk.helpers.js';

describe('claude-code sdk: empty native session id', () => {
  test('an empty result-frame session_id keeps the earlier native id', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-emptyid-'));
    try {
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              yield initFrame(options, { session_id: 'agent-cli-init' });
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: 'done',
                session_id: '',
                usage: AGENT_USAGE,
              };
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(result.nativeSessionId).toBe('agent-cli-init');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
