import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// src/config sits below these layers; importing them would allow cycles once
// they value-import readCqEnv.
const FORBIDDEN = ['sandbox', 'selfhost', 'ops', 'driver'];

test('src/config imports nothing from sandbox, selfhost, ops or driver', () => {
  const dir = join(import.meta.dirname, '..', '..', 'src', 'config');
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? '';
      if (FORBIDDEN.some((layer) => new RegExp(`(^|/)${layer}(/|$)`).test(spec))) {
        offenders.push(`${file}: ${spec}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
