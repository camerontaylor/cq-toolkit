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
//     serialized in arrival order; an unserved name rejects; the legacy
//     `run` alias reaches the bash executor and `has` never narrows it away.
//   - CLASSIFICATION: every REAL denial buildTools produces satisfies
//     isHarnessDenial (tested against actual denials, not the prefix list).
//   - THE INIT-SURFACE COMPARATOR: exact on servers and tools, fail closed on
//     anything unshaped.
//
// Split provenance: test/harness/surface.test.ts was split into the
// surface.*.test.ts subject files plus surface.helpers.ts; this file keeps
// the harness-surface construction and descriptor pins (surface.selection,
// surface.manifest, surface.result, surface.initCompare and
// surface.cancellation carry the rest).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { createHarnessSurface } from '../../src/harness/surface.js';
import type { HarnessManifest, HarnessSurface } from '../../src/harness/surface.js';
import type { LegacyToolName } from '../../src/harness/tools.js';
import { manifest, scratch, withRun } from './surface.helpers.js';

test('served descriptors advertise only required canonical fields', () => {
  const surface = createHarnessSurface(
    manifest(scratch(), { tools: ['read', 'edit', 'write', 'bash'] }),
  );
  const required = {
    read: ['file_path'],
    edit: ['file_path', 'old_string', 'new_string'],
    write: ['file_path', 'content'],
    bash: ['command'],
  };
  expect(surface.tools.map((tool) => tool.name)).toEqual(Object.keys(required));
  for (const tool of surface.tools) {
    const schema = tool.inputJsonSchema;
    expect(schema['required']).toEqual(required[tool.name as keyof typeof required]);
    expect(schema['additionalProperties']).toBe(false);
    expect(Object.keys(schema['properties'] as object)).toEqual(
      Object.keys(tool.inputSchema.shape),
    );
    expect(tool.description.length).toBeGreaterThan(25);
  }
  expect(surface.has('run')).toBe(true);
  expect(surface.has('unknown')).toBe(false);
});

