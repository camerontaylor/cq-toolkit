// Split provenance: test/harness/surface.test.ts was split into the
// surface.*.test.ts subject files plus surface.helpers.ts; this file keeps
// the tool-name spelling and policy-selection pins.
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import {
  harnessToolName,
  isQualifiedHarnessTool,
  qualifiedToolName,
  selectHarnessSurface,
  selectToolNames,
} from '../../src/harness/surface.js';
import { withRun } from './surface.helpers.js';

describe('naming', () => {
  test('qualified spelling round-trips and is recognized', () => {
    expect(qualifiedToolName('read')).toBe('mcp__cq-harness__read');
    expect(harnessToolName('mcp__cq-harness__bash')).toBe('bash');
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
  const names = ['read', 'edit', 'write', 'bash'] as const;

  test('none → nothing; unrestricted → everything', () => {
    expect(selectToolNames(names, { allow: ['read'], mode: 'none' })).toEqual([]);
    expect(selectToolNames(names, { allow: [], mode: 'unrestricted' })).toEqual([
      'read',
      'edit',
      'write',
      'bash',
    ]);
  });

  test('allowlist (explicit or default) intersects, in toolNames order', () => {
    // `run` is the one-release pre-F1 alias for `bash`.
    expect(selectToolNames(names, { allow: ['run', 'read', 'Bash'], mode: 'allowlist' })).toEqual([
      'read',
      'bash',
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
      'bash',
      'write',
    ]);
    const oneTool: HarnessConfig = {
      ...defaultHarnessConfig,
      promptBudget: { ...defaultHarnessConfig.promptBudget, maxTools: 1 },
    };
    expect(selectHarnessSurface(oneTool, { allow: ['read', 'run'] })).toEqual(['read']);
  });

  test('selectHarnessSurface is loud on a corrupt bash allowlist', () => {
    expect(() => selectHarnessSurface(withRun(['re:(']), { allow: ['run'] })).toThrow();
  });
});
