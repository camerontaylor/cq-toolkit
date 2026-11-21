// Line-location parity of merge-tree repair credit. Python's
// `repair_tick.merge_head_evidence` asks whether the head diff undoes a published
// change AT THE SAME LOCATION (`diff_changed_locations` / `change_undone`);
// identical text elsewhere in the file is not an undo. The TypeScript port once
// compared file-wide line text and refused such heads (the #2297 gap). Every case
// below runs the same throwaway local repository through the real Python function
// (test/helpers/mergeHeadEvidenceOracle.py) and `mergeHeadEvidence`, and the proof
// or the refusal text must be equal. Local repositories only: no network, forge,
// provider or remote write; the fixtures are made with plain `git`.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { changedLocations, changeUndone } from '../../../src/ops/crq/internal/changeUndone.js';
import {
  bothOutcomes,
  lines,
  oracle,
  PATH,
  pythonOk,
  Repo,
  tsOutcome,
  type Scenario,
} from '../../helpers/mergeHeadEvidenceFixtures.js';

describe.skipIf(!pythonOk)(
  'merge-tree credit: change location, not line text (Python oracle)',
  () => {
    let repo: Repo;
    // A twelve-line file where the published repair rewrites line 3 and the text it writes
    // ("fix") already stands at line 9, and a deleted-line repair whose text ("gone") also
    // exists at line 11.
    const BASE = lines(
      'a1',
      'a2',
      'old',
      'gone',
      'a5',
      'a6',
      'a7',
      'a8',
      'fix',
      'a10',
      'gone',
      'a12',
    );
    const REPAIRED = lines('a1', 'a2', 'fix', 'a5', 'a6', 'a7', 'a8', 'fix', 'a10', 'gone', 'a12');
    let base: string;
    let published: string;
    const cases: Record<string, Scenario> = {};

    beforeAll(async () => {
      repo = await Repo.create();
      base = await repo.commit(BASE, 'base');
      published = await repo.commit(REPAIRED, 'published repair');
      const publishedText = REPAIRED.split('\n');
      const edit = (change: (rows: string[]) => string[]): string =>
        lines(...change([...publishedText.slice(0, -1)]));
      const onTop = async (text: string, message: string): Promise<string> => {
        repo.checkout(published);
        return repo.commit(text, message);
      };
      // Heads that descend from the published repair.
      cases.removeIdenticalTextElsewhere = {
        published,
        actual: await onTop(
          edit((r) => r.filter((_, i) => i !== 7)), // the other "fix", line 8
          'delete an identical fix line elsewhere',
        ),
      };
      cases.removeRepairedLine = {
        published,
        actual: await onTop(
          edit((r) => r.filter((_, i) => i !== 2)),
          'delete the repaired line',
        ),
      };
      cases.rewriteRepairedLine = {
        published,
        actual: await onTop(
          edit((r) => r.map((row, i) => (i === 2 ? 'old' : row))),
          'restore the old text of the repaired line',
        ),
      };
      cases.restoreDeletedTextAtGap = {
        published,
        actual: await onTop(
          edit((r) => [...r.slice(0, 2), 'gone', ...r.slice(2)]),
          'reinsert the deleted line where it was',
        ),
      };
      cases.restoreDeletedTextElsewhere = {
        published,
        actual: await onTop(
          edit((r) => [...r.slice(0, 5), 'gone', ...r.slice(5)]),
          'insert the deleted text at an unrelated location',
        ),
      };
      cases.replaceUnrelatedWithDeletedText = {
        published,
        actual: await onTop(
          edit((r) => r.map((row, i) => (i === 5 ? 'gone' : row))),
          'replace an unrelated line with the deleted text',
        ),
      };
      cases.reinsertInsideReplacement = {
        published,
        actual: await onTop(
          edit((r) => [...r.slice(0, 1), 'next', 'gone', ...r.slice(2)]),
          'replace the line before the deletion and reinsert the deleted line',
        ),
      };
      cases.unrelatedEditsAndShiftedLines = {
        published,
        actual: await onTop(
          lines('top', 'extra', ...publishedText.slice(0, -1)).replace('a10', 'a10 tail'),
          'shift every line down and edit elsewhere',
        ),
      };
      cases.formattedRepairedLine = {
        published,
        actual: await onTop(
          edit((r) => r.map((row, i) => (i === 2 ? 'fix ' : row))),
          'reformat',
        ),
      };

      // Forge merge commits over a target that moved: keep, drop and squash.
      repo.checkout(base);
      const targetText = lines(
        'a1',
        'a2',
        'old',
        'gone',
        'a5',
        'a6',
        'a7',
        'a8',
        'a10',
        'gone',
        'a12',
      );
      const target = await repo.commit(
        targetText,
        'target deletes the identical fix line elsewhere',
      );
      cases.keepWithTargetRemovingIdenticalText = { published, merge: repo.merge(published) };
      repo.checkout(target);
      cases.dropRepair = { published, merge: repo.merge(published, true) };
      repo.checkout(target);
      cases.squashWithTargetRemovingIdenticalText = {
        published,
        merge: await repo.commit(
          lines('a1', 'a2', 'fix', 'a5', 'a6', 'a7', 'a8', 'a10', 'gone', 'a12'),
          'squash the repair over the target',
        ),
      };
      repo.checkout(target);
      cases.squashWithoutRepair = {
        published,
        merge: await repo.commit(
          targetText.replace('a12', 'a12 tail'),
          'squash that lost the repair',
        ),
      };
      repo.checkout(target);
      cases.squashRemovesRepairedLine = {
        published,
        merge: await repo.commit(
          lines('a1', 'a2', 'a5', 'a6', 'a7', 'a8', 'a10', 'gone', 'a12'),
          'squash that deleted the repaired line',
        ),
      };
    });
    afterAll(async () => {
      await repo.cleanup();
    });

    const refused = 'merged repair source changed; needs revalidation: ' + PATH;
    const credited: readonly string[] = [
      'removeIdenticalTextElsewhere',
      'restoreDeletedTextElsewhere',
      'replaceUnrelatedWithDeletedText',
      'unrelatedEditsAndShiftedLines',
      'keepWithTargetRemovingIdenticalText',
      'squashWithTargetRemovingIdenticalText',
    ];
    const dropped: readonly string[] = [
      'removeRepairedLine',
      'rewriteRepairedLine',
      'restoreDeletedTextAtGap',
      'reinsertInsideReplacement',
      'dropRepair',
      'squashWithoutRepair',
      'squashRemovesRepairedLine',
      'formattedRepairedLine',
    ];

    test('every scenario gets the Python verdict, proof included', async () => {
      const names = Object.keys(cases);
      const [python, ts] = await bothOutcomes(
        repo,
        names.map((name) => cases[name]!),
      );
      expect(ts).toEqual(python);
      // The two lists below cover every scenario, so the comparison above is never vacuous.
      expect([...credited, ...dropped].sort()).toEqual([...names].sort());
    });

    test.each(credited)(
      'credits %s: identical text at another location is not an undo',
      async (name) => {
        const outcome = await tsOutcome(repo, cases[name]!);
        expect(outcome.error).toBeUndefined();
        expect(outcome.ok).toMatchObject({ match: 'containment' });
      },
    );

    test.each(dropped)('refuses %s: the repair is undone at its own location', async (name) => {
      expect(await tsOutcome(repo, cases[name]!)).toEqual({
        error: 'ValueError',
        message: refused,
      });
    });

    test('keeps the recorded proof shape for a credited merge tree', async () => {
      const outcome = await tsOutcome(repo, cases.squashWithTargetRemovingIdenticalText!);
      expect(outcome.ok).toMatchObject({
        compared_paths: [PATH],
        containment: { [PATH]: { status: 'contained', changed_added: 1, changed_removed: 2 } },
      });
    });
  },
);

