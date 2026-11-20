// getPrReadiness pins the PR head: the snapshot document carries headRefOid
// and a second read must agree, else the snapshot is refused. Exercised
// through the REAL adapter against a fake `gh` shim on PATH (hermetic).
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeSubprocessPrEffects } from '../../../src/adapters/forge-github/ghEffects.js';

const DOC = (head: string | null) =>
  JSON.stringify({
    statusCheckRollup: [],
    reviewDecision: 'APPROVED',
    isDraft: false,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    ...(head === null ? {} : { headRefOid: head }),
  });

async function withGh<T>(first: string, second: string, run: () => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), 'cq-pr-readiness-'));
  const binDir = join(scratch, 'bin');
  await mkdir(binDir, { recursive: true });
  // The wide read names statusCheckRollup; the narrow re-read does not.
  await writeFile(
    join(binDir, 'gh'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *statusCheckRollup*) printf '%s' '${first}' ;;`,
      `  *) printf '%s' '${second}' ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  await chmod(join(binDir, 'gh'), 0o755);
  const originalPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${originalPath ?? ''}`;
  try {
    return await run();
  } finally {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
  }
}

describe('getPrReadiness pins the PR head across the read', () => {
  const repo = tmpdir();

  test('a stable head yields the snapshot', async () => {
    const snap = await withGh(
      DOC('a'.repeat(40)),
      JSON.stringify({ headRefOid: 'a'.repeat(40) }),
      () => makeSubprocessPrEffects(repo).getPrReadiness(7),
    );
    expect(snap.review).toBeDefined();
    expect(snap.meta.state).toBe('open');
  });

  test('a head that moves during the read rejects the snapshot', async () => {
    await expect(
      withGh(DOC('a'.repeat(40)), JSON.stringify({ headRefOid: 'b'.repeat(40) }), () =>
        makeSubprocessPrEffects(repo).getPrReadiness(7),
      ),
    ).rejects.toThrow(/head changed during the readiness read/);
  });

  test('a document without headRefOid is refused, not trusted', async () => {
    await expect(
      withGh(DOC(null), JSON.stringify({ headRefOid: 'a'.repeat(40) }), () =>
        makeSubprocessPrEffects(repo).getPrReadiness(7),
      ),
    ).rejects.toThrow(/no headRefOid/);
  });
});
