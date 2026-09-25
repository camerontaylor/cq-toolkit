// Harness tool-surface core tests — W1.4 (src/harness/surface.ts). Pins:
//   - NAMING: `mcp__cq-harness__<name>` round-trips; foreign names pass
//     through verbatim.
//   - SELECTION: the ToolPolicy intersection (none / unrestricted /
//     allowlist, allowlist being the default reading) over the ENABLED,
//     maxTools-sliced harness names.
//   - BINDING: HarnessManifestSchema is strict (unknown keys, empty or
//     repeated tools, malformed env names fail); buildManifest realpaths the
//     workspace, refuses a non-directory, and yields NO manifest for an empty
//     selection.
//   - EXECUTION: createHarnessSurface refuses a manifest naming a tool the
//     config does not provide; tools come back in manifest order with strict
//     JSON Schemas (additionalProperties false, no $schema); calls are
//     serialized in arrival order; an unserved name rejects.
//   - CLASSIFICATION: every REAL denial buildTools produces satisfies
//     isHarnessDenial (tested against actual denials, not the prefix list).
//   - THE INIT-SURFACE COMPARATOR: exact on servers and tools, fail closed on
//     anything unshaped.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import {
  buildManifest,
  compareInitSurface,
  createHarnessSurface,
  HARNESS_DENIAL_PREFIXES,
  harnessToolName,
  HarnessManifestSchema,
  isHarnessDenial,
  isQualifiedHarnessTool,
  qualifiedToolName,
  selectHarnessSurface,
  selectToolNames,
  toCallToolResult,
} from '../../src/harness/surface.js';
import type { HarnessManifest } from '../../src/harness/surface.js';
import { buildTools } from '../../src/harness/tools.js';
import type { ToolkitToolResult } from '../../src/harness/tools.js';

/** A realpath'd scratch workspace (macOS /var → /private/var), removed after the test. */
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-surface-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The default harness config with the given run allowlist. */
function withRun(commandPatterns: string[], timeoutMs = 5_000): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      run: { enabled: true, commandPatterns, timeoutMs, maxOutputChars: 10_000 },
    },
  };
}

/** A strictly-parsed manifest over `workspace`. */
function manifest(workspace: string, over: Partial<HarnessManifest> = {}): HarnessManifest {
  return HarnessManifestSchema.parse({
    v: 1,
    workspace,
    sandbox: 'workspace-write',
    tools: ['read', 'edit', 'run'],
    harness: withRun(['echo', 'sleep']),
    envNames: [],
    ...over,
  });
}

describe('naming', () => {
  test('qualified spelling round-trips and is recognized', () => {
    expect(qualifiedToolName('read')).toBe('mcp__cq-harness__read');
    expect(harnessToolName('mcp__cq-harness__run')).toBe('run');
    expect(isQualifiedHarnessTool('mcp__cq-harness__edit')).toBe(true);
  });

  test('foreign names pass through verbatim and are not harness tools', () => {
    expect(harnessToolName('Bash')).toBe('Bash');
    expect(harnessToolName('mcp__other__read')).toBe('mcp__other__read');
    expect(isQualifiedHarnessTool('mcp__other__read')).toBe(false);
    expect(isQualifiedHarnessTool('mcp__CQ-HARNESS__read')).toBe(false); // case-sensitive
  });
});

describe('selection', () => {
  const names = ['read', 'edit', 'run'] as const;

  test('none → nothing; unrestricted → everything', () => {
    expect(selectToolNames(names, { allow: ['read'], mode: 'none' })).toEqual([]);
    expect(selectToolNames(names, { allow: [], mode: 'unrestricted' })).toEqual([
      'read',
      'edit',
      'run',
    ]);
  });

  test('allowlist (explicit or default) intersects, in toolNames order', () => {
    expect(selectToolNames(names, { allow: ['run', 'read', 'Bash'], mode: 'allowlist' })).toEqual([
      'read',
      'run',
    ]);
    expect(selectToolNames(names, { allow: ['edit'] })).toEqual(['edit']);
  });

  test('selectHarnessSurface drops disabled and maxTools-sliced tools', () => {
    const noEdit: HarnessConfig = {
      ...defaultHarnessConfig,
      tools: { ...defaultHarnessConfig.tools, edit: { enabled: false, pathPatterns: [] } },
    };
    expect(selectHarnessSurface(noEdit, { allow: [], mode: 'unrestricted' })).toEqual([
      'read',
      'run',
    ]);
    const oneTool: HarnessConfig = {
      ...defaultHarnessConfig,
      promptBudget: { ...defaultHarnessConfig.promptBudget, maxTools: 1 },
    };
    expect(selectHarnessSurface(oneTool, { allow: ['read', 'run'] })).toEqual(['read']);
  });

  test('selectHarnessSurface is loud on a corrupt run allowlist', () => {
    expect(() => selectHarnessSurface(withRun(['re:(']), { allow: ['run'] })).toThrow();
  });
});