describe.skipIf(!pythonOk)('mode and binary heads (Python oracle)', () => {
  let repo: Repo;
  let published: string;
  let binaryHead: string;
  let binaryHeadTextPublication: string;
  let binaryHeadOfTextPublication: string;

  beforeAll(async () => {
    repo = await Repo.create();
    const base = await repo.commit(lines('a', 'b', 'c'), 'base');
    // A mode-only publication: no text hunks to undo, only the mode to keep.
    repo.git('update-index', '--chmod=+x', PATH);
    repo.git('commit', '-q', '-m', 'make executable');
    published = repo.git('rev-parse', 'HEAD');
    await writeFile(join(repo.dir, PATH), Buffer.from([0, 1, 2, 3, 0, 255]));
    repo.git('add', PATH);
    repo.git('update-index', '--chmod=+x', PATH); // `git add` re-reads the 0644 working file
    repo.git('commit', '-q', '-m', 'binary content, mode kept');
    binaryHead = repo.git('rev-parse', 'HEAD');
    repo.checkout(base);
    binaryHeadTextPublication = await repo.commit(lines('a', 'FIXED', 'c'), 'text publication');
    await writeFile(join(repo.dir, PATH), Buffer.from([0, 1, 2, 3, 0, 255]));
    repo.git('add', PATH);
    repo.git('commit', '-q', '-m', 'binary replaces the repaired text');
    binaryHeadOfTextPublication = repo.git('rev-parse', 'HEAD');
  });
  afterAll(async () => {
    await repo.cleanup();
  });

  test('a mode-only repair is judged on its mode, not on a binary head diff', async () => {
    const scenarios: Scenario[] = [
      { published, actual: binaryHead },
      { published: binaryHeadTextPublication, actual: binaryHeadOfTextPublication },
    ];
    const [python, ts] = await bothOutcomes(repo, scenarios);
    expect(ts).toEqual(python);
    expect(ts[0]?.ok).toMatchObject({ match: 'containment' });
    // A text repair is never credited when the head replaced it with a blob.
    expect(ts[1]?.error).toBe('ValueError');
  });
});

