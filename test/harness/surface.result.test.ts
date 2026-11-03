// Split provenance: test/harness/surface.test.ts was split into the
// surface.*.test.ts subject files plus surface.helpers.ts; this file keeps
// the result mapping and real-denial classification pins.
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { HarnessConfig } from '../../src/harness/config.js';
import {
  HARNESS_DENIAL_PREFIXES,
  isHarnessDenial,
  toCallToolResult,
} from '../../src/harness/surface.js';
import { buildTools } from '../../src/harness/tools.js';
import type { ToolkitToolResult } from '../../src/harness/tools.js';
import { harnessRunGate } from '../../src/sandbox/index.js';
import { scratch, withRun } from './surface.helpers.js';

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
      const found = buildTools(config, ws, sandbox, harnessRunGate({ env: {} })).find(
        (t) => t.name === name,
      );
      if (found === undefined) throw new Error(`no ${name}`);
      return found;
    };
    // One tools instance for the read-then-edit cases: the prior-read ledger
    // lives per buildTools call, so a fresh instance would deny the edit for
    // the wrong reason.
    const fileTools = buildTools(config, workspace, 'workspace-write');
    const fileRead = fileTools.find((tool) => tool.name === 'read');
    const fileEdit = fileTools.find((tool) => tool.name === 'edit');
    if (fileRead === undefined || fileEdit === undefined) throw new Error('file tools missing');
    await fileRead.execute({ path: 'a.txt' });
    const reasons: Record<string, ToolkitToolResult> = {
      sandboxEdit: await tool(workspace, 'read-only', 'edit').execute({
        file_path: 'a.txt',
        old_string: 'a',
        new_string: 'b',
      }),
      sandboxBash: await tool(workspace, 'read-only', 'bash').execute({ command: 'echo x' }),
      sandboxWrite: await tool(workspace, 'read-only', 'write').execute({
        file_path: 'new.txt',
        content: 'new',
      }),
      invalidInput: await tool(workspace, 'workspace-write', 'read').execute({ nope: 1 }),
      lexicalEscape: await tool(workspace, 'workspace-write', 'read').execute({ path: '../x' }),
      symlinkEscape: await tool(workspace, 'workspace-write', 'read').execute({ path: 'link.txt' }),
      pathNotAllowed: await tool(workspace, 'workspace-write', 'read').execute({ path: 'a.md' }),
      commandNotAllowed: await tool(workspace, 'workspace-write', 'bash').execute({
        command: 'rm -rf x',
      }),
      metacharacters: await tool(workspace, 'workspace-write', 'bash').execute({
        command: 'echo x; whoami',
      }),
      fileNotFound: await tool(workspace, 'workspace-write', 'read').execute({ path: 'none.txt' }),
      readFailed: await tool(workspace, 'workspace-write', 'read').execute({ path: 'dir' }),
      editRefused: await fileEdit.execute({
        file_path: 'a.txt',
        old_string: 'zzz',
        new_string: 'y',
      }),
      runFailed: await tool(join(workspace, 'gone'), 'workspace-write', 'bash').execute({
        command: 'echo x',
      }),
    };
    // edit failed: needs a write the OS refuses — root ignores 0o444.
    if (process.getuid?.() !== 0 && process.platform !== 'win32') {
      await fileRead.execute({ path: 'locked.txt' });
      reasons['editFailed'] = await fileEdit.execute({
        file_path: 'locked.txt',
        old_string: 'alpha',
        new_string: 'beta',
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
    expect(reasonOf('sandboxEdit')).toBe('PATH_DENIED: sandbox: read-only');
    expect(reasonOf('sandboxBash')).toBe('PATH_DENIED: sandbox: read-only');
    expect(reasonOf('sandboxWrite')).toBe('PATH_DENIED: sandbox: read-only');
    expect(reasonOf('symlinkEscape')).toMatch(/^PATH_ESCAPE: path escape: .*symlink/);
    expect(reasonOf('metacharacters')).toMatch(/^CMD_DENIED: command allowlist: /);
    expect(reasonOf('readFailed')).toMatch(/^EXECUTION_ERROR: read failed: /);
    expect(reasonOf('runFailed')).toMatch(/^EXECUTION_ERROR: bash failed: /);
    if (reasons['editFailed'] !== undefined)
      expect(reasonOf('editFailed')).toMatch(/^EXECUTION_ERROR: edit failed: /);
  });
});
