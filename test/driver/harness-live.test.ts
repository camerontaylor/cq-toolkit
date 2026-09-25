// THE LIVE CONFORMANCE LEG (A10) — W1.4 subprocess closed tool surface.
//
// Opt-in only: runs when CQ_LIVE_CLI=1, against the REAL `claude` CLI on
// PATH and a real provider, through the BUILT package (`dist/index.js` —
// run `npm run build` first). Using dist is deliberate: it is the one path
// that exercises the production launch spec (`process.execPath` +
// `dist/harness/mcp/bin.js`), which the source-mode unit tests stub.
// CI never runs it (no CLI, no key); the recorded results live in
// docs/methods-w1-4.md (the A.5a–k verdict table).
//
// ISOLATION: run under a throwaway HOME so no ambient settings, MCP
// servers or connectors can leak in (the closed surface must hold on its
// own, but the leg should not depend on the operator's config either):
//   HOME=/tmp/cq-live-home CQ_LIVE_CLI=1 ZAI_API_KEY=… npx vitest run test/driver/harness-live.test.ts
// The route is the shipped `zai` endpoint (glm-4.5-air): a real route env
// (ANTHROPIC_AUTH_TOKEN) reaches the CLI, so the server's env scrub is
// exercised for real. Override the model with CQ_LIVE_MODEL.
//
// What it pins (driver-level, end to end):
//   - A10: under ToolPolicy mode 'none' the builtins are ABSENT — nothing
//     executes, the init surface verifies as empty, no config file is left;
//   - A10: Read/Bash-style attempts through the harness are DENIED with
//     harness-classified reasons ('path escape:' / 'command not allowed…');
//   - A.5a: --json-schema structured output survives --tools "" (with the
//     pinned StructuredOutput tool in the asserted surface);
//   - A.5f: harness denial text reaches WorkerResult.denials verbatim;
//   - A.5g: a sessionRef resume re-spawns the server on the same workspace;
//   - A.5k: the full pinned argv loads the harness, and `run` children do
//     not see the route's auth token (env scrub).
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

const LIVE = process.env['CQ_LIVE_CLI'] === '1';
const DIST_INDEX = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const MODEL = process.env['CQ_LIVE_MODEL'] ?? 'glm-4.5-air';
const TIMEOUT = 240_000;

