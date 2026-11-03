// Split provenance: test/ops/gates/protectedPaths.test.ts was split by subject
// into protectedPaths.{definitionSet,patternLiveness,privilegedList,policyPath,trustedJobs,trustBuild,closure}.test.ts;
// this file holds the trust-build script assertions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isProtectedPolicyPath } from '../../../src/ops/gates/protectedPaths.js';
import { REPO_ROOT } from './protectedPaths.helpers.js';

describe('every trusted job runs a selfhost entry point with a classified closure', () => {
  test("the trust build runs only protected scripts (package.json's build)", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const build = pkg.scripts['build'] ?? '';
    const scripts = [...build.matchAll(/(?:^|[\s'"])(?:\.\/)?(scripts\/[\w./-]+\.m?js)\b/g)].map(
      (m) => m[1]!,
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(isProtectedPolicyPath(script), script).toBe(true);
    // Nothing else runs: every command is node on a script, or the build tsc.
    for (const command of build.split('&&').map((c) => c.trim())) {
      expect(command, command).toMatch(
        /^(?:node (?:scripts\/|--input-type=module -e )|tsc -p tsconfig\.build\.json$)/,
      );
    }
  });
});
