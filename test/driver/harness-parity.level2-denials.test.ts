// Split provenance: test/driver/harness-parity.test.ts was split by subject; this
// file holds the LEVEL 2 WorkerResult.denials parity test and the fake-CLI
// subprocess lane it drives. The shared config, fixtures and the other paths'
// drivers live in harness-parity.helpers.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeDriver } from '../../src/driver/claude-code/index.js';
import { RoutingTableSchema } from '../../src/driver/claude-code/routing.js';
import type { SandboxLevel, ToolDenial, WorkerResult } from '../../src/driver/types.js';
import { qualifiedToolName } from '../../src/harness/surface.js';
import type { HarnessManifest, McpCallToolResult } from '../../src/harness/surface.js';
import type { ManagedChild, ProcessClose, SpawnOptions } from '../../src/shared/proc.js';
import { CONFORMANCE_MODEL, CONFORMANCE_PROVIDER } from '../../src/driver/conformance.js';
import {
  HARNESS,
  PHASES,
  claudeAgentPhase,
  corePhase,
  manifestFor,
  seededSession,
  type Step,
} from './harness-parity.helpers.js';

// ---------------------------------------------------------------------------
// The subprocess lane: a real ClaudeCodeDriver over a fake CLI child
// ---------------------------------------------------------------------------

const SUBPROCESS_ROUTES = RoutingTableSchema.parse({
  endpoints: {
    [CONFORMANCE_PROVIDER]: {
      baseUrlEnv: 'CONFORMANCE_BASE_URL',
      baseUrlDefault: 'http://127.0.0.1:1/anthropic',
      keyEnv: 'CONFORMANCE_API_KEY',
      models: [CONFORMANCE_MODEL],
      notes: 'parity test endpoint: the fake CLI child is the model; never contacted',
    },
  },
});

/** A ManagedChild that emits `lines` on stdout (after the driver subscribed), then exits 0. */
function fakeCliChild(lines: readonly string[]): ManagedChild {
  const stdoutListeners: Array<(line: string) => void> = [];
  let exited = false;
  let settle: (close: ProcessClose) => void = () => undefined;
  const close = new Promise<ProcessClose>((resolve) => {
    settle = resolve;
  });
  // A macrotask: the driver subscribes synchronously right after spawn.
  setTimeout(() => {
    for (const line of lines) for (const listener of stdoutListeners) listener(line);
    exited = true;
    settle({ code: 0, signal: null, stdout: '', stderr: '', droppedBytes: 0 });
  }, 0);
  return {
    pid: 4242,
    close,
    get exited() {
      return exited;
    },
    onStdoutLine: (listener) => {
      stdoutListeners.push(listener);
    },
    onStderrLine: () => undefined,
    writeStdin: () => undefined,
    endStdin: () => undefined,
    kill: () => false,
  };
}

