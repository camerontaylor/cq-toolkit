// claude-code SDK transport specifics (mock sdk): dispatch validation and
// SDK-query option wiring — env scrubbing/named passthrough, the
// optional-peer and capability pre-dispatch throws, provider/key-env
// validation, verbatim model ids and observed-model surfacing, maxTurns,
// endpoint env injection, the tool-policy surface, the resume sidecar, and
// the pre-dispatch budget guard.
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import {
  RoutingTableSchema,
  defaultRoutingTable,
  resolveRoute,
} from '../../../src/driver/claude-code/routing.js';
import { CLI_SESSION_FILE } from '../../../src/driver/claude-code/sessions.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER } from '../../../src/driver/conformance.js';
import { DispatchError, errorClassOf } from '../../../src/driver/errors.js';
import { SessionStore } from '../../../src/harness/session.js';
import {
  conformanceEndpointTable,
  driverWithCalls,
  invocation,
  mockSdkModule,
  optionsOf,
  thrownBy,
} from './sdk.helpers.js';
import type { MockSdkTool } from './sdk.helpers.js';

describe('claude-code sdk transport specifics (mock sdk)', () => {
  test.each(['explicit', 'configured'])(
    'child env is scrubbed and passes through only %s named values',
    async (mode) => {
      const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-env-'));
      const secretName = 'CQ_CLAUDE_AGENT_SECRET_CANARY';
      const passthroughName = 'CLAUDE_AGENT_PASSTHROUGH_CANARY';
      const oldSecret = process.env[secretName];
      const oldPassthrough = process.env[passthroughName];
      const oldConfigured = process.env.CQ_RUN_ENV_PASSTHROUGH;
      process.env[secretName] = 'must-not-reach-sdk';
      process.env[passthroughName] = 'named-passthrough';
      process.env.CQ_RUN_ENV_PASSTHROUGH = mode === 'configured' ? passthroughName : '';
      const envAllowlist = mode === 'explicit' ? [passthroughName] : [];
      try {
        const { driver, calls } = driverWithCalls(scratchDir, {
          directive: { kind: 'reply', text: 'ok' },
          envAllowlist,
        });
        // Constructor snapshots the trusted declaration; caller mutation
        // cannot widen an already-built driver's process or tool surface.
        envAllowlist.push(secretName);
        await driver.run(invocation({ prompt: 'env canary' }));
        const env = optionsOf(calls)['env'] as Record<string, string>;
        expect(env[secretName]).toBeUndefined();
        expect(env[passthroughName]).toBe('named-passthrough');
      } finally {
        if (oldSecret === undefined) delete process.env[secretName];
        else process.env[secretName] = oldSecret;
        if (oldPassthrough === undefined) delete process.env[passthroughName];
        else process.env[passthroughName] = oldPassthrough;
        if (oldConfigured === undefined) delete process.env.CQ_RUN_ENV_PASSTHROUGH;
        else process.env.CQ_RUN_ENV_PASSTHROUGH = oldConfigured;
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );

  test.each(['BAD=VALUE', 'BAD NAME', '', 'BAD;NAME'])(
    'rejects invalid envAllowlist name %j before dispatch',
    (name) => {
      expect(() => new ClaudeCodeDriver({ transport: 'sdk', envAllowlist: [name] })).toThrow(
        /envAllowlist/,
      );
    },
  );

  test('peer ABSENT: a throwing loader throws pre-dispatch — before any session store mkdir', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const sessionsDir = join(scratchDir, 'sessions');
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => {
          throw new Error(`Cannot find package '${'@anthropic-ai/claude-agent-sdk'}'`);
        },
        routingTable: conformanceEndpointTable(),
        sessionsDir,
      });
      const err = await thrownBy(driver.run(invocation()));
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config'); // seam v2: pre-dispatch class
      expect((err as Error).message).toMatch(/optional peer dependency/);
      // The failure landed BEFORE any session existed: the store directory
      // was never even created (mkdir is the first store side effect).
      await expect(stat(sessionsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('peer PRESENT but surface-less: capability detection throws pre-dispatch (feature check, never a version check)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const sessionsDir = join(scratchDir, 'sessions');
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => ({ query: 'not a function', version: '9.9.9-fake' }),
        routingTable: conformanceEndpointTable(),
        sessionsDir,
      });
      const err = await thrownBy(driver.run(invocation()));
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config'); // a capability miss is config
      expect((err as Error).message).toMatch(/missing the driven surface/);
      await expect(
        readdir(sessionsDir).catch((err: NodeJS.ErrnoException) => err),
      ).resolves.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('unknown provider throws BEFORE dispatch — no session record is created', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver } = driverWithCalls(scratchDir);
      const err = await thrownBy(
        driver.run(invocation({ modelSpec: { provider: 'nope', model: 'm' } })),
      );
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config'); // seam v2: pre-dispatch class
      expect((err as Error).message).toMatch(/unknown provider 'nope'/);
      await expect(
        readdir(join(scratchDir, SESSIONS_DIR)).catch((err: NodeJS.ErrnoException) => err),
      ).resolves.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('missing endpoint key env throws BEFORE dispatch', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    const keyName = 'CQ_TEST_CLAUDE_AGENT_MISSING_KEY';
    const saved = process.env[keyName];
    delete process.env[keyName];
    try {
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => mockSdkModule({ calls: [] }),
        routingTable: RoutingTableSchema.parse({
          endpoints: {
            conformance: {
              baseUrlEnv: 'CONFORMANCE_BASE_URL',
              baseUrlDefault: 'http://127.0.0.1:1/anthropic',
              keyEnv: keyName,
              notes: 'key-less endpoint for the missing-key pre-dispatch test',
            },
          },
        }),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
      });
      const err = await thrownBy(driver.run(invocation()));
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config'); // a missing key env is config
      expect((err as Error).message).toMatch(new RegExp(keyName));
    } finally {
      if (saved !== undefined) process.env[keyName] = saved;
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('NO model allowlist: any model id dispatches verbatim — Options.model is untouched', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      const result = await driver.run(
        invocation({
          modelSpec: { provider: CONFORMANCE_PROVIDER, model: 'any-gateway-id-at-all' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(optionsOf(calls)['model']).toBe('any-gateway-id-at-all');
      // The observed-model defence still reports what the endpoint served.
      expect(result.model).toBe('any-gateway-id-at-all');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('observed-model surfacing: a SERVED id different from the requested id is surfaced, not hidden', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
        servedModel: 'gateway-default-served-instead',
      });
      const result = await driver.run(
        invocation({ modelSpec: { provider: CONFORMANCE_PROVIDER, model: 'what-we-asked-for' } }),
      );
      expect(result.model).toBe('gateway-default-served-instead');
      expect(result.model).not.toBe('what-we-asked-for'); // the remap is VISIBLE
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('Budget.maxSteps maps directly to the Agent SDK maxTurns option', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      const result = await driver.run(invocation({ budget: { maxSteps: 3 } }));
      expect(result.stopReason).toBe('complete');
      expect(optionsOf(calls)['maxTurns']).toBe(3);
      expect(result.steps).toBeUndefined(); // stream output cannot count completed SDK turns
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('endpoint env injection: base URL + auth values ride the SDK env; the governed surface is the only surface', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          sandboxPolicy: { level: 'workspace-write' },
        }),
      );
      const options = optionsOf(calls);
      const env = options['env'] as Record<string, string | undefined>;
      expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:1/anthropic'); // the endpoint default
      expect(env['ANTHROPIC_AUTH_TOKEN']).toBe(process.env['CONFORMANCE_API_KEY']);
      expect(env['ANTHROPIC_API_KEY']).toBe(process.env['CONFORMANCE_API_KEY']);
      // Built-ins always off; the allowlist surface is the whole surface.
      expect(options['tools']).toEqual([]);
      expect(options['allowedTools']).toEqual(['mcp__cq-harness__read']);
      expect(options['permissionMode']).toBe('default');
      const server = (options['mcpServers'] as Record<string, { tools: MockSdkTool[] }>)[
        'cq-harness'
      ];
      if (server === undefined) throw new Error('missing cq-harness server');
      expect(server.tools.map((t) => t.name)).toEqual(['read']);
      const registeredRead = server.tools[0];
      if (registeredRead === undefined) throw new Error('missing registered read tool');
      expect(z.toJSONSchema(registeredRead.inputSchema as ZodType).additionalProperties).toBe(
        false,
      );
      // workspace-write sandbox → the defense-in-depth option.
      expect(options['sandbox']).toEqual({ enabled: true, failIfUnavailable: false });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('ToolPolicy mode none: no MCP server at all, empty allowedTools, no sandbox option on level none', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: {
          kind: 'tool-then-reply',
          tool: 'run',
          input: { command: 'echo x' },
          reply: 'unused',
        },
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: [], mode: 'none' }, sandboxPolicy: { level: 'none' } }),
      );
      const options = optionsOf(calls);
      expect(options['mcpServers']).toBeUndefined();
      expect(options['allowedTools']).toEqual([]);
      expect(options['sandbox']).toBeUndefined();
      // The withheld tool never executed — the result reports the refusal.
      expect(result.denials.some((d) => d.tool === 'run')).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('resume: the STORE sidecar agent session id rides Options.resume; the same workspace continues (#26)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'run one' },
      });
      const run1 = await driver.run(invocation({ prompt: 'resume run one' }));
      const record1 = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(
        run1.sessionId as string,
      );
      expect(record1).toBeDefined();
      // The agent's session id, sidecar-written BESIDE the session records
      // keyed by sessionId (issue #26 design (b)) — NOT in the model-visible
      // workspace, where the earlier placement was a tamper vector.
      const sidecarPath = join(
        scratchDir,
        SESSIONS_DIR,
        `${run1.sessionId as string}${CLI_SESSION_FILE}`,
      );
      await expect(readFile(sidecarPath, 'utf8')).resolves.toBe('agent-cli-1\n');
      // 0o600 — the sidecar is evidence like the records it sits beside,
      // never world-readable (review thread: mode was umask-default 0o666).
      expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
      const noSidecarInWorkspace = async (): Promise<void> => {
        const files = await readdir(record1!.workspace);
        expect(files.filter((f) => f.endsWith(CLI_SESSION_FILE))).toEqual([]);
      };
      await noSidecarInWorkspace();
      if (run1.sessionId === undefined) throw new Error('Expected a resumable session');
      const run2 = await driver.run(
        invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }),
      );
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(optionsOf(calls, 1)['resume']).toBe('agent-cli-1');
      expect(optionsOf(calls, 1)['cwd']).toBe(optionsOf(calls, 0)['cwd']); // the SAME workspace
      // The resumed run still leaves NO resume handle in the workspace.
      await noSidecarInWorkspace();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('non-positive budget.maxTokens throws pre-dispatch', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir);
      await expect(driver.run(invocation({ budget: { maxTokens: 0 } }))).rejects.toThrow(
        /maxTokens/,
      );
      await expect(driver.run(invocation({ budget: { maxTokens: -5 } }))).rejects.toThrow(
        /maxTokens/,
      );
      await expect(driver.run(invocation({ budget: { maxTokens: Number.NaN } }))).rejects.toThrow(
        /maxTokens/,
      );
      await expect(driver.run(invocation({ budget: { maxSteps: 0 } }))).rejects.toThrow(/maxSteps/);
      await expect(driver.run(invocation({ budget: { maxSteps: 1.5 } }))).rejects.toThrow(
        /maxSteps/,
      );
      expect(calls).toEqual([]); // never dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('endpoint lookup rejects prototype keys — constructor/toString are not providers', () => {
    expect(() =>
      resolveRoute({ provider: 'constructor', model: 'm' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'constructor'/);
    expect(() => resolveRoute({ provider: 'toString', model: 'm' }, defaultRoutingTable())).toThrow(
      /unknown provider 'toString'/,
    );
  });

  test('unknown sessionRef throws pre-dispatch — never a fake resume', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir);
      await expect(driver.run(invocation({ sessionRef: 'ses-does-not-exist' }))).rejects.toThrow(
        /unknown sessionRef 'ses-does-not-exist'/,
      );
      expect(calls).toEqual([]); // never dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
