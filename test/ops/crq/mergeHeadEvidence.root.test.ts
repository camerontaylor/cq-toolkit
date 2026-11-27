// Root-publication parity of merge-tree repair credit. Python's
// `repair_tick.published_change_patch` diffs a parented publication from the parent of
// its first commit through the published head, but diffs a ROOT publication (first
// commit without a parent) as that root commit alone (`diff-tree --root`). The
// TypeScript port once diffed the empty tree through the published head, so a repair
// made by commits after the root was judged by TS and ignored by Python (the
// documented #2308 gap). Every case runs one disposable local repository through the
// real Python function (test/helpers/mergeHeadEvidenceOracle.py) and
// `mergeHeadEvidence`; the proof or the refusal text must be equal. Local repositories
// only: no network, forge, provider or remote write.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  bothOutcomes,
  lines,
  PATH,
  pythonOk,
  Repo,
  tsOutcome,
  type Scenario,
} from '../../helpers/mergeHeadEvidenceFixtures.js';

const refused = 'merged repair source changed; needs revalidation: ' + PATH;

/** Commit `text` on top of `parent`, as a head that descends from the publication. */
async function onTop(repo: Repo, parent: string, text: string, message: string): Promise<string> {
  repo.checkout(parent);
  return repo.commit(text, message);
}

describe.skipIf(!pythonOk)('single root publication (Python oracle)', () => {
  let repo: Repo;
  const cases: Record<string, Scenario> = {};

  beforeAll(async () => {
    repo = await Repo.create();
    const root = await repo.commit(lines('r1', 'fix', 'r3'), 'root repair');
    const publication = { published: root, commits: [root] };
    cases.keepsRepair = {
      ...publication,
      actual: await onTop(repo, root, lines('r1', 'fix', 'r3', 'r4'), 'append'),
    };
    cases.deletesRepairedLine = {
      ...publication,
      actual: await onTop(repo, root, lines('r1', 'r3'), 'delete the repaired line'),
    };
    cases.rewritesRepairedLine = {
      ...publication,
      actual: await onTop(repo, root, lines('r1', 'old', 'r3'), 'rewrite the repaired line'),
    };
  });
  afterAll(async () => {
    await repo.cleanup();
  });

  test('every scenario gets the Python verdict, proof included', async () => {
    const [python, ts] = await bothOutcomes(repo, Object.values(cases));
    expect(ts).toEqual(python);
  });
  test('credits a head that keeps the root repair', async () => {
    expect((await tsOutcome(repo, cases.keepsRepair!)).ok).toMatchObject({
      match: 'containment',
      containment: { [PATH]: { status: 'contained', published_parent: null, mode_checked: true } },
    });
  });
  test.each(['deletesRepairedLine', 'rewritesRepairedLine'])(
    'refuses %s: the root repair is undone at its own location',
    async (name) => {
      expect(await tsOutcome(repo, cases[name]!)).toEqual({
        error: 'ValueError',
        message: refused,
      });
    },
  );
});

describe.skipIf(!pythonOk)('root plus later commits (Python oracle)', () => {
  let repo: Repo;
  let root: string;
  let fixed: string;
  const cases: Record<string, Scenario> = {};

  beforeAll(async () => {
    repo = await Repo.create();
    root = await repo.commit(lines('old', 'keep'), 'root');
    fixed = await repo.commit(lines('fixed', 'keep'), 'later repair');
    const rootPlusLater = { published: fixed, commits: [root, fixed] };
    // The head puts the root text back over the later repair. Python's change is the
    // root commit alone, so nothing it added is removed: credited. An empty-tree span
    // would have called `fixed` the change and refused.
    const reverted = await onTop(repo, fixed, lines('old', 'keep'), 'revert to the root text');
    cases.revertsLaterRepair = { ...rootPlusLater, actual: reverted };
    cases.keepsBoth = {
      ...rootPlusLater,
      actual: await onTop(repo, fixed, lines('fixed', 'keep', 'more'), 'append'),
    };
    // Removing a line the root added is an undo under either span.
    cases.deletesRootLine = {
      ...rootPlusLater,
      actual: await onTop(repo, fixed, lines('fixed'), 'delete a root line'),
    };
    // The same head against an ordinary (parented) publication of just the repair:
    // its change is `parent..published`, so reverting it is refused.
    cases.parentedPublicationRevert = {
      published: fixed,
      commits: [fixed],
      actual: reverted,
    };
  });
  afterAll(async () => {
    await repo.cleanup();
  });

  test('every scenario gets the Python verdict, proof included', async () => {
    const [python, ts] = await bothOutcomes(repo, Object.values(cases));
    expect(ts).toEqual(python);
  });
  test('credits reverting the later repair: only the root commit is the published change', async () => {
    const proof = (await tsOutcome(repo, cases.revertsLaterRepair!)).ok as {
      containment: Record<string, { status: string; changed_added: number; patch_bytes: number }>;
    };
    expect(proof.containment[PATH]).toMatchObject({
      status: 'contained',
      published_parent: null,
      // The root diff adds the two root lines; the later repair is not counted.
      changed_added: 2,
      changed_removed: 0,
    });
  });
  test('credits a head that keeps the file and appends', async () => {
    expect((await tsOutcome(repo, cases.keepsBoth!)).ok).toMatchObject({ match: 'containment' });
  });
  test.each(['deletesRootLine', 'parentedPublicationRevert'])('refuses %s', async (name) => {
    expect(await tsOutcome(repo, cases[name]!)).toEqual({
      error: 'ValueError',
      message: refused,
    });
  });
});

describe.skipIf(!pythonOk)('empty root commit before the repair (Python oracle)', () => {
  let repo: Repo;
  let published: string;
  const cases: Record<string, Scenario> = {};

  beforeAll(async () => {
    repo = await Repo.create();
    repo.git('commit', '-q', '--allow-empty', '-m', 'empty root');
    const root = repo.git('rev-parse', 'HEAD');
    published = await repo.commit(lines('x1', 'x2'), 'adds the file');
    const publication = { published, commits: [root, published] };
    // The root commit never touched the path, so Python sees no published change for
    // it, whatever the later commits did, and credits any head that still has the file.
    cases.rewritesLaterRepair = {
      ...publication,
      actual: await onTop(repo, published, lines('y1', 'x2'), 'rewrite the added line'),
    };
    cases.deletesFile = {
      ...publication,
      actual: await (async () => {
        repo.checkout(published);
        repo.git('rm', '-q', PATH);
        repo.git('commit', '-q', '-m', 'delete the file');
        return repo.git('rev-parse', 'HEAD');
      })(),
    };
  });
  afterAll(async () => {
    await repo.cleanup();
  });

  test('every scenario gets the Python verdict, proof included', async () => {
    const [python, ts] = await bothOutcomes(repo, Object.values(cases));
    expect(ts).toEqual(python);
  });
  test('credits a rewrite as unchanged-by-publication; refuses a deleted live path', async () => {
    expect((await tsOutcome(repo, cases.rewritesLaterRepair!)).ok).toMatchObject({
      containment: { [PATH]: { status: 'unchanged-by-publication', published_parent: null } },
    });
    expect(await tsOutcome(repo, cases.deletesFile!)).toEqual({
      error: 'ValueError',
      message: refused,
    });
  });
});
