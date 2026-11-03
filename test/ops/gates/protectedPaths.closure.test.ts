// Split provenance: test/ops/gates/protectedPaths.test.ts was split by subject
// into protectedPaths.{definitionSet,patternLiveness,privilegedList,policyPath,trustedJobs,trustBuild,closure}.test.ts;
// this file holds the fail-closed module-closure walk assertions.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, test } from 'vitest';
import { scanModuleLoads, type ModuleScan } from '../../helpers/import-closure.js';
import { REPO_ROOT, trustedJobsFixture } from './protectedPaths.helpers.js';

/** `loadEngine`'s `imp('<rel>.js')` modules, as `src/ops/ratchet/<rel>.ts`. */
function engineModules(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'scripts', 'ratchet-lib.mjs'), 'utf8');
  const body = /export async function loadEngine\(\)[\s\S]*?\n\}/.exec(text)?.[0] ?? '';
  const out = [...body.matchAll(/\bimp\('([\w/.-]+)\.js'\)/g)].map(
    (m) => `src/ops/ratchet/${m[1]!}.ts`,
  );
  if (out.length === 0) throw new Error('scripts/ratchet-lib.mjs: no loadEngine imports found');
  return out;
}

const { TRUSTED } = trustedJobsFixture();

describe('every trusted job runs a selfhost entry point with a classified closure', () => {
  const ENTRY_POINTS = [
    ...[...new Set(TRUSTED.flatMap((job) => job.entries))].map((e) => `src/selfhost/${e}.ts`),
    // The prebuilt engine `scripts/ratchet-propose.mjs` loads in its
    // `automation`-environment job (scripts/ratchet-lib.mjs `loadEngine`).
    ...engineModules(),
  ];

  const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const DEPENDENCIES = new Set(Object.keys(PACKAGE.dependencies));
  /** `zod` → `zod`, `@scope/pkg/sub` → `@scope/pkg`. */
  const packageOf = (spec: string): string =>
    spec
      .split('/')
      .slice(0, spec.startsWith('@') ? 2 : 1)
      .join('/');

  /** The module-loading closure of `entries`, and every edge it could not classify. */
  function closure(entries: readonly string[]): { files: string[]; problems: string[] } {
    const seen = new Set<string>();
    const problems: string[] = [];
    const stack = [...entries];
    while (stack.length > 0) {
      const file = stack.pop() ?? '';
      if (seen.has(file)) continue;
      seen.add(file);
      const scan = scanModuleLoads(readFileSync(join(REPO_ROOT, file), 'utf8'));
      problems.push(...scan.problems.map((p) => `${file}: ${p}`));
      for (const spec of scan.specifiers) {
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const target = posix.normalize(
            posix.join(posix.dirname(file), spec.replace(/\.js$/, '.ts')),
          );
          if (!target.startsWith('src/') || !target.endsWith('.ts')) {
            problems.push(`${file}: ${spec} resolves outside src/*.ts`);
          } else stack.push(target);
        } else if (!spec.startsWith('node:') && !DEPENDENCIES.has(packageOf(spec))) {
          problems.push(`${file}: ${spec} is not relative, a node: builtin or a dependency`);
        }
      }
    }
    return { files: [...seen].sort(), problems };
  }

  test('the closure walk refuses what it cannot classify', () => {
    const scan = (text: string): ModuleScan => scanModuleLoads(text);
    expect(
      scan(
        [
          "import { a, type B } from './a.js';",
          "import type { C } from './c.js';",
          "export type { D } from './d.js';",
          "export { e } from '../e.js';",
          "export * from './f.js';",
          "import {\n  g,\n  h,\n} from './g.js';",
          "import './side.js';",
          "const m = await import('./dyn.js');",
          "import { x } from 'node:fs';",
          "// import { c } from './comment.js';",
          'const s = "import(\'./string.js\')";',
          "const re = /'/g;",
        ].join('\n'),
      ),
    ).toEqual({
      specifiers: ['./a.js', '../e.js', './f.js', './g.js', 'node:fs', './side.js', './dyn.js'],
      problems: [],
    });
    expect(scan('const m = await import(name);').problems).toHaveLength(1);
    expect(scan('const m = await import(`./${x}.js`);').problems).toHaveLength(1);
    expect(scan("const r = createRequire(import.meta.url); r('./x.cjs');").problems).toHaveLength(
      1,
    );
    // A from-clause cannot span a call: the computed import stays visible.
    expect(
      scan("export const f = (n) => import(n)\nexport { x } from './x.js';").problems,
    ).toHaveLength(1);
    for (const text of [
      "register('./hooks.mjs', import.meta.url);",
      "new Function('return 1')();",
      "eval('1');",
      "process.dlopen(m, './x.node');",
    ]) {
      expect(scan(text).problems, text).toHaveLength(1);
    }
    expect(scan("export * from 'node:fs';")).toEqual({ specifiers: ['node:fs'], problems: [] });
    // The package self-import resolves through dist/index.js, the whole SDK.
    expect(packageOf('@camerontaylor/cq-toolkit')).toBe('@camerontaylor/cq-toolkit');
    expect(DEPENDENCIES.has(packageOf('@camerontaylor/cq-toolkit'))).toBe(false);
    expect(DEPENDENCIES.has(packageOf('#internal'))).toBe(false);
  });

  test('the closure walk classifies every edge and reaches the judges', () => {
    const { files, problems } = closure(ENTRY_POINTS);
    expect(problems).toEqual([]);
    // The judges the trusted entries exist to run are reached.
    expect(files).toEqual(
      expect.arrayContaining([
        ...ENTRY_POINTS,
        'src/ops/gates/policyDiff.ts',
        'src/ops/gates/policyConfig.ts',
        'src/ops/ratchet/verifyRatchet.ts',
        'src/ops/ratchet/recomputeTypecheck.ts',
        'src/ops/review/threads.ts',
      ]),
    );
    // R1: none of the CLI shell runs in a trusted job.
    expect(
      files.filter((f) => /^src\/(?:cli|kernel|registry)\//.test(f) || f === 'src/cli.ts'),
    ).toEqual([]);
    // Advisory development posture (2026-10-20): the closure is no longer
    // required to match the project list — only the promotion gate itself is
    // privileged. The fail-closed walk above still refuses any edge it
    // cannot classify.
  });
});
