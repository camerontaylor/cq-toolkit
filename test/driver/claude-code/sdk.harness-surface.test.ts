// The claude-code SDK's harness-surface adapters, exercised directly: the
// native MCP tool-call adapter installed over a real @modelcontextprotocol/sdk
// server (canonical tool keys, strict raw-shape validation), and the harness
// tool boundary honoring a wired cancellation signal (W1.4 review cycle 1).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  installNativeToolCallAdapter,
  runHarnessTool,
} from '../../../src/driver/claude-code/sdk.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { SessionStore } from '../../../src/harness/session.js';
import { buildManifest, createHarnessSurface } from '../../../src/harness/surface.js';

test('native MCP registration advertises canonical keys while raw legacy calls reach strict validation', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cq-native-alias-')));
  const server = new McpServer({ name: 'cq-harness', version: 'test' });
  const client = new Client({ name: 'native-fixture', version: 'test' });
  try {
    await writeFile(join(dir, 'a.txt'), 'alpha');
    const manifest = await buildManifest({
      workspace: dir,
      sandbox: 'workspace-write',
      toolPolicy: { allow: ['read', 'run'], mode: 'allowlist' },
      harness: defaultHarnessConfig,
    });
    if (manifest === undefined) throw new Error('expected a manifest');
    const surface = createHarnessSurface(manifest);
    expect(() => installNativeToolCallAdapter({ instance: {} }, surface, async () => ({}))).toThrow(
      /lacks the tools\/call request-handler seam/,
    );
    for (const tool of surface.tools) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async () => {
          throw new Error('SDK raw-shape handler must be intercepted');
        },
      );
    }
    installNativeToolCallAdapter(
      { instance: server },
      surface,
      async (name, args) => (await surface.call(name, args)).result,
    );
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['read', 'bash']);
    const read = listed.tools.find((tool) => tool.name === 'read');
    expect(read?.inputSchema.required).toEqual(['file_path']);
    expect(read?.inputSchema.additionalProperties).toBe(false);
    expect(read?.inputSchema.properties).not.toHaveProperty('path');
    expect(
      (await client.callTool({ name: 'read', arguments: { path: 'a.txt' } })).isError,
    ).not.toBe(true);
    expect(
      (await client.callTool({ name: 'read', arguments: { file_path: 'a.txt', path: 'a.txt' } }))
        .isError,
    ).not.toBe(true);
    const conflict = await client.callTool({
      name: 'read',
      arguments: { file_path: 'a.txt', path: 'b.txt' },
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.content)).toContain('conflicting aliases');
    const unsupported = await client.callTool({
      name: 'read',
      arguments: { path: 'a.txt', extra: true },
    });
    expect(unsupported.isError).toBe(true);
    const aliasName = await client.callTool({ name: 'run', arguments: { command: 'echo x' } });
    expect(aliasName.isError).toBe(true);
    expect(JSON.stringify(aliasName.content)).toContain('CMD_DENIED');
    const unserved = await client.callTool({
      name: 'write',
      arguments: { file_path: 'a.txt', content: 'x' },
    });
    expect(unserved.isError).toBe(true);
    expect(JSON.stringify(unserved.content)).toContain('UNKNOWN_TOOL');
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('claude-agent harness calls are cancellable (W1.4 review cycle 1)', () => {
  test.skipIf(process.platform === 'win32')(
    'runHarnessTool forwards the signal: an abort kills a running `run` command group',
    async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'cq-ca-cancel-')));
      try {
        const workspace = join(dir, 'ws');
        await mkdir(workspace);
        const manifest = await buildManifest({
          workspace,
          sandbox: 'none',
          toolPolicy: { allow: ['run'], mode: 'allowlist' },
          harness: {
            ...defaultHarnessConfig,
            tools: {
              ...defaultHarnessConfig.tools,
              bash: { enabled: true, commandPatterns: ['sleep'], timeoutMs: 60_000 },
            },
          },
        });
        if (manifest === undefined) throw new Error('expected a manifest');
        const surface = createHarnessSurface(manifest);
        const store = new SessionStore(join(dir, 'sessions'));
        const record = await store.create(workspace);
        const denials: Array<{ tool: string; reason: string }> = [];
        const cancel = new AbortController();
        const started = Date.now();
        const pending = runHarnessTool(
          surface,
          'run',
          { command: 'sleep 30' },
          store,
          record,
          denials,
          cancel.signal,
        );
        setTimeout(() => cancel.abort(), 300);
        const result = await pending;
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(result.isError).toBeUndefined();
        expect(result.content?.[0]?.text).toContain('killed by signal');
        expect(denials).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
