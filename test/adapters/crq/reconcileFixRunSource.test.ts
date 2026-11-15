import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileFixRunSeams } from '../../../src/adapters/crq/reconcileFixRunSource.js';
import type { GhResult } from '../../../src/adapters/forge-github/gh.js';
import { SourcePublicationFailed } from '../../../src/ops/crq/internal/reconcileFixRun.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const MERGE = 'a'.repeat(40);
const FID = 'b'.repeat(64);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fix-run-source-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const obj = (value: unknown): JsonObject => parseJsonValue(JSON.stringify(value)) as JsonObject;
const ok = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const writeJob = async (id: string, job: unknown): Promise<void> => {
  await mkdir(join(root, 'repair', 'inbox'), { recursive: true });
  await writeFile(join(root, 'repair', 'inbox', `${id}.json`), JSON.stringify(job));
};
const COMMENT = {
  path: 'a.ts',
  body: '**crq finding F3 [x]**\n<sub>crq run `rr`</sub>',
};
const SOURCE_JOB = {
  job: 'j1',
  run: 'rr',
  pr: 5,
  source: { finding_number: 3, run: 'rr' },
  finding: { path: 'a.ts' },
};
const RECORD = {
  jobs: ['j1'],
  fix_pr: { number: 7 },
  publication: { head: 'h', commits: ['c'], source_resolutions: [] },
  verdicts: [{ job: 'j1', verdict: 'FIXED' }],
};
const graph = (comments: unknown[]) => [
  {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: comments.map((c, i) => ({ id: `T${i}`, comments: { nodes: [c] } })),
          },
        },
      },
    },
  },
];

function bind(route: (args: string[]) => GhResult, calls: string[][] = []) {
  const seams = fileFixRunSeams({
    stateRoot: root,
    clone: '/fake/clone',
    repo: 'o/r',
    prInfo: async (number) => obj({ asked: number instanceof JsonObject ? 0 : String(number) }),
    gh: async (args) => {
      calls.push(args);
      return route(args);
    },
    runGit: async (args) => ({ args, code: 1, stdout: new Uint8Array(), stderr: '' }),
    now: () => new Date('2026-11-15T01:02:03.999Z'),
  });
  return seams(obj({ id: 'i1', repair_runs: { rr: RECORD } }), 'rr');
}
const info = obj({ number: 7, state: 'MERGED' });

/** The journal this record names, so the re-verification passes. */
async function writeJournal(extra: unknown): Promise<void> {
  await mkdir(join(root, 'repair', 'j1'), { recursive: true });
  await writeFile(
    join(root, 'repair', 'j1', 'publication.json'),
    JSON.stringify({ ...RECORD.publication, ...(extra as object) }),
  );
}

