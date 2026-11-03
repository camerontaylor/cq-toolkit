// ---------------------------------------------------------------------------
// 3. The CLOSED tool surface (W1.4): the real cq-harness MCP server behind the
//    fake CLI's MCP client, the per-run config lifecycle, and the fail-closed
//    init-surface / is_error classification.
// ---------------------------------------------------------------------------
// Split from test/driver/claude-code/cli.test.ts (pure move); the outer describe
// wrapper is reproduced in this file and in cli.harness-failures.test.ts.

import {
  baseOptions,
  FAKE_CLI,
  invocation,
  mcpConfigArgOf,
  narrationOf,
  readProbe,
  withScratch,
  SpawnCall,
} from './cli.helpers.js';
import { lstat, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { HARNESS_MCP_CONFIG_FILE } from '../../../src/driver/claude-code/cli.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';

describe('claude-code CLI transport: the closed harness tool surface (W1.4)', () => {
  test('toolSurface validation: anything but harness/stock throws at construction', () => {
    expect(() => new ClaudeCodeDriver({ toolSurface: 'builtin' as unknown as 'harness' })).toThrow(
      /toolSurface must be 'harness' or 'stock'/,
    );
    expect(() => new ClaudeCodeDriver({ toolSurface: 'harness' })).not.toThrow();
    expect(() => new ClaudeCodeDriver({ toolSurface: 'stock' })).not.toThrow();
  });

  test('a real run: byte-exact closed argv; the 0600 config lives in sessionsDir, is deleted once init reports connected, and is gone after settle', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const probe = join(scratchDir, 'config-probe.json');
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_CONFIG_PROBE: probe }, calls),
      );
      const result = await driver.run(invocation({ prompt: 'closed surface run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.error).toBeUndefined();
      const sessionId = result.sessionId as string;
      const sessionsDir = join(scratchDir, SESSIONS_DIR);
      expect(calls).toHaveLength(1);
      const configArg = calls[0]?.args.indexOf('--mcp-config') ?? -1;
      const configPath = calls[0]?.args[configArg + 1] as string;
      // Unique per run: <sessionId>.<uuid>.cq-harness-mcp.json.
      expect(configPath.slice(sessionsDir.length + 1)).toMatch(
        new RegExp(`^${sessionId}\\.[0-9a-f-]{36}\\.cq-harness-mcp\\.json$`),
      );
      expect(calls[0]?.args).toEqual([
        FAKE_CLI,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--tools',
        '',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        configPath,
        '--allowedTools',
        'mcp__cq-harness__read mcp__cq-harness__edit mcp__cq-harness__bash mcp__cq-harness__run mcp__cq-harness__write',
        '--model',
        'conformance-1',
      ]);
      // Beside the session records — never in the model-visible workspace.
      const workspace = (await store.load(sessionId))?.workspace as string;
      expect(dirname(configPath)).toBe(sessionsDir);
      expect(configPath.startsWith(workspace)).toBe(false);
      const recorded = await readProbe(probe);
      expect(recorded.path).toBe(configPath);
      // It existed as a REGULAR 0600 file when the CLI started…
      expect(recorded.atStart).toEqual({ present: true, mode: 0o600, symlink: false });
      // …was deleted as soon as init reported the harness connected, while
      // the run was still live…
      expect(recorded.afterInit).toEqual({ present: false });
      // …and is gone after settle.
      await expect(lstat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(workspace)).some((f) => f.endsWith(HARNESS_MCP_CONFIG_FILE))).toBe(
        false,
      );
      expect((await readdir(sessionsDir)).some((f) => f.endsWith(HARNESS_MCP_CONFIG_FILE))).toBe(
        false,
      );
    });
  });

  test('empty selection (mode none): no --mcp-config, --allowedTools "" as ONE element, no config file, init [] passes', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls),
      );
      const result = await driver.run(
        invocation({ prompt: 'empty surface run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(result.stopReason).toBe('complete');
      expect(calls[0]?.args).toEqual([
        FAKE_CLI,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--tools',
        '',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--allowedTools',
        '',
        '--model',
        'conformance-1',
      ]);
      expect(
        (await readdir(join(scratchDir, SESSIONS_DIR))).some((f) =>
          f.endsWith(HARNESS_MCP_CONFIG_FILE),
        ),
      ).toBe(false);
    });
  });

  test("per-run config names: concurrent runs on ONE session never share, replace or delete each other's binding; files at other names are never touched", async () => {
    await withScratch(async (scratchDir) => {
      const seed = await new ClaudeCodeDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, []),
      ).run(invocation({ prompt: 'seed run' }));
      const sessionId = seed.sessionId as string;
      const sessionsDir = join(scratchDir, SESSIONS_DIR);
      // A file and a planted symlink at the legacy fixed name are inert:
      // never followed, never written, never deleted.
      const legacyPath = join(sessionsDir, `${sessionId}${HARNESS_MCP_CONFIG_FILE}`);
      await writeFile(legacyPath, 'foreign — not ours', { mode: 0o644 });
      const victim = join(scratchDir, 'victim.json');
      await writeFile(victim, 'victim-content', 'utf8');
      const linkPath = join(sessionsDir, `${sessionId}.planted${HARNESS_MCP_CONFIG_FILE}`);
      await symlink(victim, linkPath);
      // Two runs on the SAME session at once, with different sandbox levels.
      const callsA: SpawnCall[] = [];
      const callsB: SpawnCall[] = [];
      const probeA = join(scratchDir, 'probe-a.json');
      const probeB = join(scratchDir, 'probe-b.json');
      const [a, b] = await Promise.all([
        new ClaudeCodeDriver(
          baseOptions(
            scratchDir,
            { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_CONFIG_PROBE: probeA },
            callsA,
          ),
        ).run(
          invocation({
            prompt: 'run A',
            sessionRef: sessionId,
            sandboxPolicy: { level: 'read-only' },
          }),
        ),
        new ClaudeCodeDriver(
          baseOptions(
            scratchDir,
            { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_CONFIG_PROBE: probeB },
            callsB,
          ),
        ).run(invocation({ prompt: 'run B', sessionRef: sessionId })),
      ]);
      expect(a.stopReason).toBe('complete');
      expect(b.stopReason).toBe('complete');
      const pathOf = (calls: SpawnCall[]): string => {
        const args = calls[0]?.args ?? [];
        return args[args.indexOf('--mcp-config') + 1] as string;
      };
      const pathA = pathOf(callsA);
      const pathB = pathOf(callsB);
      expect(pathA).not.toBe(pathB);
      // Each CLI saw its OWN regular 0600 file at start.
      expect((await readProbe(probeA)).atStart).toEqual({
        present: true,
        mode: 0o600,
        symlink: false,
      });
      expect((await readProbe(probeB)).atStart).toEqual({
        present: true,
        mode: 0o600,
        symlink: false,
      });
      // Both per-run files are gone; the foreign files are untouched.
      await expect(lstat(pathA)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(pathB)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(legacyPath, 'utf8')).toBe('foreign — not ours');
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(victim, 'utf8')).toBe('victim-content');
    });
  });

  test('a RELATIVE sessionsDir still yields an absolute --mcp-config the CLI (cwd = workspace) can open (review r1)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls),
        sessionsDir: relative(process.cwd(), join(scratchDir, SESSIONS_DIR)),
      });
      const result = await driver.run(invocation({ prompt: 'relative sessionsDir run' }));
      expect(result.stopReason).toBe('complete');
      const args = calls[0]?.args ?? [];
      expect(isAbsolute(args[args.indexOf('--mcp-config') + 1] as string)).toBe(true);
    });
  });

  test('STOCK surface run: the legacy argv and the legacy in-process tool path (raw names, no MCP)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const driver = new ClaudeCodeDriver({
        ...baseOptions(
          scratchDir,
          {
            FAKE_AGENT_MODE: 'tool-then-reply',
            FAKE_AGENT_TOOL: 'read',
            FAKE_AGENT_INPUT: JSON.stringify({ path: 'missing.txt' }),
          },
          calls,
        ),
        toolSurface: 'stock',
      });
      const result = await driver.run(invocation({ prompt: 'stock run' }));
      expect(result.stopReason).toBe('complete');
      expect(calls[0]?.args).toEqual([
        FAKE_CLI,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        'read edit run',
        '--model',
        'conformance-1',
      ]);
      expect(mcpConfigArgOf(calls[0]?.args ?? [])).toBeUndefined();
      expect(result.denials).toEqual([{ tool: 'read', reason: "file not found: 'missing.txt'" }]);
      expect(result.toolFailures).toBe(1);
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(true);
      // No init surface is asserted on the stock surface.
      expect(
        (await narrationOf(store, result.sessionId as string)).some((l) =>
          l.includes('"errorClass":"harness"'),
        ),
      ).toBe(false);

      // The legacy deny-tool shape still maps on the stock surface.
      const denied = await new ClaudeCodeDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'deny-tool' }, []),
        toolSurface: 'stock',
      }).run(invocation({ prompt: 'stock denial run' }));
      expect(denied.denials).toEqual([
        { tool: 'edit', reason: 'permission denied: edit is not allowed' },
      ]);
      expect(denied.stopReason).toBe('error');
    });
  });
});
