// Exercise the optional Agent SDK's real tool() → createSdkMcpServer() path.
// The peer is absent in the default install; a peer-present lane runs this
// proof without a provider, CLI, credential, or network connection.
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, test } from 'vitest';
import { installNativeToolCallAdapter } from '../../../src/driver/claude-code/sdk.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { buildManifest, createHarnessSurface } from '../../../src/harness/surface.js';

const sdkPackage = '@anthropic-ai/claude-agent-sdk';
const peerPresent = (() => {
  try {
    createRequire(import.meta.url).resolve(sdkPackage);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') return false;
    throw error;
  }
})();

test.skipIf(!peerPresent)(
  'real Agent SDK wrapper preserves canonical list and strict legacy calls',
  async () => {
    // A variable specifier keeps the optional peer out of the default install's
    // static dependency graph. Resolution above skips only genuine absence.
    const sdk: unknown = await import(sdkPackage);
    if (
      typeof sdk !== 'object' ||
      sdk === null ||
      !('tool' in sdk) ||
      typeof sdk.tool !== 'function' ||
      !('createSdkMcpServer' in sdk) ||
      typeof sdk.createSdkMcpServer !== 'function'
    ) {
      throw new Error('Agent SDK does not export its public MCP tool wrapper');
    }
    const sdkTool = sdk.tool as (
      name: string,
      description: string,
      shape: unknown,
      handler: (args: unknown, extra: unknown) => Promise<unknown>,
    ) => unknown;
    const createSdkMcpServer = sdk.createSdkMcpServer as (options: {
      name: string;
      tools: unknown[];
    }) => unknown;

    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cq-sdk-wrapper-')));
    const client = new Client({ name: 'sdk-wrapper-proof', version: 'test' });
    let server: McpServer | undefined;
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha');
      const manifest = await buildManifest({
        workspace: dir,
        sandbox: 'workspace-write',
        toolPolicy: { allow: ['read', 'run'], mode: 'allowlist' },
        harness: defaultHarnessConfig,
      });
      if (manifest === undefined) throw new Error('expected selected harness tools');
      const surface = createHarnessSurface(manifest);
      const definitions = surface.tools.map((tool) => {
        const definition: unknown = sdkTool(
          tool.name,
          tool.description,
          tool.inputSchema.shape,
          async () => {
            throw new Error('SDK handler ran before the raw-call adapter');
          },
        );
        if (typeof definition !== 'object' || definition === null) {
          throw new Error('Agent SDK tool() returned an invalid definition');
        }
        // Match the production registration: SDK tool() accepts a raw shape,
        // while MCP registerTool accepts the canonical strict Zod object.
        return { ...definition, inputSchema: tool.inputSchema };
      });
      const config: unknown = createSdkMcpServer({ name: 'cq-harness', tools: definitions });
      installNativeToolCallAdapter(
        config,
        surface,
        async (name, args) => (await surface.call(name, args)).result,
      );
      if (typeof config !== 'object' || config === null || !('instance' in config)) {
        throw new Error('Agent SDK wrapper did not return an MCP server instance');
      }
      const instance: unknown = config.instance;
      if (
        typeof instance !== 'object' ||
        instance === null ||
        !('connect' in instance) ||
        typeof instance.connect !== 'function' ||
        !('close' in instance) ||
        typeof instance.close !== 'function'
      ) {
        throw new Error('Agent SDK wrapper returned an unusable MCP server instance');
      }
      server = instance as McpServer;
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['read', 'bash']);
      const read = listed.tools.find((tool) => tool.name === 'read');
      expect(read?.inputSchema.required).toEqual(['file_path']);
      expect(read?.inputSchema.additionalProperties).toBe(false);
      expect(read?.inputSchema.properties).not.toHaveProperty('path');
      const bash = listed.tools.find((tool) => tool.name === 'bash');
      expect(bash?.inputSchema.required).toEqual(['command']);
      expect(bash?.inputSchema.additionalProperties).toBe(false);
      expect(
        (await client.callTool({ name: 'read', arguments: { path: 'a.txt' } })).isError,
      ).not.toBe(true);
      const conflict = await client.callTool({
        name: 'read',
        arguments: { file_path: 'a.txt', path: 'b.txt' },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.stringify(conflict.content)).toContain('conflicting aliases');
      const unknownField = await client.callTool({
        name: 'read',
        arguments: { path: 'a.txt', extra: true },
      });
      expect(unknownField.isError).toBe(true);
      const legacyName = await client.callTool({ name: 'run', arguments: { command: 'echo x' } });
      expect(legacyName.isError).toBe(true);
      expect(JSON.stringify(legacyName.content)).toContain('CMD_DENIED');
      const unserved = await client.callTool({
        name: 'write',
        arguments: { file_path: 'a.txt', content: 'x' },
      });
      expect(unserved.isError).toBe(true);
      expect(JSON.stringify(unserved.content)).toContain('UNKNOWN_TOOL');
    } finally {
      await client.close();
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
