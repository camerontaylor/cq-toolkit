// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the createPr body-transport pin.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeSubprocessPrEffects } from '../../../src/adapters/forge-github/ghEffects.js';

// ---------------------------------------------------------------------------
// The createPr body transport pin (cycle-1 fix): a PR body travels over
// STDIN (`--body-file -`), never argv — the same discipline as
// editPrBody/comment. Exercised through the REAL adapter against a fake
// `gh` shim on PATH that records its argv and stdin; hermetic (no network,
// writes stay under os.tmpdir()).
// ---------------------------------------------------------------------------

describe('createPr carries the body over stdin, never argv', () => {
  test('a create with a body sends --body-file - and the body on stdin', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-create-'));
    const binDir = join(scratch, 'bin');
    const repoDir = join(scratch, 'repo');
    const argsFile = join(scratch, 'argv');
    const stdinFile = join(scratch, 'stdin');
    await mkdir(binDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    // The shim records the argv and the stdin it was handed, then prints
    // the PR URL parseCreatedPr expects.
    await writeFile(
      join(binDir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${argsFile}'`,
        `cat > '${stdinFile}'`,
        'echo "https://github.test/owner/repo/pull/42"',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'gh'), 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
    try {
      const effects = makeSubprocessPrEffects(repoDir);
      const created = await effects.createPr({
        head: 'cq/09-16a/fix/core',
        base: 'origin/merge-queue',
        title: 'core fixes',
        body: 'manifest notes\nwith a newline',
        draft: true,
      });
      expect(created).toEqual({ number: 42, url: 'https://github.test/owner/repo/pull/42' });
      const argv = (await readFile(argsFile, 'utf8')).split('\n').filter((line) => line !== '');
      expect(argv).toContain('--body-file');
      expect(argv).toContain('-');
      expect(argv).not.toContain('--body');
      expect(argv).toContain('--draft');
      expect(await readFile(stdinFile, 'utf8')).toBe('manifest notes\nwith a newline');
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a create WITHOUT a body STILL sends --body-file - with EMPTY stdin (final jMrm0 reversal)', async () => {
    // Non-interactive gh (GH_PROMPT_DISABLED=1) requires title AND body —
    // a body-less create would prompt-fault the row. An absent request
    // body becomes an honest EMPTY body over stdin, never a fault.
    const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-create-'));
    const binDir = join(scratch, 'bin');
    const repoDir = join(scratch, 'repo');
    const argsFile = join(scratch, 'argv');
    const stdinFile = join(scratch, 'stdin');
    await mkdir(binDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(binDir, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${argsFile}'`,
        `cat > '${stdinFile}'`,
        'echo "https://github.test/owner/repo/pull/7"',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'gh'), 0o755);
    const originalPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
    try {
      const effects = makeSubprocessPrEffects(repoDir);
      const created = await effects.createPr({
        head: 'cq/09-16a/fix/core',
        base: 'origin/merge-queue',
        title: 'core fixes',
        draft: false,
      });
      expect(created.number).toBe(7);
      const argv = (await readFile(argsFile, 'utf8')).split('\n').filter((line) => line !== '');
      expect(argv).toContain('--body-file');
      expect(argv).toContain('-');
      expect(argv).not.toContain('--body');
      expect(argv).not.toContain('--draft');
      expect(await readFile(stdinFile, 'utf8')).toBe('');
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
