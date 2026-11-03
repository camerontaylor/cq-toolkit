// Split provenance: test/driver/ai-sdk-pre-request-ceiling.test.ts was split
// into ai-sdk-pre-request-ceiling.helpers.ts (shared fixtures) and seven
// subject files; this file carries the ceiling-unit snapshot subject: the
// returned/counted request is immune to hook mutation (§2).
import { describe, expect, test } from 'vitest';
import {
  PreRequestCeiling,
  serializeRequestForCounting,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import {
  fakeCapability,
  firstTextPart,
  invalidProviderOptions,
  reasonOfRefusal,
  refusalFrom,
  userPrompt,
} from './ai-sdk-pre-request-ceiling.helpers.js';

// ---------------------------------------------------------------------------
// 2. The ceiling unit — the returned/counted snapshot is immune to mutation
// ---------------------------------------------------------------------------

describe('PreRequestCeiling (unit)', () => {
  test('a delayed hook mutating nested prompt cannot change the returned/counted request', async () => {
    const params = userPrompt('ORIGINAL-TEXT');
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: async () => {
        firstTextPart(params).text = 'MUTATED-DURING-AWAIT';
        await Promise.resolve();
      },
    });
    const returned = await ceiling.reserve(params);
    expect(JSON.stringify(returned)).not.toContain('MUTATED-DURING-AWAIT');
    expect(JSON.stringify(returned.prompt)).toContain('ORIGINAL-TEXT');
    expect(ceiling.reservedTokens).toBe(
      Buffer.byteLength(serializeRequestForCounting(returned), 'utf8') + 64,
    );
  });

  test('a delayed hook mutating the output cap cannot change the returned snapshot', async () => {
    const params = userPrompt('hi');
    const mutable = params as { maxOutputTokens?: number };
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: async () => {
        mutable.maxOutputTokens = 1;
        await Promise.resolve();
      },
    });
    const returned = await ceiling.reserve(params);
    expect(returned.maxOutputTokens).toBe(64);
  });

  test('a delayed hook mutating nested tools cannot change the returned/counted request', async () => {
    const params = {
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      tools: [
        {
          type: 'function' as const,
          name: 'read',
          description: 'ORIGINAL-TOOL-DESC',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: async () => {
        const tool = params.tools[0];
        if (tool !== undefined) tool.description = 'MUTATED-TOOL-DESC';
        await Promise.resolve();
      },
    });
    const returned = await ceiling.reserve(params);
    expect(JSON.stringify(returned.tools)).toContain('ORIGINAL-TOOL-DESC');
    expect(JSON.stringify(returned.tools)).not.toContain('MUTATED-TOOL-DESC');
    expect(ceiling.reservedTokens).toBe(
      Buffer.byteLength(serializeRequestForCounting(returned), 'utf8') + 64,
    );
  });

  test('a delayed hook mutating nested providerOptions cannot change the returned/counted request', async () => {
    const params = {
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      providerOptions: { provider: { marker: 'ORIGINAL-OPT' } },
    };
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: async () => {
        params.providerOptions.provider.marker = 'MUTATED-OPT';
        await Promise.resolve();
      },
    });
    const returned = await ceiling.reserve(params);
    expect(JSON.stringify(returned.providerOptions)).toContain('ORIGINAL-OPT');
    expect(JSON.stringify(returned.providerOptions)).not.toContain('MUTATED-OPT');
    expect(ceiling.reservedTokens).toBe(
      Buffer.byteLength(serializeRequestForCounting(returned), 'utf8') + 64,
    );
  });

  test('the returned snapshot is frozen: counted fields cannot be mutated', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const returned = await ceiling.reserve(userPrompt('hi'));
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.prompt)).toBe(true);
    expect(() => {
      (returned as { maxOutputTokens?: number }).maxOutputTokens = 1;
    }).toThrow();
  });

  test('refuses a request whose counted fields structuredClone cannot clone', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const err = await refusalFrom(() =>
      ceiling.reserve({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: invalidProviderOptions({ provider: { fn: () => 1 } }),
      }),
    );
    expect(reasonOfRefusal(err)).toBe('unrepresentable-request');
  });
});
