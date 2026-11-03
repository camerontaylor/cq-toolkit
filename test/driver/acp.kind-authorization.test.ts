import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { driverOptions, invocation, withScratch } from './acp.helpers.js';

describe('acp driver specifics (fake ACP server)', () => {
  test.each(['execute', ' EXECUTE '])(
    'ACP kind %s authorizes toolkit run and persists its canonical identity',
    async (kind) => {
      await withScratch(async (scratchDir, store) => {
        const driver = new AcpDriver(
          driverOptions(
            scratchDir,
            {
              FAKE_ACP_MODE: 'tool-then-reply',
              FAKE_ACP_TOOL: 'run',
              FAKE_ACP_TOOL_KIND: kind,
              FAKE_ACP_INPUT: JSON.stringify({ command: 'echo canonical-run > allowed.txt' }),
            },
            [],
          ),
        );
        const result = await driver.run(
          invocation({
            prompt: 'canonical run permission',
            toolPolicy: { allow: ['run'], mode: 'allowlist' },
          }),
        );
        expect(result.stopReason).toBe('complete');
        expect(result.toolFailures).toBe(0);
        expect(result.denials).toEqual([]);
        const record = await store.load(result.sessionId as string);
        expect(await readFile(join(record?.workspace as string, 'allowed.txt'), 'utf8')).toContain(
          'canonical-run',
        );
        expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'run')).toBe(true);
      });
    },
  );

  test.each([undefined, '', '  '])(
    'missing ACP kind %s denies even when its call ID and title match grants',
    async (kind) => {
      await withScratch(async (scratchDir, store) => {
        const driver = new AcpDriver(
          driverOptions(
            scratchDir,
            {
              FAKE_ACP_MODE: 'tool-then-reply',
              FAKE_ACP_TOOL: 'run',
              FAKE_ACP_TOOL_CALL_ID: 'run',
              ...(kind === undefined ? {} : { FAKE_ACP_TOOL_KIND: kind }),
              FAKE_ACP_INPUT: JSON.stringify({ command: 'echo escaped > forbidden.txt' }),
            },
            [],
          ),
        );
        const result = await driver.run(
          invocation({
            prompt: 'missing kind cannot authorize',
            // Omitted mode is also allowlist. Even 'unknown' cannot bless an absent kind.
            toolPolicy: { allow: ['run', 'unknown'] },
          }),
        );
        expect(result.stopReason).toBe('complete');
        expect(result.denials).toEqual([
          {
            tool: 'unknown',
            reason: 'tool policy: missing ACP tool kind; cannot enforce allowlist',
          },
        ]);
        const record = await store.load(result.sessionId as string);
        await expect(
          readFile(join(record?.workspace as string, 'forbidden.txt'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(record?.messages.some((m) => m.role === 'tool')).toBe(false);
      });
    },
  );

  test('ACP execute kind still denies when only read is allowlisted', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new AcpDriver(
        driverOptions(
          scratchDir,
          {
            FAKE_ACP_MODE: 'tool-then-reply',
            FAKE_ACP_TOOL: 'run',
            FAKE_ACP_TOOL_KIND: 'execute',
            FAKE_ACP_INPUT: JSON.stringify({ command: 'echo escaped > forbidden.txt' }),
          },
          [],
        ),
      );
      const result = await driver.run(
        invocation({
          prompt: 'canonical identity still needs a grant',
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
        }),
      );
      expect(result.denials).toEqual([
        {
          tool: 'run',
          reason: 'tool policy: not allowlisted (kind execute)',
        },
      ]);
      const record = await store.load(result.sessionId as string);
      await expect(
        readFile(join(record?.workspace as string, 'forbidden.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
