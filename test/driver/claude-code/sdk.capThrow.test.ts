// A dispatch throw after a cap frame (max turns / max budget) stays a budget
// stop; after a success frame it is still an honest error.
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

const throwingDriver = (scratchDir: string, result: Record<string, unknown>) =>
  new ClaudeCodeDriver({
    transport: 'sdk',
    sdkLoader: async () => ({
      ...mockAdapters,
      query: ({ options }: { options: Record<string, unknown> }): AsyncGenerator<unknown, void> =>
        (async function* () {
          yield initFrame(options);
          yield { type: 'result', session_id: 'agent-cli-cap', usage: AGENT_USAGE, ...result };
          throw new Error('stream closed after the result frame');
        })(),
    }),
    routingTable: conformanceEndpointTable(),
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(scratchDir),
  });

describe('claude-code sdk: dispatch throw after a result frame', () => {
  test.each([
    ['error_max_turns', true, 'budget'],
    ['error_max_budget_usd', true, 'budget'],
    ['success', false, 'error'],
  ] as const)(
    '%s then a throw settles as the expected stop',
    async (subtype, isError, expected) => {
      const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-capthrow-'));
      try {
        const driver = throwingDriver(scratchDir, { subtype, is_error: isError, result: 'done' });
        const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
        expect(result.stopReason).toBe(expected);
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );
});
