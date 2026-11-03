// Split provenance: test/ops/dev/check.test.ts was split by subject into
// check.input-rules.test.ts, check.adopter.test.ts, check.portable-scan.test.ts,
// check.selection.test.ts, check.gates.test.ts and check.diff-gates.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDevCheck } from '../../../src/ops/dev/check.js';
import { devEffectsFor } from './check.helpers.js';
import { makeTestRepo, type CommandHandler, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const effectsFor = (override?: CommandHandler) => devEffectsFor(repo, override);

describe('dev.check', () => {
  test('fresh adopter scans the archived tree portably without a toolkit denylist script', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'fake-check', args: [] } }],
      }),
    );
    await repo.write('src/checked.ts', 'export const checked = true;\n');
    repo.commitAll('configure fresh adopter');
    const effects = effectsFor((command) => (command === 'fake-check' ? '' : undefined));
    const seen: string[] = [];
    const result = await makeDevCheck(effects, async (components) => {
      seen.push(...components.map(({ path, text }) => `${path}:${text}`));
      return components.map(({ component }) => ({ component, hits: [] }));
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(seen).toContain('src/checked.ts:export const checked = true;\n');
    expect(effects.calls.some((call) => call.command === 'node')).toBe(false);
    expect(effects.calls.some((call) => call.command === 'gitleaks')).toBe(false);
  });

  test('portable scan excludes its configured denylist corpus and still scans source files', async () => {
    await repo.write('package.json', JSON.stringify({ name: 'fixture-adopter' }));
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'fake-check', args: [] } }],
        review: { denylistPatternsFile: 'policy/denylist/patterns.yml' },
      }),
    );
    await repo.write(
      'policy/denylist/patterns.yml',
      'rules:\n  - id: synthetic\n    regex: example\n',
    );
    await repo.write('src/checked.ts', 'export const checked = true;\n');
    repo.commitAll('configure portable scan corpus');
    const effects = effectsFor((command) => (command === 'fake-check' ? '' : undefined));
    let scanned: string[] = [];
    const result = await makeDevCheck(effects, async (components) => {
      scanned = components.map(({ path }) => path);
      return components.map(({ component }) => ({ component, hits: [] }));
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(scanned).not.toContain('policy/denylist/patterns.yml');
    expect(scanned).toContain('src/checked.ts');
  });
});
