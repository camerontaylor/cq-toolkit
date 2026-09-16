import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Give an isolated project the real built engine after writing its source inputs. */
export function copyRatchetEngine(repository: string, fixture: string): void {
  if (!existsSync(join(repository, 'dist/ops/ratchet/checkRatchet.js'))) {
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: repository,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (build.error || build.status !== 0)
      throw new Error(`Cannot build fixture engine: ${build.error?.message ?? build.stderr}`);
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
