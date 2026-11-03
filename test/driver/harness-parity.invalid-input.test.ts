// Split provenance: test/driver/harness-parity.test.ts was split by subject; this
// file holds the schema-invalid-input parity tests, asserted per transport
// (stdio server, core, claude-agent callback). The shared config, fixtures and
// the three paths' drivers live in harness-parity.helpers.ts.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { McpCallToolResult } from '../../src/harness/surface.js';
import {
  NOTE_BODY,
  claudeAgentPhase,
  corePhase,
  stdioPhase,
  type Step,
} from './harness-parity.helpers.js';

// ---------------------------------------------------------------------------
// Schema-invalid input — asserted PER TRANSPORT
// ---------------------------------------------------------------------------

/** Schema-invalid calls: a type-invalid read, a read with an extra key, an edit with an extra key. */
const INVALID_STEPS: readonly Step[] = [
  { label: 'read {path: 5}', tool: 'read', input: { path: 5 } },
  { label: 'read + extra key', tool: 'read', input: { path: 'note.txt', extra: true } },
  {
    label: 'edit + extra key',
    tool: 'edit',
    input: { path: 'note.txt', oldText: 'hello', newText: 'EXECUTED', extra: 1 },
  },
];

/** Every result is an 'INPUT_INVALID: invalid input:' denial, and the edit never executed. */
async function expectInvalidDenials(results: readonly unknown[], workspace: string): Promise<void> {
  expect(results).toHaveLength(INVALID_STEPS.length);
  for (const result of results) {
    const r = result as McpCallToolResult;
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.text.startsWith('INPUT_INVALID: invalid input: ')).toBe(true);
  }
  await expect(readFile(join(workspace, 'note.txt'), 'utf8')).resolves.toBe(NOTE_BODY);
}

describe('harness parity — schema-invalid input (per transport)', () => {
  test('stdio server: isError "INPUT_INVALID: invalid input:", nothing executed', async () => {
    const stdio = await stdioPhase('workspace-write', INVALID_STEPS);
    await expectInvalidDenials(stdio.results, stdio.workspace);
  }, 30_000);

  test('core: isError "INPUT_INVALID: invalid input:", nothing executed', async () => {
    const core = await corePhase('workspace-write', INVALID_STEPS);
    await expectInvalidDenials(core.results, core.workspace);
    expect(core.denials.map((d) => d.tool)).toEqual(['read', 'read', 'edit']);
  });

  test('claude-agent callback: raw invalid input is denied by the core', async () => {
    const agent = await claudeAgentPhase('workspace-write', INVALID_STEPS);
    expect(agent.verdict.stopReason).toBe('complete');
    await expectInvalidDenials(agent.results, agent.workspace);
    expect(agent.verdict.denials.map((d) => d.tool)).toEqual(['read', 'read', 'edit']);
  });
});
