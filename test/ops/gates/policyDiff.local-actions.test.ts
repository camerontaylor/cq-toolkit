import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  HOOK_MS,
  SLOW,
  kinds,
  localActionFixtures,
  run,
  setupFixtures,
  teardownFixtures,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('policyDiff: local actions of required-check producers', SLOW, () => {
  const la = localActionFixtures();
  const {
    judge,
    changed,
    notLiteral,
    GATE,
    INNER,
    INNER_SCRIPT,
    MOVED,
    MOVED_SCRIPT,
    OTHER,
    PRODUCER,
    TWIN_PATH,
  } = la;
  let c: Record<string, string>;
  let twinTrust: string;
  beforeAll(async () => {
    await la.setup();
    c = la.c;
    twinTrust = la.twinTrust;
  }, HOOK_MS);

  test('an edit only to a local action a producer runs needs a human under diff-check', async () => {
    const out = await judge('la-action-edit');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: GATE, reason: 'changes a protected path' },
      changed(GATE, '.github/actions/gate'),
    ]);
    expect(out.verdict).toBe('needs-human');
    expect((await judge('la-action-edit', 'human')).verdict).toBe('needs-human');
  });

  test('a comment-only edit to the action metadata is still a producer change', async () => {
    // Unlike workflow job text, a local action is compared by path, not normalised text.
    const out = await judge('la-comment');
    expect(out.findings).toContainEqual(changed(GATE, '.github/actions/gate'));
    expect(out.verdict).toBe('needs-human');
  });

  test('any file under a nested local action is followed transitively', async () => {
    const out = await judge('la-nested-edit');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: INNER_SCRIPT, reason: 'changes a protected path' },
      changed(INNER_SCRIPT, '.github/actions/inner'),
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test('unchanged local actions add no finding', async () => {
    const out = await judge('la-unrelated');
    expect(out.findings).toEqual([]);
    expect(out.verdict).toBe('pass');
  });

  test('a local action no producer runs is only a protected path', async () => {
    const out = await judge('la-other-action');
    expect(kinds(out)).toEqual(['protected-path']);
    expect(out.verdict).toBe('pass');
  });

  test('nested-use cycles terminate and are judged by path', async () => {
    const out = await judge('la-cycle');
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: INNER, reason: 'changes a protected path' },
      changed(INNER, '.github/actions/inner'),
    ]);
    expect(out.verdict).toBe('needs-human');
  });

  test.each([
    ['la-metadata-gone', 'no action.yml or action.yaml'],
    ['la-metadata-symlink', 'not a regular file'],
  ])('local action metadata unreadable at the subject (%s) fails closed', async (name, why) => {
    const out = await judge(name);
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: './.github/actions/inner',
      reason: expect.stringMatching(
        new RegExp(
          `^local action of required check static unresolvable at the subject \\(${PRODUCER.replace(/\./g, '\\.')}: .*${why}`,
        ),
      ) as unknown,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a `..` escape in a nested local use fails closed', async () => {
    const out = await judge('la-escape');
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: './.github/../outside',
      reason: expect.stringContaining('unresolvable at the subject') as unknown,
    });
    expect(out.findings.find((f) => f.path === './.github/../outside')?.reason).toContain(
      'dot segment',
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('a nesting chain past the depth bound fails closed', async () => {
    const out = await judge('la-deep');
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        kind: 'required-check',
        reason: expect.stringContaining(`${PRODUCER} nests local actions deeper than 8`) as unknown,
      }),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('a nesting chain whose past-the-bound target was already visited is not flagged', async () => {
    const out = await judge('la-deep-dedup');
    expect(out.findings.filter((f) => f.reason.includes('nests local actions deeper'))).toEqual([]);
    expect(out.findings.filter((f) => f.reason.includes('unresolvable'))).toEqual([]);
  });

  test.each(['la-hidden-cr', 'la-hidden-ls'])(
    'a `uses:` hidden behind a YAML line break other than \\n (%s) fails closed',
    async (name) => {
      const out = await judge(name);
      expect(out.findings).toContainEqual({
        kind: 'required-check',
        path: './.github/actions/gate',
        reason: expect.stringContaining(`${GATE}: unreadable uses line`) as unknown,
      });
      expect(out.verdict).toBe('needs-human');
    },
  );

  test('a root `uses:` continued onto the next line fails closed', async () => {
    const out = await judge('la-root-continued');
    expect(out.findings).toContainEqual(notLiteral('subject'));
    expect(out.verdict).toBe('needs-human');
  });

  test('a nested `uses:` continued onto the next line fails closed', async () => {
    const out = await judge('la-nested-continued');
    // The unresolvable target is the action whose METADATA is ambiguous
    // (gate), as for the hidden-line cases, not the action it names.
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: './.github/actions/gate',
      reason: expect.stringContaining(
        `${GATE}: uses value continues onto the next line`,
      ) as unknown,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('prose with "causes" or "statuses" in metadata is not an unreadable uses line', async () => {
    const out = await judge('la-prose-causes');
    expect(out.findings.filter((f) => f.reason.includes('unreadable uses line'))).toEqual([]);
    expect(out.findings).toContainEqual(changed(GATE, '.github/actions/gate'));
  });

  test('an unreadable `uses:` in unchanged metadata fails closed at both ends', async () => {
    const out = await judge('la-broken-unrelated');
    for (const side of ['range base', 'subject']) {
      expect(out.findings).toContainEqual({
        kind: 'required-check',
        path: './.github/actions/gate',
        reason: expect.stringContaining(
          `unresolvable at the ${side} (${PRODUCER}: ${GATE}: unreadable uses line`,
        ) as unknown,
      });
    }
    expect(out.verdict).toBe('needs-human');
  });

  test('a block-scalar `uses:` in an unchanged producer fails closed at both ends', async () => {
    // workflowScan reads no literal from `uses: >-`, so localUses omits it.
    const out = await judge('la-broken-unrelated');
    expect(out.findings).toContainEqual(notLiteral('range base'));
    expect(out.findings).toContainEqual(notLiteral('subject'));
  });

  test('a block-scalar `uses:` in a producer at the subject fails closed', async () => {
    const out = await judge('la-root-block');
    expect(out.findings).toContainEqual(notLiteral('subject'));
    expect(out.findings).not.toContainEqual(notLiteral('range base'));
    expect(out.verdict).toBe('needs-human');
  });

  test('a sibling sharing the action directory as a name prefix is not under it', async () => {
    const out = await judge('la-sibling');
    expect(out.findings).toEqual([
      {
        kind: 'protected-path',
        path: '.github/actions/gate2/x',
        reason: 'changes a protected path',
      },
    ]);
    expect(out.verdict).toBe('pass');
  });

  test('a nested reference added at the subject is traced there', async () => {
    const out = await judge('la-ref-add');
    expect(out.findings).toContainEqual(changed(GATE, '.github/actions/gate'));
    expect(out.findings).toContainEqual(changed(OTHER, '.github/actions/other'));
    expect(out.verdict).toBe('needs-human');
  });

  test('a nested reference removed at the subject is still traced at the range base', async () => {
    const out = await judge('la-ref-remove');
    expect(out.findings).toContainEqual(changed(GATE, '.github/actions/gate'));
    expect(out.findings).toContainEqual(changed(INNER_SCRIPT, '.github/actions/inner'));
    expect(out.verdict).toBe('needs-human');
  });

  test('a renamed nested action is traced under both names', async () => {
    const out = await judge('la-ref-rename');
    for (const [path, target] of [
      [GATE, '.github/actions/gate'],
      [INNER, '.github/actions/inner'],
      [INNER_SCRIPT, '.github/actions/inner'],
      [MOVED, '.github/actions/moved'],
      [MOVED_SCRIPT, '.github/actions/moved'],
    ] as const) {
      expect(out.findings).toContainEqual(changed(path, target));
    }
    expect(out.findings.filter((f) => f.reason.includes('unresolvable'))).toEqual([]);
    expect(out.verdict).toBe('needs-human');
  });

  test.each(['la-value-single-quoted', 'la-value-double-quoted', 'la-value-comment'])(
    'a nested `uses:` value read through quotes or a trailing comment is traced (%s)',
    async (name) => {
      const out = await judge(name);
      expect(out.findings).toContainEqual(changed(OTHER, '.github/actions/other'));
      expect(out.findings.filter((f) => f.reason.includes('unresolvable'))).toEqual([]);
      expect(out.verdict).toBe('needs-human');
    },
  );

  test.each([
    'la-key-double-quoted',
    'la-key-single-quoted',
    'la-key-uppercase',
    'la-key-escaped',
    'la-key-explicit',
    'la-value-hash',
  ])('a nested `uses` the strict line scan does not read fails closed (%s)', async (name) => {
    const out = await judge(name);
    expect(out.findings).toContainEqual({
      kind: 'required-check',
      path: './.github/actions/gate',
      reason: expect.stringContaining(
        `unresolvable at the subject (${PRODUCER}: ${GATE}: unreadable uses line`,
      ) as unknown,
    });
    expect(out.verdict).toBe('needs-human');
  });

  test('a change under an action two required checks run is one finding per check', async () => {
    const out = await run(c['la-action-edit']!, 'diff-check', {
      base: 'refs/remotes/origin/merge-queue',
      trustRef: twinTrust,
    });
    expect(out.findings).toEqual([
      { kind: 'protected-path', path: GATE, reason: 'changes a protected path' },
      changed(GATE, '.github/actions/gate'),
      {
        kind: 'required-check',
        path: GATE,
        reason: `changes ${GATE} in local action ./.github/actions/gate run by ${TWIN_PATH}:twin, a producer of required check twin`,
      },
    ]);
    expect(out.verdict).toBe('needs-human');
  });
});
