// Split provenance: test/harness/surface.test.ts was split into the
// surface.*.test.ts subject files plus surface.helpers.ts; this file keeps
// the init-surface comparator pins.
import { describe, expect, test } from 'vitest';
import { compareInitSurface } from '../../src/harness/surface.js';

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
