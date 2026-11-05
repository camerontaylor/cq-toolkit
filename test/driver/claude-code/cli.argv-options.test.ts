// Split from test/driver/claude-code/cli.test.ts (pure move). The outer describe
// wrapper is reproduced so every full test title is unchanged.
// Subject: routing guards, the buildArgs argv contract, and driver-option validation.

import { FAKE_CLI, TEST_ROUTE } from './cli.helpers.js';
import { buildArgs } from '../../../src/driver/claude-code/cli.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { defaultRoutingTable, resolveRoute } from '../../../src/driver/claude-code/routing.js';
import { describe, expect, test } from 'vitest';

describe('claude-code driver, CLI transport specifics (fake agent CLI)', () => {
  test('routeFor rejects prototype keys — constructor/toString are not providers (the own-property guard both consolidated lanes carried)', () => {
    expect(() =>
      resolveRoute({ provider: 'constructor', model: 'deepseek-chat' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'constructor'/);
    expect(() =>
      resolveRoute({ provider: 'toString', model: 'deepseek-chat' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'toString'/);
  });

  test('buildArgs: the exact CLOSED-surface headless argv (harness default) — undocumented flags removed (#19-8, W1.4)', () => {
    const args = buildArgs({
      route: TEST_ROUTE,
      allowedToolNames: ['mcp__cq-harness__read', 'mcp__cq-harness__edit'],
      mcpConfigPath: '/sessions/s-1.cq-harness-mcp.json',
      outputJsonSchema: '{"type":"object"}',
      resumeCliSessionId: 'cli-9',
    });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose', // the real CLI refuses stream-json print mode without it (found live, T1.6)
      '--json-schema',
      '{"type":"object"}',
      '--tools', // every builtin ABSENT (not merely denied)
      '',
      '--setting-sources', // no ambient settings
      '',
      '--strict-mcp-config', // no ambient MCP servers
      '--mcp-config',
      '/sessions/s-1.cq-harness-mcp.json',
      '--allowedTools',
      'mcp__cq-harness__read mcp__cq-harness__edit', // ONE element, SPACE-joined
      '--model',
      'conformance-1',
      '--resume',
      'cli-9',
    ]);
    // The allowlist is never comma-joined: a comma list silently pre-approves
    // only its first entry (RS-1b b9/b10).
    expect(args.some((arg) => arg.includes(','))).toBe(false);
    // Without --json-schema the flag pair is simply absent.
    const noSchema = buildArgs({
      route: TEST_ROUTE,
      allowedToolNames: ['mcp__cq-harness__read'],
      mcpConfigPath: '/sessions/s-1.cq-harness-mcp.json',
      outputJsonSchema: undefined,
      resumeCliSessionId: undefined,
    });
    expect(noSchema).toEqual([
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
      '/sessions/s-1.cq-harness-mcp.json',
      '--allowedTools',
      'mcp__cq-harness__read',
      '--model',
      'conformance-1',
    ]);
    // Empty selection (ToolPolicy mode 'none'): NO --mcp-config, and
    // --allowedTools ALWAYS present with an EMPTY value as ONE element.
    const none = buildArgs({
      route: TEST_ROUTE,
      allowedToolNames: [],
      outputJsonSchema: undefined,
      resumeCliSessionId: undefined,
    });
    expect(none).toEqual([
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
    expect(none).not.toContain('--mcp-config');
    expect(none).not.toContain('--permission-prompts'); // undocumented — removed (issue #19)
    expect(none).not.toContain('--bare'); // undocumented — removed (issue #19)
  });

  test('buildArgs STOCK surface: the legacy argv byte-exact — no closed-surface flags, raw harness names (D6)', () => {
    const args = buildArgs({
      route: TEST_ROUTE,
      toolSurface: 'stock',
      allowedToolNames: ['read', 'edit'],
      outputJsonSchema: '{"type":"object"}',
      resumeCliSessionId: 'cli-9',
    });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      '{"type":"object"}',
      '--allowedTools',
      'read edit',
      '--model',
      'conformance-1',
      '--resume',
      'cli-9',
    ]);
    const none = buildArgs({
      route: TEST_ROUTE,
      toolSurface: 'stock',
      allowedToolNames: [],
      // Ignored on the stock surface: the config only exists in harness mode.
      mcpConfigPath: '/sessions/ignored.json',
      outputJsonSchema: undefined,
      resumeCliSessionId: undefined,
    });
    expect(none).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      '',
      '--model',
      'conformance-1',
    ]);
  });

  test('binary validation: an empty template throws at construction, never at spawn (#19-4)', () => {
    expect(() => new ClaudeCodeDriver({ binary: [] })).toThrow(
      /non-empty string or a non-empty array of non-empty strings/,
    );
    expect(() => new ClaudeCodeDriver({ binary: ['node', ''] })).toThrow(
      /non-empty string or a non-empty array of non-empty strings/,
    );
    expect(() => new ClaudeCodeDriver({ binary: '' })).toThrow(/non-empty string/);
    // The valid forms still construct.
    expect(() => new ClaudeCodeDriver({ binary: 'claude' })).not.toThrow();
    expect(() => new ClaudeCodeDriver({ binary: ['node', FAKE_CLI] })).not.toThrow();
  });

  test('grace validation: negative/NaN/Infinity/fractional graces throw at construction (#19-6)', () => {
    expect(() => new ClaudeCodeDriver({ termGraceMs: -1 })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new ClaudeCodeDriver({ termGraceMs: Number.NaN })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new ClaudeCodeDriver({ termGraceMs: Number.POSITIVE_INFINITY })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new ClaudeCodeDriver({ termGraceMs: 0.5 })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new ClaudeCodeDriver({ killGraceMs: -5 })).toThrow(
      /killGraceMs must be an integer >= 0/,
    );
    // Zero and positive integers are legitimate.
    expect(() => new ClaudeCodeDriver({ killGraceMs: 0 })).not.toThrow();
    expect(() => new ClaudeCodeDriver({ termGraceMs: 100, killGraceMs: 200 })).not.toThrow();
  });

  test('envAllowlist validation: malformed names throw at construction (#183)', () => {
    expect(() => new ClaudeCodeDriver({ envAllowlist: [''] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new ClaudeCodeDriver({ envAllowlist: ['A=B'] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new ClaudeCodeDriver({ envAllowlist: ['BAD NAME'] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new ClaudeCodeDriver({ envAllowlist: ['CLAUDE_CONFIG_DIR'] })).not.toThrow();
  });
});
