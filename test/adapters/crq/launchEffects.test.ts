import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';
import { fileLaunchEffects, isoOf, runStampOf } from '../../../src/adapters/crq/launchEffects.js';

const never = async (): Promise<never> => {
  throw new Error('injected seam used');
};

async function build() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'crq-launch-'));
  const at = new Date('2026-11-26T01:02:03.456Z');
  const effects = fileLaunchEffects({
    stateRoot,
    worktreeRoot: stateRoot,
    worktreePrefix: 'crq-',
    primaryClone: '/clone',
    primaryRepo: 'Owner/Repo',
    repos: [{ repo: 'Other/Thing', clone: '/other', scanExtraClasses: ['x'] }],
    scheduleContext: () => ({
      config: { primaryRepo: 'Owner/Repo', repos: [], localReviewAgingMinutes: 60 },
      nowMicros: 0n,
    }),
    root: stateRoot,
    entry: '/crq.js',
    workRecords: join(stateRoot, 'work', 'records.jsonl'),
    pool: new GitPool(),
    now: () => at,
    scan: never,
    scanBackfillContext: never,
    writeBlockedReceipt: never,
    checkAuthor: () => undefined,
    grantAuthor: () => undefined,
    onDemandClone: never,
    saveQueue: async () => undefined,
  });
  return { stateRoot, effects };
}

describe('fileLaunchEffects', () => {
  it('formats iso() and the run stamp like Python', () => {
    const at = new Date('2026-11-26T01:02:03.456Z');
    expect(isoOf(at)).toBe('2026-11-26T01:02:03Z');
    expect(runStampOf(at)).toBe('20261126T010203Z');
  });

  it('resolves item_repo, same_repo and by_repo', async () => {
    const { effects } = await build();
    expect(effects.itemRepo({ repo: '' } as never)).toBe('Owner/Repo');
    expect(effects.itemRepo({} as never)).toBe('Owner/Repo');
    expect(effects.itemRepo({ repo: 'a/b' } as never)).toBe('a/b');
    expect(effects.isPrimaryRepo('owner/repo')).toBe(true);
    expect(effects.isPrimaryRepo('other/thing')).toBe(false);
    expect(effects.repoConfig('OTHER/thing')?.clone).toBe('/other');
    expect(effects.repoConfig('nope/nope')).toBeNull();
  });

  it('allocates a run directory exclusively', async () => {
    const { effects, stateRoot } = await build();
    const rdir = await effects.allocateRun('r1');
    expect(rdir).toBe(join(stateRoot, 'runs', 'r1'));
    expect((await stat(rdir)).isDirectory()).toBe(true);
    await expect(effects.allocateRun('r1')).rejects.toThrow();
  });

  it('writes meta.json as indent-2 ASCII JSON with a newline', async () => {
    const { effects } = await build();
    const rdir = await effects.allocateRun('r2');
    await effects.writeMeta(rdir, { a: 1, b: 'é' });
    expect(await readFile(join(rdir, 'meta.json'), 'utf8')).toBe(
      '{\n  "a": 1,\n  "b": "\\u00e9"\n}\n',
    );
  });

  it('appends events and best-effort work records as JSON lines', async () => {
    const { effects, stateRoot } = await build();
    await effects.event('blocked', { run_id: 'r' });
    expect(await readFile(join(stateRoot, 'events.jsonl'), 'utf8')).toBe(
      '{"at": "2026-11-26T01:02:03Z", "event": "blocked", "run_id": "r"}\n',
    );
    await effects.workStarted({ type: 'work-started' });
    const line = JSON.parse(
      await readFile(join(stateRoot, 'work', 'records.jsonl'), 'utf8'),
    ) as Record<string, unknown>;
    expect(line.type).toBe('work-started');
    expect(typeof line.host).toBe('string');
  });

  it('fails closed through the injected seams', async () => {
    const { effects } = await build();
    await expect(effects.scan({} as never)).rejects.toThrow('injected seam used');
    await expect(effects.onDemandClone('a/b')).rejects.toThrow('injected seam used');
  });
});
