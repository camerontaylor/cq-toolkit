import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Give an isolated project the real built engine after writing its source inputs. */
export function copyRatchetEngine(repository: string, fixture: string): void {
  const engine = join(repository, 'dist/ops/ratchet/checkRatchet.js');
  if (!existsSync(engine)) {
    throw new Error(
      `Cannot copy ratchet fixture engine: ${engine} is missing. Run tests through Vitest so test/global-setup.ts can build dist before collection.`,
    );
  }
  cpSync(join(repository, 'dist'), join(fixture, 'dist'), { recursive: true });
  // A fix can edit source after this copy. Its freshness-triggered build must
  // restore the real engine, while the direct compiler checks fixture inputs.
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  writeFileSync(
    join(fixture, 'scripts/build-fixture-engine.mjs'),
    `import { cpSync } from 'node:fs'; cpSync(${JSON.stringify(join(repository, 'dist'))}, ${JSON.stringify(join(fixture, 'dist'))}, { recursive: true });\n`,
  );
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { build: 'node scripts/build-fixture-engine.mjs' } }),
  );
}