describe('location comparison (pure)', () => {
  const published = '@@ -3 +3 @@\n-old\n+fix\n';
  const undone = (publishedPatch: string, head: string): [string, string][] =>
    changeUndone(changedLocations(publishedPatch), changedLocations(head)).map(([line, text]) => [
      line.toString(),
      text,
    ]);

  test('the same text at another location is not an undo', () => {
    expect(undone(published, '@@ -9 +8,0 @@\n-fix\n')).toEqual([]);
  });
  test('removing the published line at its location is an undo', () => {
    expect(undone(published, '@@ -3 +2,0 @@\n-fix\n')).toEqual([['3', 'fix']]);
  });
  test('reinserting a published deletion at its gap is an undo, elsewhere is not', () => {
    const deleted = '@@ -4 +3,0 @@\n-gone\n';
    expect(undone(deleted, '@@ -3,0 +4 @@\n+gone\n')).toEqual([['3', 'gone']]);
    expect(undone(deleted, '@@ -8,0 +9 @@\n+gone\n')).toEqual([]);
  });
  test('a replacement hunk covering the deletion gap matches on added text', () => {
    const deleted = '@@ -4 +3,0 @@\n-gone\n';
    expect(undone(deleted, '@@ -3 +3,2 @@\n-prev\n+next\n+gone\n')).toEqual([['3', 'gone']]);
    expect(undone(deleted, '@@ -7 +7,2 @@\n-hold\n+gone\n+keep\n')).toEqual([]);
  });
});

