// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the searchPrByHead argv pins.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeSubprocessPrEffects } from '../../../src/adapters/forge-github/ghEffects.js';

describe('searchPrByHead argv pins (r1#3 + r1#4/I11)', () => {
  test.each([199, 200, 201])(
    'refuses potentially truncated results at the ceiling (%i rows)',
    async (count) => {
      const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-list-cap-'));
      const bin = join(scratch, 'gh');
      const rows = Array.from({ length: count }, (_, i) => ({ number: i + 1, state: 'OPEN' }));
      await writeFile(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(rows)}'\n`);
      await chmod(bin, 0o755);
      const originalBin = process.env['CQ_GH_BIN'];
      process.env['CQ_GH_BIN'] = bin;
      try {
        const search = makeSubprocessPrEffects(scratch).searchPrByHead(
          'cq/run/core',
          'merge-queue',
        );
        if (count < 200) {
          await expect(search).resolves.toMatchObject({ number: 1, state: 'open' });
        } else {
          await expect(search).rejects.toThrow('results may be incomplete');
        }
      } finally {
        if (originalBin === undefined) delete process.env['CQ_GH_BIN'];
        else process.env['CQ_GH_BIN'] = originalBin;
        await rm(scratch, { recursive: true, force: true });
      }
    },
  );

  test('the search passes --base, and an explicit generous --limit (gh would default to 30)', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-list-'));
    const binDir = join(scratch, 'bin');
    const repoDir = join(scratch, 'repo');
    const argsFile = join(scratch, 'argv');
    await mkdir(binDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    // The list shim records argv and prints one row — it never reads stdin
    // (the search effect writes none, and a reading shim would block).
    await writeFile(
      join(binDir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${argsFile}'`,
        'echo \'[{"number":9,"state":"OPEN"}]\'',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'gh'), 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
    try {
      const effects = makeSubprocessPrEffects(repoDir);
      const hit = await effects.searchPrByHead('cq/09-16a/fix/core', 'origin/merge-queue');
      expect(hit).toEqual({ number: 9, state: 'open', isCrossRepository: false });
      const argv = (await readFile(argsFile, 'utf8')).split('\n').filter((line) => line !== '');
      // The base is part of the PR identity (r1#2): it MUST reach the query.
      const baseIndex = argv.indexOf('--base');
      expect(baseIndex).toBeGreaterThan(-1);
      expect(argv[baseIndex + 1]).toBe('origin/merge-queue');
      const headIndex = argv.indexOf('--head');
      expect(argv[headIndex + 1]).toBe('cq/09-16a/fix/core');
      // The truncation guard (r1#4): the limit is EXPLICIT, never gh's 30.
      const limitIndex = argv.indexOf('--limit');
      expect(limitIndex).toBeGreaterThan(-1);
      expect(argv[limitIndex + 1]).toBe('200');
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