/** The value following `flag` in an argv. */
function argAfter(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * Realistic stream-json for the scripted calls, built from the REFERENCE
 * CallToolResults: an init frame derived from the driver's per-run MCP
 * config (the server it names, the tools its manifest serves — what the CLI
 * would list after `tools/list`), then per call an assistant tool_use
 * (qualified name) and the user-envelope tool_result exactly as the CLI
 * relays an MCP result (success → text-block array; error → the text as a
 * plain string with is_error: true), then a success result.
 */
function streamJsonFor(
  manifest: HarnessManifest,
  serverNames: string[],
  steps: readonly Step[],
  results: readonly McpCallToolResult[],
): string[] {
  const sessionId = 'cli-parity';
  const lines: unknown[] = [
    {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: CONFORMANCE_MODEL,
      tools: manifest.tools.map(qualifiedToolName),
      mcp_servers: serverNames.map((name) => ({ name, status: 'connected' })),
    },
  ];
  steps.forEach((step, i) => {
    const result = results[i];
    if (result === undefined) throw new Error(`no reference result for step ${i}`);
    const id = `toolu_${i + 1}`;
    lines.push({
      type: 'assistant',
      session_id: sessionId,
      message: {
        model: CONFORMANCE_MODEL,
        content: [{ type: 'tool_use', id, name: qualifiedToolName(step.tool), input: step.input }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const text = result.content.map((block) => block.text).join('');
    lines.push({
      type: 'user',
      session_id: sessionId,
      message: {
        role: 'user',
        content: [
          result.isError === true
            ? { type: 'tool_result', tool_use_id: id, content: text, is_error: true }
            : { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] },
        ],
      },
    });
  });
  lines.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    model: CONFORMANCE_MODEL,
    result: 'done',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  return lines.map((line) => JSON.stringify(line));
}

/** Run a real ClaudeCodeDriver over one phase with the fake CLI child. */
async function subprocessPhase(
  sandbox: SandboxLevel,
  steps: readonly Step[],
  referenceResults: readonly McpCallToolResult[],
): Promise<{ verdict: WorkerResult; manifest: HarnessManifest | undefined; workspace: string }> {
  const session = await seededSession(`subprocess-${sandbox}`);
  let seenManifest: HarnessManifest | undefined;
  const driver = new ClaudeCodeDriver({
    binary: 'fake-claude',
    routingTable: SUBPROCESS_ROUTES,
    sessionsDir: session.sessionsDir,
    harnessConfig: HARNESS,
    spawn: (opts: SpawnOptions): ManagedChild => {
      // The per-run MCP config exists NOW (the driver deletes it once init
      // reports the server connected) — read the driver-authored manifest
      // from the server's argv, as the CLI would launch it.
      const configPath = argAfter(opts.args, '--mcp-config');
      if (configPath === undefined) throw new Error('fake CLI: no --mcp-config');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers: Record<string, { args: string[] }>;
      };
      const serverArgs = config.mcpServers['cq-harness']?.args ?? [];
      const manifest = JSON.parse(serverArgs[serverArgs.length - 1] ?? 'null') as HarnessManifest;
      seenManifest = manifest;
      return fakeCliChild(
        streamJsonFor(manifest, Object.keys(config.mcpServers), steps, referenceResults),
      );
    },
  });
  const verdict = await driver.run({
    prompt: 'parity run',
    modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: sandbox },
    budget: {},
    sessionRef: session.sessionId,
  });
  return { verdict, manifest: seenManifest, workspace: session.workspace };
}
// ---------------------------------------------------------------------------
// LEVEL 2 — WorkerResult.denials parity
// ---------------------------------------------------------------------------

describe('harness parity — Level 2: WorkerResult.denials (claude-agent fold ≡ subprocess fold)', () => {
  test('both lanes report the identical {tool, reason} list for the same sequence', async () => {
    const agentDenials: ToolDenial[] = [];
    const subprocessDenials: ToolDenial[] = [];
    const referenceDenials: ToolDenial[] = [];
    for (const phase of PHASES) {
      const core = await corePhase(phase.sandbox, phase.steps);
      referenceDenials.push(...core.denials);

      const agent = await claudeAgentPhase(phase.sandbox, phase.steps);
      expect(agent.verdict.stopReason).toBe('complete');
      agentDenials.push(...agent.verdict.denials);

      const sub = await subprocessPhase(phase.sandbox, phase.steps, core.results);
      expect(sub.verdict.stopReason, sub.verdict.error).toBe('complete');
      expect(sub.verdict.error).toBeUndefined();
      subprocessDenials.push(...sub.verdict.denials);
      // The subprocess lane bound the SAME manifest (modulo its own workspace).
      expect(sub.manifest).toEqual({
        ...(await manifestFor(sub.workspace, phase.sandbox)),
        workspace: sub.workspace,
      });
    }

    // Frozen shape: exactly {tool, reason}, harness names.
    for (const denial of [...agentDenials, ...subprocessDenials]) {
      expect(Object.keys(denial).sort()).toEqual(['reason', 'tool']);
      expect(['read', 'edit', 'bash']).toContain(denial.tool);
    }
    expect(agentDenials).toEqual(referenceDenials);
    expect(subprocessDenials).toEqual(referenceDenials);
    expect(JSON.stringify(subprocessDenials)).toBe(JSON.stringify(agentDenials));
    // Non-vacuous: every denial class in the sequence is present.
    expect(referenceDenials.map((d) => d.tool)).toEqual([
      'read',
      'read',
      'edit',
      'read',
      'bash',
      'bash',
      'edit',
      'bash',
    ]);
  }, 60_000);
});
