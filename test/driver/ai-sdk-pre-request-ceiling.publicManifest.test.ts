// Split provenance: test/driver/ai-sdk-pre-request-ceiling.test.ts was split
// into ai-sdk-pre-request-ceiling.helpers.ts (shared fixtures) and seven
// subject files; this file carries the public-manifest contract subject.
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

// ---------------------------------------------------------------------------
// The public manifest contract: a declaration the root barrel RE-EXPORTS
// (AiSdkDriverOptions -> StrictTokenCapability -> LanguageModelV4CallOptions)
// reaches '@ai-sdk/provider', so that package must be a RUNTIME dependency a
// consumer install links — a devDependency makes an isolated pnpm consumer's
// TS resolution of the shipped .d.ts fail (TS2307).
// ---------------------------------------------------------------------------

/** A JSON-ish field read with an explicit `unknown` boundary (JSON.parse returns any). */
function manifestField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

describe('package manifest — the strict ceiling public dependency', () => {
  test('@ai-sdk/provider is a runtime dependency pin, not a devDependency', async () => {
    const raw: unknown = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const dependencies = manifestField(raw, 'dependencies');
    const devDependencies = manifestField(raw, 'devDependencies');
    // Pinned same version the runtime @ai-sdk/* tree already resolves.
    expect(manifestField(dependencies, '@ai-sdk/provider')).toBe('4.0.14');
    expect(manifestField(devDependencies, '@ai-sdk/provider')).toBeUndefined();
  });
});
