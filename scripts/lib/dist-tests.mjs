import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

// Indirect dependencies: CLI fixture entrypoints and the ratchet fixture
// helper load/copy dist. Keep these reviewed callers alongside the cheap
// content check, including path.join(..., 'dist') references.
const INDIRECT_DIST_TESTS = new Set([
  'test/e2e/review/review-address.e2e.test.ts',
  'test/e2e/fix/fix-run.e2e.test.ts',
  'test/scripts/static-conformance.test.ts',
  'test/scripts/tooling-commands.test.ts',
  'test/scripts/ratchet-propose.test.ts',
  'test/ops/review/address.test.ts',
]);
export function needsDist(files, root) {
  return files.some((file) => {
    const absolute = resolve(root, file);
    const name = relative(root, absolute).split(sep).join('/');
    return (
      INDIRECT_DIST_TESTS.has(name) || /\bdist(?:\/|['"])/.test(readFileSync(absolute, 'utf8'))
    );
  });
}