interface LiveDriverModule {
  SubprocessDriver: new (options: Record<string, unknown>) => {
    run(invocation: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  SessionStore: new (sessionsDir: string) => {
    load(
      sessionId: string,
    ): Promise<
      { messages: Array<{ role: string; toolName?: string; content: string }> } | undefined
    >;
  };
  defaultHarnessConfig: Record<string, unknown>;
}

async function loadDist(): Promise<LiveDriverModule> {
  if (!existsSync(DIST_INDEX)) {
    throw new Error('live leg needs the built package: run `npm run build` first');
  }
  return (await import(DIST_INDEX)) as LiveDriverModule;
}

/** A harness config: read over the workspace, run limited to `commandPatterns`. */
function harnessConfig(commandPatterns: string[]): Record<string, unknown> {
  return {
    tools: {
      read: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 20_000 },
      edit: { enabled: true, pathPatterns: ['**/*'], maxOutputChars: 4_000 },
      run: { enabled: true, commandPatterns, timeoutMs: 30_000, maxOutputChars: 20_000 },
    },
    promptBudget: { maxSystemPromptChars: 20_000, maxTools: 3, maxToolDescriptionChars: 1_024 },
  };
}

function invocation(prompt: string, toolPolicy: Record<string, unknown>, sessionRef?: string) {
  return {
    prompt,
    modelSpec: { provider: 'zai', model: MODEL },
    toolPolicy,
    sandboxPolicy: { level: 'workspace-write' },
    budget: {},
    ...(sessionRef !== undefined ? { sessionRef } : {}),
  };
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-live-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** No per-run MCP config may outlive its run. */
async function mcpConfigsLeft(sessionsDir: string): Promise<string[]> {
  return (await readdir(sessionsDir)).filter((name) => name.endsWith('.cq-harness-mcp.json'));
}

function narrationOf(result: Record<string, unknown>): string {
  return JSON.stringify(result);
}

describe.skipIf(!LIVE)(
  'A10 live conformance leg — subprocess closed surface (real claude CLI)',
  () => {
    test(
      "mode 'none': builtins absent — nothing executes, the empty surface verifies",
      async () => {
        const { SubprocessDriver } = await loadDist();
        await withScratch(async (dir) => {
          const sessionsDir = join(dir, 'sessions');
          const driver = new SubprocessDriver({
            sessionsDir,
            harnessConfig: { ...harnessConfig(['whoami']), workspaceRoot: dir },
          });
          const result = await driver.run(
            invocation(
              'Use the Read tool to read /etc/hosts and the Bash tool to run whoami, then report both outputs.',
              { allow: [], mode: 'none' },
            ),
          );
          expect(result['stopReason']).toBe('complete');
          expect(narrationOf(result)).not.toContain('harness failure');
          expect(result['denials']).toEqual([]);
          expect(await mcpConfigsLeft(sessionsDir)).toEqual([]);
        });
      },
      TIMEOUT,
    );

    test(
      'Read/Bash-style attempts through the harness are denied with harness-classified reasons',
      async () => {
        const { SubprocessDriver } = await loadDist();
        await withScratch(async (dir) => {
          const sessionsDir = join(dir, 'sessions');
          const driver = new SubprocessDriver({
            sessionsDir,
            harnessConfig: { ...harnessConfig([]), workspaceRoot: dir },
          });
          const result = await driver.run(
            invocation(
              'Call the read tool with path "/etc/hosts". Then call the run tool with command "whoami". ' +
                'Report each tool result verbatim.',
              { allow: ['read', 'run'], mode: 'allowlist' },
            ),
          );
          expect(result['stopReason']).toBe('complete');
          const denials = result['denials'] as Array<{ tool: string; reason: string }>;
          expect(
            denials.some((d) => d.tool === 'read' && d.reason.startsWith('path escape:')),
          ).toBe(true);
          expect(
            denials.some(
              (d) =>
                d.tool === 'run' &&
                d.reason.startsWith('command not allowed by harness config allowlist:'),
            ),
          ).toBe(true);
          expect(await mcpConfigsLeft(sessionsDir)).toEqual([]);
        });
      },
      TIMEOUT,
    );

    test(
      'A.5a + A.5k: structured output survives --tools "", and run children never see the route token',
      async () => {
        const { SubprocessDriver } = await loadDist();
        await withScratch(async (dir) => {
          const sessionsDir = join(dir, 'sessions');
          const driver = new SubprocessDriver({
            sessionsDir,
            harnessConfig: { ...harnessConfig(['env']), workspaceRoot: dir },
            outputSchema: z.object({ tokenVisible: z.boolean() }).strict(),
          });
          const result = await driver.run(
            invocation(
              'Call the run tool with command "env". Set tokenVisible to true if its output contains ' +
                'the text ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY, else false.',
              { allow: ['run'], mode: 'allowlist' },
            ),
          );
          expect(result['stopReason']).toBe('complete');
          expect(result['denials']).toEqual([]);
          expect(result['structuredOutput']).toEqual({ tokenVisible: false });
          // The model's boolean is not the evidence: read the RAW `run`
          // output from the session record (the driver's execute-boundary
          // record) and assert on it directly.
          const { SessionStore } = await loadDist();
          const record = await new SessionStore(sessionsDir).load(result['sessionId'] as string);
          const runOutputs = (record?.messages ?? [])
            .filter((m) => m.role === 'tool' && m.toolName === 'run')
            .map((m) => (JSON.parse(m.content) as { output: string }).output);
          expect(runOutputs.length).toBeGreaterThan(0);
          expect(runOutputs.some((out) => /^PATH=/m.test(out))).toBe(true); // env really ran
          expect(runOutputs.join('\n')).not.toMatch(/ANTHROPIC_(AUTH_TOKEN|API_KEY)/);
        });
      },
      TIMEOUT,
    );

    test(
      'A.5g: a sessionRef resume re-spawns the server on the same workspace',
      async () => {
        const { SubprocessDriver } = await loadDist();
        await withScratch(async (dir) => {
          const sessionsDir = join(dir, 'sessions');
          const driver = new SubprocessDriver({
            sessionsDir,
            harnessConfig: { ...harnessConfig([]), workspaceRoot: dir },
            outputSchema: z.object({ marker: z.string() }).strict(),
          });
          const first = await driver.run(
            invocation('Reply with marker "none".', { allow: ['read'], mode: 'allowlist' }),
          );
          expect(first['stopReason']).toBe('complete');
          const sessionId = first['sessionId'] as string;
          const workspaces = (await readdir(dir)).filter((name) => name !== 'sessions');
          expect(workspaces.length).toBe(1);
          await writeFile(join(dir, workspaces[0] as string, 'resume.txt'), 'LIVE_RESUME_MARKER\n');
          const second = await driver.run(
            invocation(
              'Call the read tool with path "resume.txt" and set marker to its exact first line.',
              { allow: ['read'], mode: 'allowlist' },
              sessionId,
            ),
          );
          expect(second['stopReason']).toBe('complete');
          expect(second['structuredOutput']).toEqual({ marker: 'LIVE_RESUME_MARKER' });
          expect(await mcpConfigsLeft(sessionsDir)).toEqual([]);
        });
      },
      TIMEOUT * 2,
    );
  },
);