describe('createHarnessSurface', () => {
  test('throws when the manifest names a disabled tool', () => {
    const harness: HarnessConfig = {
      ...defaultHarnessConfig,
      tools: { ...defaultHarnessConfig.tools, bash: { enabled: false, commandPatterns: [] } },
    };
    expect(() =>
      createHarnessSurface(manifest(scratch(), { harness, tools: ['read', 'bash'] })),
    ).toThrow(/does not provide: bash/);
  });

  test('throws when maxTools slices away a named tool', () => {
    const harness: HarnessConfig = {
      ...defaultHarnessConfig,
      promptBudget: { ...defaultHarnessConfig.promptBudget, maxTools: 2 },
    };
    expect(() => createHarnessSurface(manifest(scratch(), { harness }))).toThrow(
      /does not provide: bash/,
    );
  });

  test('re-validates the manifest strictly', () => {
    const bad = { ...manifest(scratch()), extra: 1 } as unknown as HarnessManifest;
    expect(() => createHarnessSurface(bad)).toThrow();
  });

  test('serves tools in manifest order with strict JSON Schemas', () => {
    // The legacy `run` spelling normalises to the canonical `bash` tool.
    const surface = createHarnessSurface(manifest(scratch(), { tools: ['run', 'read'] }));
    expect(surface.tools.map((tool) => tool.name)).toEqual(['bash', 'read']);
    expect(surface.has('run')).toBe(true);
    expect(surface.has('bash')).toBe(true);
    expect(surface.has('edit')).toBe(false);
    for (const tool of surface.tools) {
      expect(tool.inputJsonSchema['type']).toBe('object');
      expect(tool.inputJsonSchema['additionalProperties']).toBe(false);
      expect('$schema' in tool.inputJsonSchema).toBe(false);
      expect(tool.description.length).toBeGreaterThan(0);
    }
    const read = surface.tools.find((tool) => tool.name === 'read');
    expect(read?.inputJsonSchema).toHaveProperty('properties.file_path');
    expect(read?.inputJsonSchema).not.toHaveProperty('properties.path');
    expect(read?.inputJsonSchema['required']).toEqual(['file_path']);
  });

  test('the legacy run alias reaches the bash executor through call (#488)', async () => {
    const surface = createHarnessSurface(manifest(scratch(), { tools: ['run', 'read'] }));
    // A command outside the allowlist: the bash executor refuses it before
    // spawning anything, so the denial proves the routing without a shell.
    const viaAlias = await surface.call('run', { command: 'rm -rf x' });
    const viaCanonical = await surface.call('bash', { command: 'rm -rf x' });
    expect(viaAlias.outcome.ok).toBe(false);
    if (!viaAlias.outcome.ok) {
      expect(viaAlias.outcome.denial.tool).toBe('bash');
      expect(viaAlias.outcome.denial.reason).toBe(
        "CMD_DENIED: command not allowed by harness config allowlist: 'rm -rf x'",
      );
    }
    expect(viaAlias).toEqual(viaCanonical);
  });

  test('has does not narrow away the legacy run alias (#488, compile-time)', () => {
    const surface = createHarnessSurface(manifest(scratch(), { tools: ['run'] }));
    const name: string = 'run';
    expect(surface.has(name)).toBe(true);
    if (surface.has(name)) {
      // A `name is ToolkitToolName` predicate would narrow `name` here and
      // exclude the 'run' spelling it accepts; typecheck fails if it returns.
      expectTypeOf(name).toEqualTypeOf<string>();
    }
    expectTypeOf<HarnessSurface['has']>().returns.toEqualTypeOf<boolean>();
    // `call` takes the legacy spelling without a cast for the alias window.
    // Remove with the `run` alias (src/harness/tools.ts LegacyToolName).
    expectTypeOf<LegacyToolName>().toExtend<Parameters<HarnessSurface['call']>[0]>();
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
    expect(ok.result).toEqual({
      content: [{ type: 'text', text: '--- a.txt ---\n     1: alpha' }],
    });
    expect(ok.outcome).toMatchObject({
      ok: true,
      output: '--- a.txt ---\n     1: alpha',
    });
    const denied = await surface.call('read', { path: '../x' });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]?.text.startsWith('PATH_ESCAPE: path escape: ')).toBe(true);
    expect(denied.outcome.ok).toBe(false);
  });

  test('calls are serialized in arrival order', async () => {
    const workspace = scratch();
    await writeFile(join(workspace, 'a.txt'), 'alpha', 'utf8');
    const surface = createHarnessSurface(
      manifest(workspace, { harness: withRun(['re:^sleep 0\\.3; echo done > done\\.txt$']) }),
    );
    const order: string[] = [];
    const slow = surface.call('bash', { command: 'sleep 0.3; echo done > done.txt' }).then((r) => {
      order.push('bash');
      return r;
    });
    // The read arrives second: it must not start until the run has settled,
    // so it observes the file the run wrote.
    const fast = surface.call('read', { path: 'done.txt' }).then((r) => {
      order.push('read');
      return r;
    });
    const [, read] = await Promise.all([slow, fast]);
    expect(order).toEqual(['bash', 'read']);
    expect(read.outcome).toMatchObject({
      ok: true,
      output: '--- done.txt ---\n     1: done',
    });
  });

  test('an already-aborted signal: the call never executes (cancelled denial)', async () => {
    const surface = createHarnessSurface(manifest(scratch()));
    const controller = new AbortController();
    controller.abort();
    const { outcome } = await surface.call(
      'bash',
      { command: 'echo x' },
      { signal: controller.signal },
    );
    expect(outcome).toEqual({
      ok: false,
      denial: {
        tool: 'bash',
        reason: 'CANCELLED: cancelled: the call was cancelled before it ran',
      },
    });
  });
});