describe('HarnessManifestSchema', () => {
  const base = {
    v: 1,
    workspace: '/w',
    sandbox: 'none',
    tools: ['read'],
    harness: defaultHarnessConfig,
  };

  test('accepts a minimal manifest and defaults envNames to []', () => {
    expect(HarnessManifestSchema.parse(base).envNames).toEqual([]);
  });

  test.each([
    ['an unknown key', { ...base, extra: true }],
    ['an empty tool list', { ...base, tools: [] }],
    ['a repeated tool', { ...base, tools: ['read', 'read'] }],
    ['an unknown tool', { ...base, tools: ['Bash'] }],
    ['a malformed env name', { ...base, envNames: ['BAD-NAME'] }],
    ['an env name starting with a digit', { ...base, envNames: ['1ABC'] }],
    ['a wrong version', { ...base, v: 2 }],
    ['an empty workspace', { ...base, workspace: '' }],
  ])('rejects %s', (_label, candidate) => {
    expect(HarnessManifestSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('buildManifest', () => {
  test('realpaths the workspace (through a symlink) and records the selection', async () => {
    const dir = scratch();
    const real = join(dir, 'real');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'link'));
    const built = await buildManifest({
      workspace: join(dir, 'link'),
      sandbox: 'read-only',
      toolPolicy: { allow: ['run', 'read'] },
      harness: defaultHarnessConfig,
      envNames: ['GH_TOKEN'],
    });
    expect(built).toEqual({
      v: 1,
      workspace: real,
      sandbox: 'read-only',
      tools: ['read', 'run'],
      harness: defaultHarnessConfig,
      envNames: ['GH_TOKEN'],
    });
  });

  test('an empty selection yields no manifest (and touches no filesystem)', async () => {
    await expect(
      buildManifest({
        workspace: '/definitely/not/here',
        sandbox: 'none',
        toolPolicy: { allow: [], mode: 'none' },
        harness: defaultHarnessConfig,
      }),
    ).resolves.toBeUndefined();
  });

  test('throws on a non-directory workspace', async () => {
    const file = join(scratch(), 'file.txt');
    writeFileSync(file, 'x');
    await expect(
      buildManifest({
        workspace: file,
        sandbox: 'none',
        toolPolicy: { allow: ['read'] },
        harness: defaultHarnessConfig,
      }),
    ).rejects.toThrow(/is not a directory/);
  });

  test('throws on a missing workspace', async () => {
    await expect(
      buildManifest({
        workspace: join(scratch(), 'missing'),
        sandbox: 'none',
        toolPolicy: { allow: ['read'] },
        harness: defaultHarnessConfig,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('throws on an env name the schema rejects', async () => {
    await expect(
      buildManifest({
        workspace: scratch(),
        sandbox: 'none',
        toolPolicy: { allow: ['read'] },
        harness: defaultHarnessConfig,
        envNames: ['NOT OK'],
      }),
    ).rejects.toThrow();
  });
});

describe('createHarnessSurface', () => {
  test('throws when the manifest names a disabled tool', () => {
    const harness: HarnessConfig = {
      ...defaultHarnessConfig,
      tools: { ...defaultHarnessConfig.tools, run: { enabled: false, commandPatterns: [] } },
    };
    expect(() =>
      createHarnessSurface(manifest(scratch(), { harness, tools: ['read', 'run'] })),
    ).toThrow(/does not provide: run/);
  });

  test('throws when maxTools slices away a named tool', () => {
    const harness: HarnessConfig = {
      ...defaultHarnessConfig,
      promptBudget: { ...defaultHarnessConfig.promptBudget, maxTools: 2 },
    };
    expect(() => createHarnessSurface(manifest(scratch(), { harness }))).toThrow(
      /does not provide: run/,
    );
  });

  test('re-validates the manifest strictly', () => {
    const bad = { ...manifest(scratch()), extra: 1 } as unknown as HarnessManifest;
    expect(() => createHarnessSurface(bad)).toThrow();
  });

  test('serves tools in manifest order with strict JSON Schemas', () => {
    const surface = createHarnessSurface(manifest(scratch(), { tools: ['run', 'read'] }));
    expect(surface.tools.map((tool) => tool.name)).toEqual(['run', 'read']);
    expect(surface.has('run')).toBe(true);
    expect(surface.has('edit')).toBe(false);
    for (const tool of surface.tools) {
      expect(tool.inputJsonSchema['type']).toBe('object');
      expect(tool.inputJsonSchema['additionalProperties']).toBe(false);
      expect('$schema' in tool.inputJsonSchema).toBe(false);
      expect(tool.description.length).toBeGreaterThan(0);
    }
    const read = surface.tools.find((tool) => tool.name === 'read');
    expect(read?.inputJsonSchema['required']).toEqual(['path']);
  });

  test('call on an unserved name rejects (even one the config provides)', async () => {
    const surface = createHarnessSurface(manifest(scratch(), { tools: ['read'] }));
    await expect(surface.call('edit', {})).rejects.toThrow(/'edit' is not a served tool/);
    await expect(surface.call('Bash', {})).rejects.toThrow(/'Bash' is not a served tool/);
  });

  test('call maps success and denial onto the CallToolResult', async () => {
    const workspace = scratch();
    await writeFile(join(workspace, 'a.txt'), 'alpha', 'utf8');
    const surface = createHarnessSurface(manifest(workspace));
    const ok = await surface.call('read', { path: 'a.txt' });
    expect(ok.result).toEqual({ content: [{ type: 'text', text: 'alpha' }] });
    expect(ok.outcome).toMatchObject({ ok: true, output: 'alpha' });
    const denied = await surface.call('read', { path: '../x' });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]?.text.startsWith('path escape: ')).toBe(true);
    expect(denied.outcome.ok).toBe(false);
  });

  test('calls are serialized in arrival order', async () => {
    const workspace = scratch();
    await writeFile(join(workspace, 'a.txt'), 'alpha', 'utf8');
    const surface = createHarnessSurface(
      manifest(workspace, { harness: withRun(['re:^sleep 0\\.3; echo done > done\\.txt$']) }),
    );
    const order: string[] = [];
    const slow = surface.call('run', { command: 'sleep 0.3; echo done > done.txt' }).then((r) => {
      order.push('run');
      return r;
    });
    // The read arrives second: it must not start until the run has settled,
    // so it observes the file the run wrote.
    const fast = surface.call('read', { path: 'done.txt' }).then((r) => {
      order.push('read');
      return r;
    });
    const [, read] = await Promise.all([slow, fast]);
    expect(order).toEqual(['run', 'read']);
    expect(read.outcome).toMatchObject({ ok: true, output: 'done\n' });
  });

  test('an already-aborted signal: the call never executes (cancelled denial)', async () => {
    const surface = createHarnessSurface(manifest(scratch()));
    const controller = new AbortController();
    controller.abort();
    const { outcome } = await surface.call(
      'run',
      { command: 'echo x' },
      { signal: controller.signal },
    );
    expect(outcome).toEqual({
      ok: false,
      denial: { tool: 'run', reason: 'cancelled: the call was cancelled before it ran' },
    });
  });
});

describe('toCallToolResult', () => {
  test('success → text content; denial → reason text with isError', () => {
    expect(toCallToolResult({ ok: true, output: 'hi', truncated: false })).toEqual({
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(toCallToolResult({ ok: false, denial: { tool: 'read', reason: 'sandbox: x' } })).toEqual(
      {
        content: [{ type: 'text', text: 'sandbox: x' }],
        isError: true,
      },
    );
  });
});

describe('isHarnessDenial against real denials', () => {
  test('non-denial text is not a denial', () => {
    expect(isHarnessDenial('exit 0')).toBe(false);
    expect(isHarnessDenial('')).toBe(false);
    expect(isHarnessDenial('Sandbox: read-only')).toBe(false);
    expect(Object.isFrozen(HARNESS_DENIAL_PREFIXES)).toBe(true);
  });

  test('every denial reason buildTools actually produces is recognized', async () => {
    const workspace = scratch();
    const outside = scratch();
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
    await writeFile(join(workspace, 'a.txt'), 'alpha', 'utf8');
    await writeFile(join(workspace, 'locked.txt'), 'alpha', 'utf8');
    chmodSync(join(workspace, 'locked.txt'), 0o444);
    mkdirSync(join(workspace, 'dir'));

    const config: HarnessConfig = {
      ...withRun(['echo']),
      tools: {
        ...withRun(['echo']).tools,
        read: { enabled: true, pathPatterns: ['*.txt', 'dir'], maxOutputChars: 1_000 },
        edit: { enabled: true, pathPatterns: ['*.txt'], maxOutputChars: 1_000 },
      },
    };
    const tool = (ws: string, sandbox: 'workspace-write' | 'read-only', name: string) => {
      const found = buildTools(config, ws, sandbox).find((t) => t.name === name);
      if (found === undefined) throw new Error(`no ${name}`);
      return found;
    };
    const reasons: Record<string, ToolkitToolResult> = {
      sandboxEdit: await tool(workspace, 'read-only', 'edit').execute({
        path: 'a.txt',
        oldText: 'a',
        newText: 'b',
      }),
      sandboxRun: await tool(workspace, 'read-only', 'run').execute({ command: 'echo x' }),
      invalidInput: await tool(workspace, 'workspace-write', 'read').execute({ nope: 1 }),
      lexicalEscape: await tool(workspace, 'workspace-write', 'read').execute({ path: '../x' }),
      symlinkEscape: await tool(workspace, 'workspace-write', 'read').execute({ path: 'link.txt' }),
      pathNotAllowed: await tool(workspace, 'workspace-write', 'read').execute({ path: 'a.md' }),
      commandNotAllowed: await tool(workspace, 'workspace-write', 'run').execute({
        command: 'rm -rf x',
      }),
      metacharacters: await tool(workspace, 'workspace-write', 'run').execute({
        command: 'echo x; whoami',
      }),
      fileNotFound: await tool(workspace, 'workspace-write', 'read').execute({ path: 'none.txt' }),
      readFailed: await tool(workspace, 'workspace-write', 'read').execute({ path: 'dir' }),
      editRefused: await tool(workspace, 'workspace-write', 'edit').execute({
        path: 'a.txt',
        oldText: 'zzz',
        newText: 'y',
      }),
      runFailed: await tool(join(workspace, 'gone'), 'workspace-write', 'run').execute({
        command: 'echo x',
      }),
    };
    // edit failed: needs a write the OS refuses — root ignores 0o444.
    if (process.getuid?.() !== 0 && process.platform !== 'win32') {
      reasons['editFailed'] = await tool(workspace, 'workspace-write', 'edit').execute({
        path: 'locked.txt',
        oldText: 'alpha',
        newText: 'beta',
      });
    }
    for (const [label, result] of Object.entries(reasons)) {
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(isHarnessDenial(result.denial.reason), label).toBe(true);
    }
    // Spot-check that each case hit the branch it was named for.
    const reasonOf = (key: string): string => {
      const result = reasons[key];
      return result !== undefined && !result.ok ? result.denial.reason : '';
    };
    expect(reasonOf('sandboxEdit')).toBe('sandbox: read-only');
    expect(reasonOf('symlinkEscape')).toMatch(/^path escape: .*symlink/);
    expect(reasonOf('metacharacters')).toMatch(/^command allowlist: /);
    expect(reasonOf('readFailed')).toMatch(/^read failed: /);
    expect(reasonOf('runFailed')).toMatch(/^run failed: /);
    if (reasons['editFailed'] !== undefined)
      expect(reasonOf('editFailed')).toMatch(/^edit failed: /);
  });
});

describe('compareInitSurface', () => {
  const harnessServer = { name: 'cq-harness', status: 'connected' };
  const qualified = ['mcp__cq-harness__read', 'mcp__cq-harness__run'];

  test('exact match (tools in any order) is ok', () => {
    expect(
      compareInitSurface(
        { harness: true, tools: ['read', 'run'] },
        { mcp_servers: [harnessServer], tools: [...qualified].reverse() },
      ),
    ).toEqual({ ok: true });
  });

  test('no harness: no servers and no tools is ok', () => {
    expect(
      compareInitSurface({ harness: false, tools: [] }, { mcp_servers: [], tools: [] }),
    ).toEqual({
      ok: true,
    });
  });

  test('entries carrying extra fields (source: dynamic) still match', () => {
    expect(
      compareInitSurface(
        { harness: true, tools: ['read', 'run'] },
        { mcp_servers: [{ ...harnessServer, source: 'dynamic' }], tools: qualified },
      ),
    ).toEqual({ ok: true });
  });

  test('pinned internal tools (StructuredOutput) are accepted', () => {
    expect(
      compareInitSurface(
        { harness: true, tools: ['read', 'run'], internalTools: ['StructuredOutput'] },
        { mcp_servers: [harnessServer], tools: ['StructuredOutput', ...qualified] },
      ),
    ).toEqual({ ok: true });
  });

  test('an extra server (claude.ai connector) is a mismatch', () => {
    const verdict = compareInitSurface(
      { harness: true, tools: ['read', 'run'] },
      {
        mcp_servers: [harnessServer, { name: 'claude.ai Gmail', status: 'connected' }],
        tools: qualified,
      },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.expected.mcp_servers).toEqual([harnessServer]);
      // The observed projection is sorted by name.
      expect(verdict.observed.mcp_servers).toEqual([
        { name: 'claude.ai Gmail', status: 'connected' },
        harnessServer,
      ]);
    }
  });

  test.each(['failed', 'pending', 'needs-auth'])('a %s harness server is a mismatch', (status) => {
    expect(
      compareInitSurface(
        { harness: true, tools: ['read', 'run'] },
        { mcp_servers: [{ name: 'cq-harness', status }], tools: qualified },
      ).ok,
    ).toBe(false);
  });

  test('a missing harness server is a mismatch', () => {
    expect(
      compareInitSurface(
        { harness: true, tools: ['read', 'run'] },
        { mcp_servers: [], tools: qualified },
      ).ok,
    ).toBe(false);
  });

  test('an unstripped builtin tool (Bash) is a mismatch', () => {
    const verdict = compareInitSurface(
      { harness: true, tools: ['read', 'run'] },
      { mcp_servers: [harnessServer], tools: [...qualified, 'Bash'] },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.expected.tools).toEqual(qualified);
      expect(verdict.observed.tools).toEqual(['Bash', ...qualified]);
    }
  });

  test('a missing selected tool is a mismatch', () => {
    expect(
      compareInitSurface(
        { harness: true, tools: ['read', 'run'] },
        { mcp_servers: [harnessServer], tools: ['mcp__cq-harness__read'] },
      ).ok,
    ).toBe(false);
  });

  test.each([
    ['servers not an array', 'cq-harness'],
    ['a server entry missing status', [{ name: 'cq-harness' }]],
    ['a null server entry', [null]],
  ])('unshaped servers (%s) mismatch and echo the observed value', (_label, mcpServers) => {
    const verdict = compareInitSurface(
      { harness: false, tools: [] },
      { mcp_servers: mcpServers, tools: [] },
    );
    expect(verdict).toMatchObject({ ok: false, observed: { mcp_servers: mcpServers } });
  });

  test.each([
    ['tools not an array', { read: true }],
    ['tools with a non-string', [42]],
  ])('unshaped tools (%s) mismatch and echo the observed value', (_label, tools) => {
    const verdict = compareInitSurface({ harness: false, tools: [] }, { mcp_servers: [], tools });
    expect(verdict).toMatchObject({ ok: false, observed: { tools } });
  });
});

describe('queued cancellation (improvement pass)', () => {
  test('a call cancelled while queued never executes: an edit behind a running run does not write', async () => {
    const workspace = scratch();
    await writeFile(join(workspace, 'note.txt'), 'before\n');
    const surface = createHarnessSurface(manifest(workspace));
    const cancel = new AbortController();
    const running = surface.call('run', { command: 'sleep 1' });
    const queued = surface.call(
      'edit',
      { path: 'note.txt', oldText: 'before', newText: 'after' },
      { signal: cancel.signal },
    );
    cancel.abort();
    await running;
    const { result, outcome } = await queued;
    expect(outcome).toEqual({
      ok: false,
      denial: { tool: 'edit', reason: 'cancelled: the call was cancelled before it ran' },
    });
    expect(result.isError).toBe(true);
    expect(isHarnessDenial('cancelled: the call was cancelled before it ran')).toBe(true);
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('before\n');
  }, 20_000);
});
