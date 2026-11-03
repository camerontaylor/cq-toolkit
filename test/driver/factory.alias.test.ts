// Split provenance: test/driver/factory.test.ts was split by subject; this
// file keeps the deprecated 'ai-sdk' provider-alias subject (normalisation,
// stderr notice and injected sink). The suite-wide header and shared
// fixtures live in ./factory.helpers.ts.
import { describe, expect, test, vi } from 'vitest';
import { createDriverFactory } from '../../src/driver/factory.js';
import { probe } from './factory.helpers.js';

describe('driver factory — resolution', () => {
  test("the deprecated provider 'ai-sdk' alias normalises to provider 'zai' with a cq: stderr notice", async () => {
    // The ABSENT-sink pin (PR #238 review P2): a bare createDriverFactory()
    // — the ops registries' exact call shape — keeps today's stderr write.
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const resolved = createDriverFactory().resolve({
      role: 'fixer',
      modelSpec: { provider: 'ai-sdk', model: 'glm-4.6' },
    });
    expect(resolved.lane).toBe('ai-sdk');
    // The NORMALISED spec is what ops put on the invocation — the alias
    // never reaches a lane or journal.
    expect(resolved.modelSpec).toEqual({ provider: 'zai', model: 'glm-4.6' });
    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain('cq:');
    expect(String(write.mock.calls[0]?.[0])).toContain('deprecated');
    await probe(resolved.driver, /ai-sdk driver: unknown provider/); // the AI-SDK lane ran
  });

  test('an injected onDeprecatedAlias sink receives the notice; stderr stays silent', async () => {
    // The injected-sink pin (PR #238 review P2): a caller that owns a
    // narration contract (the CLI's CliIo — --json keeps stderr EMPTY)
    // receives the notice through its writer, and process.stderr is never
    // touched.
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const notices: string[] = [];
    const resolved = createDriverFactory({
      onDeprecatedAlias: (message) => {
        notices.push(message);
      },
    }).resolve({
      role: 'fixer',
      modelSpec: { provider: 'ai-sdk', model: 'glm-4.6' },
    });
    expect(resolved.lane).toBe('ai-sdk');
    expect(resolved.modelSpec).toEqual({ provider: 'zai', model: 'glm-4.6' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('cq:');
    expect(notices[0]).toContain('deprecated');
    expect(write).not.toHaveBeenCalled(); // the sink replaced the stderr write
    await probe(resolved.driver, /ai-sdk driver: unknown provider/); // the AI-SDK lane ran
  });

  test('the alias rides the ai-sdk lane even when the zai provider carries a role override', async () => {
    // The alias means the ai-sdk LANE on provider 'zai' (its notice says
    // so): a fixer/zai→subprocess override must catch only a LITERAL
    // provider 'zai', never re-route the legacy alias — while the resolved
    // spec still normalises to 'zai' (the alias never reaches a lane).
    const factory = createDriverFactory({ bindings: { fixer: { zai: 'claude-code' } } });
    const resolved = factory.resolve({
      role: 'fixer',
      modelSpec: { provider: 'ai-sdk', model: 'glm-4.6' },
    });
    expect(resolved.lane).toBe('ai-sdk');
    expect(resolved.modelSpec).toEqual({ provider: 'zai', model: 'glm-4.6' });
    await probe(resolved.driver, /ai-sdk driver: unknown provider/); // the AI-SDK lane ran
    // The override still binds the literal provider it names.
    expect(
      factory.resolve({ role: 'fixer', modelSpec: { provider: 'zai', model: 'glm-4.6' } }).lane,
    ).toBe('claude-code');
  });
});
