// Driver deprecated-alias notice over the importer wiring (PR #238 review P2) — split from test/cli/i1.test.ts (pure move). Suite header: op-subcommands.test.ts; helpers: ./i1-helpers.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { capture, makeTmpDir, writePlanFile } from './i1-helpers.js';

// The driver factory's deprecated-alias notice (PR #238 review P2) is a
// `cq:` stderr line, so it obeys the SAME narration matrix as every CLI
// line: SUPPRESSED in --json machine mode (stderr stays EMPTY — the silent
// onDeprecatedAlias sink rides the importer wiring into the ops registries'
// DriverFactoryConfig), kept in human mode by the library default (one
// stderr line, byte-for-byte today). Both CLI surfaces are pinned
// end-to-end over a fixture family whose importer consumes the wiring
// EXACTLY like the shipped registries (src/ops/*/registry.ts): the REAL
// driver factory resolves an aliased spec (provider 'ai-sdk') and the
// notice's channel is asserted — the captured CliIo AND process.stderr.
describe('driver alias notice rides the importer wiring (PR #238 review P2)', () => {
  const factoryTs = fileURLToPath(new URL('../../src/driver/factory.ts', import.meta.url));

  /**
   * Fixture family with the SHIPPED importer idiom over the REAL factory.
   * The tmp root carries its own `{"type":"module"}` (an OS tmpdir is
   * outside the repo's package scope) and the importer imports the factory
   * by absolute path — no bare imports, so no node_modules anchoring is
   * needed; the input schema is the hand-rolled pass-through the registry
   * scanner admits (a `.parse`-bearing object with no schema `def`/`shape`
   * is unjudged by the strictness probe).
   */
  async function writeAliasFixture(): Promise<string> {
    const tmp = await makeTmpDir('cq-i1-alias-');
    await writeFile(join(tmp, 'package.json'), '{"type":"module"}\n');
    await mkdir(join(tmp, 'aliasfam'), { recursive: true });
    await writeFile(
      join(tmp, 'aliasfam', 'registry.js'),
      [
        'const { createDriverFactory } = await import(' + JSON.stringify(factoryTs) + ');',
        'const schema = {',
        '  parse: (value) => value,',
        '  safeParseAsync: async (value) => ({ success: true, data: value }),',
        '  parseAsync: async (value) => value,',
        '};',
        'export const registry = [',
        '  {',
        "    name: 'aliasprobe',",
        '    inputSchema: schema,',
        '    importer: async (wiring) => {',
        '      const factory = createDriverFactory(',
        '        wiring?.onDeprecatedAlias !== undefined',
        '          ? { onDeprecatedAlias: wiring.onDeprecatedAlias }',
        '          : {},',
        '      );',
        '      return async () => {',
        "        factory.resolve({ role: 'fixer', modelSpec: { provider: 'ai-sdk', model: 'glm-4.6' } });",
        "        return { status: 'ok', value: 'alias-resolved' };",
        '      };',
        '    },',
        '  },',
        '];',
        '',
      ].join('\n'),
    );
    return tmp;
  }

  test('direct op subcommand: --json keeps stderr EMPTY; human mode keeps the stderr notice', async () => {
    const tmp = await writeAliasFixture();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const machine = await capture(['aliasprobe', '--json'], { opsRoot: tmp });
    expect(machine.code).toBe(0);
    expect(JSON.parse(machine.out)).toEqual({ status: 'ok', value: 'alias-resolved' });
    expect(machine.err).toBe(''); // machine mode: stderr stays EMPTY
    expect(write).not.toHaveBeenCalled(); // the alias notice was suppressed with all narration
    write.mockRestore();
    const humanWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const human = await capture(['aliasprobe'], { opsRoot: tmp });
    expect(human.code).toBe(0);
    expect(human.err).toBe(''); // ok result: failures-only narration is silent
    expect(humanWrite.mock.calls.some((call) => String(call[0]).includes('deprecated'))).toBe(true); // no wiring: the library default keeps today's stderr notice
    humanWrite.mockRestore();
  });

  test('run-plan over a plan job: --json keeps stderr EMPTY; human mode keeps the stderr notice', async () => {
    const tmp = await writeAliasFixture();
    const { planPath } = await writePlanFile({
      id: 'i1-alias-plan',
      jobs: [{ id: 'a', op: 'aliasprobe', input: {} }],
    });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const machine = await capture(['run-plan', `--plan=${planPath}`, '--json'], { opsRoot: tmp });
    expect(machine.code).toBe(0);
    expect(machine.err).toBe(''); // machine mode: stderr stays EMPTY
    expect(write).not.toHaveBeenCalled(); // the view wrap suppressed the alias notice too
    write.mockRestore();
    const humanWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const human = await capture(['run-plan', `--plan=${planPath}`], { opsRoot: tmp });
    expect(human.code).toBe(0);
    expect(humanWrite.mock.calls.some((call) => String(call[0]).includes('deprecated'))).toBe(true); // no wiring: the library default keeps today's stderr notice
    humanWrite.mockRestore();
  });
});
