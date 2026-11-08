// Split provenance: test/driver/harness-parity.test.ts was split by subject; this
// file holds the run child-environment parity legs (one env-probe command,
// compared across core, stdio and the claude-agent callback). The shared
// config, fixtures and path drivers live in harness-parity.helpers.ts.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, test, vi } from 'vitest';
import type { HarnessConfig } from '../../src/harness/config.js';
import { buildManifest, createHarnessSurface } from '../../src/harness/surface.js';
import type { McpCallToolResult } from '../../src/harness/surface.js';
import {
  HARNESS,
  claudeAgentPhase,
  projectSdkResult,
  seededWorkspace,
  stdioClient,
} from './harness-parity.helpers.js';

const ENV_BLOCKED_FIELDS = [
  'GH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'CONFORMANCE_API_KEY',
  'CQ_SANDBOX',
  'CQ_RUN_ENV_PASSTHROUGH',
] as const;
/** Print one named benign value and Boolean presence for named blocked fields. */
const ENV_PROBE_CHECKS = ENV_BLOCKED_FIELDS.map((name) => `Boolean(process.env.${name})`).join(',');
const ENV_PROBE_COMMAND = [
  "node -p 'JSON.stringify({",
  'canary:process.env.PARITY_BENIGN_CANARY??null,',
  `blocked:[${ENV_PROBE_CHECKS}]})'`,
].join('');
const ENV_PROBE_PATTERN = `re:^${ENV_PROBE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

const ENV_HARNESS: HarnessConfig = {
  ...HARNESS,
  tools: {
    ...HARNESS.tools,
    bash: { ...HARNESS.tools.bash, commandPatterns: [ENV_PROBE_PATTERN] },
  },
};
describe('harness parity — run child environment', () => {
  test.each(['default', 'explicit', 'configured'] as const)(
    '%s allowlist: named env probe matches core, stdio and claude-agent callbacks',
    async (mode) => {
      const canaryName = 'PARITY_BENIGN_CANARY';
      const canaryValue = 'parity-benign-value';
      const secretNames = ENV_BLOCKED_FIELDS.slice(0, 6);
      for (const name of secretNames) vi.stubEnv(name, `parity-fake-${name}`);
      vi.stubEnv(canaryName, canaryValue);
      vi.stubEnv('CQ_SANDBOX', 'off'); // These env legs explicitly exercise host run policy.
      vi.stubEnv('CQ_RUN_ENV_PASSTHROUGH', mode === 'configured' ? canaryName : '');
      const envAllowlist = mode === 'explicit' ? [canaryName] : [];
      let client: Client | undefined;
      try {
        const workspace = await seededWorkspace(`env-${mode}`);
        const manifest = await buildManifest({
          workspace,
          sandbox: 'workspace-write',
          toolPolicy: { mode: 'unrestricted', allow: [] },
          harness: ENV_HARNESS,
          envNames: envAllowlist,
        });
        if (manifest === undefined) throw new Error('run env manifest missing');
        const core = await createHarnessSurface(manifest).call('run', {
          command: ENV_PROBE_COMMAND,
        });
        // The real MCP server starts with the same host values, including
        // canary credentials; its startup and run executor must scrub them.
        const parentEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
        client = await stdioClient(manifest, parentEnv);
        const stdio = projectSdkResult(
          await client.callTool({ name: 'run', arguments: { command: ENV_PROBE_COMMAND } }),
        );
        const agent = await claudeAgentPhase(
          'workspace-write',
          [{ tool: 'run', input: { command: ENV_PROBE_COMMAND } }],
          { harnessConfig: ENV_HARNESS, envAllowlist, workspace },
        );
        expect(agent.verdict.stopReason, agent.verdict.error).toBe('complete');
        expect(agent.results).toHaveLength(1);
        const outputs = [core.result, stdio, agent.results[0] as McpCallToolResult].map(
          (result) => {
            expect(result.isError).toBeUndefined();
            const text = result.content.map((block) => block.text).join('');
            expect(text.startsWith('exit 0\n--- stdout ---\n')).toBe(true);
            return JSON.parse(text.slice('exit 0\n--- stdout ---\n'.length).trim()) as {
              canary: string | null;
              blocked: boolean[];
            };
          },
        );
        expect(outputs[1]).toEqual(outputs[0]);
        expect(outputs[2]).toEqual(outputs[0]);
        for (const output of outputs) {
          expect(output.blocked).toEqual(ENV_BLOCKED_FIELDS.map(() => false));
          expect(output.canary).toBe(mode === 'default' ? null : canaryValue);
        }
      } finally {
        await client?.close();
        vi.unstubAllEnvs();
      }
    },
    60_000,
  );
});