describe.skipIf(!pythonOk)('location comparison against the Python function', () => {
  const header = (start: string, count?: string, newStart = start, newCount?: string): string =>
    `@@ -${start}${count === undefined ? '' : ',' + count} +${newStart}${newCount === undefined ? '' : ',' + newCount} @@`;
  const pairs: [string, string][] = [
    // The Python unit cases.
    ['@@ -3 +3 @@\n-old\n+fix\n', '@@ -9 +8,0 @@\n-fix\n'],
    ['@@ -3 +3 @@\n-old\n+fix\n', '@@ -3 +2,0 @@\n-fix\n'],
    ['@@ -4 +3,0 @@\n-gone\n', '@@ -3,0 +4 @@\n+gone\n'],
    ['@@ -4 +3,0 @@\n-gone\n', '@@ -8,0 +9 @@\n+gone\n'],
    ['@@ -4 +3,0 @@\n-gone\n', '@@ -3 +3,2 @@\n-prev\n+next\n+gone\n'],
    ['@@ -4 +3,0 @@\n-gone\n', '@@ -7 +7,2 @@\n-hold\n+gone\n+keep\n'],
    // Several files and hunks; a hunk is closed by the next file header.
    [
      'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9,2 +9,3 @@\n-c\n-d\n+e\n+f\n+g\n',
      'diff --git a/x b/x\n@@ -1 +1 @@\n-b\n+a\n@@ -9,3 +9,2 @@\n-e\n-f\n-g\n+c\n+d\ndiff --git a/y b/y\n@@ -2,0 +3 @@\n+z\n',
    ],
    // Count spellings: `,0` anchors on the line itself, `,00` does not; missing count is one.
    ['@@ -5,00 +4 @@\n-q\n', '@@ -4,0 +5 @@\n+q\n'],
    ['@@ -5,0 +5,0 @@\n+q\n', '@@ -5,0 +5,0 @@\n-q\n'],
    ['@@ -7 +6,0 @@\n-q\n', '@@ -6,1 +7,1 @@\n-p\n+q\n'],
    // Unicode digits, leading zeros and integers beyond 2**53 all parse like Python's int().
    ['@@ -٣ +٣ @@\n-old\n+fix\n', '@@ -3 +2,0 @@\n-fix\n'],
    ['@@ -003 +0003 @@\n-old\n+fix\n', '@@ -3 +2,0 @@\n-fix\n'],
    [
      '@@ -9007199254740993 +9007199254740993 @@\n-old\n+fix\n',
      '@@ -9007199254740993 +1,0 @@\n-fix\n',
    ],
    [
      '@@ -9007199254740993 +9007199254740993 @@\n-old\n+fix\n',
      '@@ -9007199254740992 +1,0 @@\n-fix\n',
    ],
    // Not a hunk header: lines are ignored until the next one.
    ['@@ -x +1 @@\n-old\n+fix\n', '@@ -1 +1 @@\n-fix\n'],
    ['-old\n+fix\n', '-fix\n+old\n'],
    // Python line boundaries inside content split a line into a fake header or fake change.
    ['@@ -3 +3 @@\n-old\n+fix @@ -1 +1 @@\n+x\n', '@@ -3 +2,0 @@\n-fix\n'],
    ['@@ -3 +3 @@\n-old\n+fix\f+more\n', '@@ -4 +2,0 @@\n-more\n'],
    ['@@ -3 +3 @@\r\n-old\r\n+fix\r\n', '@@ -3 +2,0 @@\r\n-fix\r\n'],
    ['@@ -3 +3 @@\n-\udc80\n+\udcff\n', '@@ -3 +2,0 @@\n-\udcff\n'],
    // Equal line numbers order texts by code point, not by UTF-16 unit.
    ['@@ -1,0 +1,2 @@\n+😀\n+￿\n', '@@ -1,2 +1,0 @@\n-😀\n-￿\n'],
    ['', ''],
  ];
  // Deterministic generated hunks over a small alphabet, so equal text recurs at many locations.
  function generated(seed: number): [string, string] {
    let state = seed;
    const next = (n: number): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    const patch = (): string => {
      const out: string[] = [];
      let old = 1 + next(4);
      for (let h = next(4) + 1; h > 0; h -= 1) {
        const del = next(3);
        const ins = next(3);
        const oldCount = del === 1 && next(2) ? undefined : String(del);
        const newCount = ins === 1 && next(2) ? undefined : String(ins);
        out.push(header(String(old), oldCount, String(old + next(3)), newCount));
        for (let i = 0; i < del; i += 1) out.push('-' + 'ab'[next(2)]);
        for (let i = 0; i < ins; i += 1) out.push('+' + 'ab'[next(2)]);
        old += del + 1 + next(4);
      }
      return out.join('\n') + '\n';
    };
    return [patch(), patch()];
  }
  for (let seed = 1; seed <= 300; seed += 1) pairs.push(generated(seed));

  test('every changed location pair gets the Python answer', () => {
    const python = oracle(pairs.map(([p, h]) => ({ op: 'undone', published: p, head: h })));
    const ts = pairs.map(([p, h]) => ({
      ok: changeUndone(changedLocations(p), changedLocations(h)).map(([line, text]) => [
        line.toString(),
        text,
      ]),
    }));
    expect(ts).toEqual(python);
    // The generator reaches both outcomes, so agreement is not trivially "always empty".
    expect(ts.filter((r) => r.ok.length).length).toBeGreaterThan(20);
    expect(ts.filter((r) => !r.ok.length).length).toBeGreaterThan(20);
  });

  test('an integer beyond the 4300-digit conversion limit fails like Python', () => {
    const digits = '9'.repeat(4301);
    const patch = `@@ -${digits} +1 @@\n-x\n`;
    const [python] = oracle([{ op: 'undone', published: patch, head: '' }]);
    expect(python?.error).toBe('ValueError');
    expect(() => changedLocations(patch)).toThrow(python!.message!);
    expect(changedLocations(`@@ -${'9'.repeat(4300)} +1 @@\n-x\n`).removed.size).toBe(1);
  });
});