describe('fileFixRunSeams', () => {
  it('rejects an unsafe repo or job id', async () => {
    expect(() =>
      fileFixRunSeams({ stateRoot: root, clone: '/c', repo: '../x', prInfo: async () => obj({}) }),
    ).toThrow('invalid repo');
    const seams = bind(() => ok([]));
    await expect(seams.markFixedOutcome('../evil', MERGE, 'u', null)).rejects.toThrow(
      'invalid repair job id',
    );
  });

  it('writes nothing for a job without a canonical finding id', async () => {
    await writeJob('j1', { job: 'j1' });
    await expect(
      bind(() => ok([])).markFixedOutcome('j1', MERGE, 'u', null),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the ledger rollout is not configured', async () => {
    await writeJob('j1', { job: 'j1', canonical_finding_id: FID });
    await expect(bind(() => ok([])).markFixedOutcome('j1', MERGE, 'u', null)).rejects.toThrow(
      'backfill repair write-back requires existing ledger configuration',
    );
  });

  it('rechecks against the journal on disk, reading the PR by number', async () => {
    const calls: string[][] = [];
    const seams = bind(() => ok([]), calls);
    await expect(
      seams.recheckRevalidation(obj(RECORD), info, obj({ reason: 'r' })),
    ).rejects.toThrow('publication journal missing');
    await writeJournal({ fixed_revalidation: { reason: 'r' } });
    await expect(
      seams.recheckRevalidation(
        obj({
          ...RECORD,
          publication: { ...RECORD.publication, fixed_revalidation: { reason: 'r' } },
        }),
        info,
        obj({ reason: 'other' }),
      ),
    ).rejects.toThrow('fixed revalidation changed');
  });

  describe('publishSource', () => {
    const publish = (
      seams: ReturnType<typeof bind>,
      record: JsonObject = obj({
        ...RECORD,
        publication: { ...RECORD.publication, fixed_revalidation: { reason: 'r' } },
      }),
    ) => seams.publishSource(record, info, { proof: null, projected: false }, MERGE);

    it('does nothing without a publication', async () => {
      const calls: string[][] = [];
      const seams = bind(() => ok([]), calls);
      const record = obj({ ...RECORD, publication: undefined });
      await expect(publish(seams, record)).resolves.toEqual({ pending: false });
      expect(calls).toEqual([]);
    });

    it('comments, resolves the matching thread and journals the job', async () => {
      await writeJob('j1', SOURCE_JOB);
      const calls: string[][] = [];
      const seams = bind((args) => {
        if (args[1]?.endsWith('/issues/5/comments')) return ok([[]]);
        if (args[0] === 'pr') return { code: 0, stdout: '', stderr: '' };
        if (args.includes('--input'))
          return ok({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
        return ok(graph([{ path: 'a.ts', body: 'unrelated' }, COMMENT]));
      }, calls);
      const record = obj({ ...RECORD, publication: { ...RECORD.publication } });
      const done = await publish(seams, record);
      expect(done.pending).toBe(false);
      const journal = JSON.parse(
        await readFile(join(root, 'repair/j1/publication.json'), 'utf8'),
      ) as {
        source_resolutions: string[];
      };
      expect(journal.source_resolutions).toEqual(['j1']);
      expect(await readFile(join(root, 'repair/j1/source-j1.md'), 'utf8')).toBe(
        `<!-- crq-repair-source:j1 -->\nFixed in [${MERGE}](https://github.com/o/r/commit/${MERGE}).\n`,
      );
      const request = JSON.parse(
        await readFile(join(root, 'repair/j1/resolve-j1.json'), 'utf8'),
      ) as {
        variables: { threadId: string };
      };
      expect(request.variables.threadId).toBe('T1');
      expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
        'api repos/o/r/issues/5/comments',
        'pr comment',
        'api graphql',
        'api graphql',
      ]);
      expect(calls[1]).toEqual([
        'pr',
        'comment',
        '5',
        '--repo',
        'o/r',
        '--body-file',
        join(root, 'repair/j1/source-j1.md'),
      ]);
    });

    it('skips the comment when the marker is already there', async () => {
      await writeJob('j1', { ...SOURCE_JOB, source_thread_id: 'T9' });
      const calls: string[][] = [];
      const seams = bind((args) => {
        if (args[1]?.endsWith('/issues/5/comments'))
          return ok([[{ body: 'x <!-- crq-repair-source:j1 --> y' }]]);
        return ok({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
      }, calls);
      await publish(seams);
      expect(calls.map((c) => c[0])).toEqual(['api', 'api']);
      expect(calls[1]).toContain('--input');
    });

    it('keeps feedback pending when only REST sees the thread', async () => {
      await writeJob('j1', SOURCE_JOB);
      const seams = bind((args) => {
        if (args[1]?.endsWith('/issues/5/comments'))
          return ok([[{ body: '<!-- crq-repair-source:j1 -->' }]]);
        if (args[1] === 'repos/o/r/pulls/5/comments') return ok([[COMMENT]]);
        return ok(graph([]));
      });
      const done = await publish(seams);
      expect(done.pending).toBe(true);
      await expect(readFile(join(root, 'repair/j1/publication.json'))).rejects.toThrow();
    });

    it('treats an absent thread as complete and rejects an ambiguous one', async () => {
      await writeJob('j1', SOURCE_JOB);
      const marker = [[{ body: '<!-- crq-repair-source:j1 -->' }]];
      const none = bind((args) =>
        args[1]?.endsWith('/issues/5/comments')
          ? ok(marker)
          : args[1]?.startsWith('repos/')
            ? ok([[]])
            : ok(graph([])),
      );
      expect((await publish(none)).pending).toBe(false);
      const two = bind((args) =>
        args[1]?.endsWith('/issues/5/comments') ? ok(marker) : ok(graph([COMMENT, COMMENT])),
      );
      const error: unknown = await publish(two).catch((x: unknown) => x);
      expect(error).toBeInstanceOf(SourcePublicationFailed);
      expect((error as Error).message).toBe(
        'ambiguous source thread; retain publication for retry',
      );
    });

    it('fails when the resolution mutation is not confirmed', async () => {
      await writeJob('j1', { ...SOURCE_JOB, source_thread_id: 'T9' });
      const seams = bind((args) =>
        args[1]?.endsWith('/issues/5/comments')
          ? ok([[{ body: '<!-- crq-repair-source:j1 -->' }]])
          : ok({
              errors: [{ message: 'no' }],
              data: { resolveReviewThread: { thread: { isResolved: true } } },
            }),
      );
      const error: unknown = await publish(seams).catch((x: unknown) => x);
      expect((error as Error).message).toBe('source thread resolution unconfirmed');
    });
  });
});
