import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const root = join(import.meta.dirname, '..', '..');

/** Backticked repo-relative `src/...` file paths in a text. */
const srcPaths = (text: string): string[] =>
  [...text.matchAll(/`(src\/[A-Za-z0-9_./-]+\.(?:ts|mjs))`/g)].map((m) => m[1] ?? '');

test('ADR-0009 and note N24 name only source files that exist', () => {
  const adr = readFileSync(join(root, 'docs/adr/0009-config-contract-v2.md'), 'utf8');
  const readme = readFileSync(join(root, 'docs/adr/README.md'), 'utf8');
  const n24 = readme.slice(readme.indexOf('### N24'), readme.indexOf('### N25'));
  const paths = [...srcPaths(adr), ...srcPaths(n24)];
  expect(paths).toContain('src/config/env-registry.ts');
  expect(paths.filter((p) => !existsSync(join(root, p)))).toEqual([]);
  expect([...adr.matchAll(/src\/config\/env\.ts/g)]).toHaveLength(0);
  expect(n24).not.toContain('src/config/env.ts');
});
