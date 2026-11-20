import { describe, expect, it } from 'vitest';
import { fileEnrollmentPhaseEffects } from '../../../src/adapters/crq/tickEnrollmentPhaseSource.js';
import type { OpenPrRepository } from '../../../src/adapters/crq/openPrDiscoverySource.js';
import { runEnrollmentPhase } from '../../../src/queue-runner/tickDiscoveryPhase.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const primary: OpenPrRepository = {
  repo: 'o/main',
  name: 'main',
  clone: '/p',
  defaultBranch: 'main',
  primary: true,
  enabled: true,
  branches: ['main'],
};
const other: OpenPrRepository = {
  ...primary,
  repo: 'o/lib',
  name: 'lib',
  clone: '/l',
  primary: false,
};
const q = (value: unknown): JsonObject => parseJsonValue(JSON.stringify(value)) as JsonObject;
const text = (s: string) => new TextEncoder().encode(s);

function build(extra: Partial<Parameters<typeof fileEnrollmentPhaseEffects>[0]> = {}) {
  const listed: string[] = [];
  const events: string[] = [];
  const effects = fileEnrollmentPhaseEffects({
    repos: [primary, other],
    primaryRepo: 'o/main',
    localReview: { facts: async () => null, retained: async () => false },
    event: async (id) => {
      events.push(id);
    },
    now: () => new Date('2026-11-15T01:02:03.456Z'),
    gh: async (args) => {
      listed.push(args[args.indexOf('--repo') + 1] ?? '');
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify([
          {
            number: 7,
            isDraft: false,
            isCrossRepository: false,
            baseRefName: 'main',
            headRefName: 'f',
            headRefOid: HEAD,
          },
        ]),
      };
    },
    git: () => async (args) => ({
      args,
      code: 0,
      stdout: text(args[0] === 'merge-base' ? BASE : ''),
      stderr: '',
    }),
    ...extra,
  });
  return { effects, listed, events };
}
const names = (queue: JsonObject) =>
  (queue.get('items') as JsonObject[]).map((i) => String(i.get('id')));

describe('tick enrollment phase source', () => {
  it('enrolls primary before others, each repo only in its own pass', async () => {
    const { effects, listed, events } = build();
    const result = await runEnrollmentPhase(q({ items: [] }), false, effects);
    expect(listed).toEqual(['o/main', 'o/lib']);
    expect(names(result.queue)).toEqual(['pr7', 'lib-pr7']);
    expect(events).toEqual(['pr7', 'lib-pr7']);
    expect(result.log).toEqual(['enrolled pr7', 'enrolled lib-pr7']);
  });

  it('runs a single pass for one side without touching the other repo', async () => {
    const { effects, listed } = build();
    const result = await effects.others(q({ items: [] }), true);
    expect(listed).toEqual(['o/lib']);
    expect(result.log).toEqual(['DRY-RUN would enroll lib-pr7']);
  });

  it('skips a PR already linked to an equivalent local-review item', async () => {
    const stored = {
      id: 'lr',
      kind: 'local-review',
      state: 'pending',
      identity_inputs: {
        repo: 'o/main',
        base_commit: BASE,
        head_commit: HEAD,
        scope: 's',
        projection: 'p',
        config_digest: 'd',
        profile: { a: 1 },
      },
    };
    const { effects, events } = build({
      localReview: { facts: async () => q(stored.identity_inputs), retained: async () => false },
    });
    const result = await effects.primary(q({ items: [stored] }), false);
    expect(names(result.queue)).toEqual(['lr']);
    expect(events).toEqual([]);
    const links = result.queue.get('review_pr_links') as JsonObject;
    expect((links.get('o/main#7') as JsonObject).get('item')).toBe('lr');
  });

  it('a failing forge listing skips that repo with a log line only', async () => {
    const { effects } = build({ gh: async () => ({ code: 1, stderr: 'boom', stdout: '' }) });
    const result = await effects.primary(q({ items: [] }), false);
    // Python's primary `enroll` (crq.py:3127) logs `enrollment skipped: <exc>`.
    expect(result.log).toEqual(['enrollment skipped: forge listing unavailable']);
    expect(names(result.queue)).toEqual([]);
  });

  it('a failing forge listing for a configured repo keeps the pr_enroll wording', async () => {
    const { effects } = build({ gh: async () => ({ code: 1, stderr: 'boom', stdout: '' }) });
    const result = await effects.others(q({ items: [] }), false);
    expect(result.log).toEqual(['pr discovery skipped o/lib: forge listing unavailable']);
  });

  describe('primary clone fetch', () => {
    const fetches = async (primaryFetched: boolean | undefined) => {
      const seen: string[] = [];
      const { effects } = build({
        ...(primaryFetched === undefined ? {} : { primaryFetched }),
        git: (repo) => async (args) => {
          if (args[0] === 'fetch') seen.push(`${repo.repo} ${args.slice(1).join(' ')}`);
          return {
            args,
            code: 0,
            stdout: text(args[0] === 'merge-base' ? BASE : ''),
            stderr: '',
          };
        },
      });
      await runEnrollmentPhase(q({ items: [] }), false, effects);
      return seen;
    };

    it('standalone, refreshes the primary clone itself (no earlier fetch phase)', async () => {
      expect(await fetches(undefined)).toEqual([
        'o/main --prune --quiet origin',
        'o/lib --quiet origin +refs/heads/main:refs/remotes/origin/main',
      ]);
    });

    it('after the tick fetch phase, does not fetch the primary again but still fetches others', async () => {
      expect(await fetches(true)).toEqual([
        'o/lib --quiet origin +refs/heads/main:refs/remotes/origin/main',
      ]);
    });
  });

  it('passes repo, range base and PR head to the facts read, and keeps dry runs write-free', async () => {
    const stored = {
      id: 'lr',
      kind: 'local-review',
      state: 'pending',
      identity_inputs: {
        repo: 'o/main',
        base_commit: BASE,
        head_commit: HEAD,
        scope: 's',
        projection: 'p',
        config_digest: 'd',
        profile: { a: 1 },
      },
    };
    const seen: string[][] = [];
    const { effects } = build({
      localReview: {
        facts: async (repo, base, head) => {
          seen.push([repo, base, head]);
          return q(stored.identity_inputs);
        },
        retained: async () => false,
      },
    });
    const queue = q({ items: [stored] });
    const result = await effects.primary(queue, true);
    expect(seen).toEqual([['o/main', BASE, HEAD]]);
    expect(result.queue.has('review_pr_links')).toBe(false);
  });

  it('defaults ownRange to rev-list over the primary clone and skips an owned update', async () => {
    const old = 'c'.repeat(40);
    const ranges: string[] = [];
    const { effects, events } = build({
      git: () => async (args) => {
        if (args[0] === 'rev-list') ranges.push(String(args[1]));
        return {
          args,
          code: 0,
          stdout: text(args[0] === 'merge-base' ? BASE : args[0] === 'rev-list' ? `${HEAD}\n` : ''),
          stderr: '',
        };
      },
    });
    const items = [
      {
        id: 'pr7',
        kind: 'open',
        pr: 7,
        state: 'done',
        cycles: [{ completed_at: '2026-01-01T00:00:00Z', head: old, run_id: 'r', base: BASE }],
      },
    ];
    const owned = await effects.primary(q({ repair_own_commits: [HEAD], items }), false);
    expect(ranges).toEqual([`${old}..${HEAD}`]);
    expect(names(owned.queue)).toEqual(['pr7']);
    expect(events).toEqual([]);
    const unowned = await effects.primary(q({ items }), false);
    expect(names(unowned.queue)).toHaveLength(2);
    expect(events).toHaveLength(1);
  });

  it('treats a failed rev-list as no proof, so the review stays owed', async () => {
    const old = 'c'.repeat(40);
    const { effects } = build({
      git: () => async (args) => ({
        args,
        code: args[0] === 'rev-list' ? 128 : 0,
        stdout: text(args[0] === 'merge-base' ? BASE : args[0] === 'rev-list' ? `${HEAD}\n` : ''),
        stderr: '',
      }),
    });
    const items = [
      {
        id: 'pr7',
        kind: 'open',
        pr: 7,
        state: 'done',
        cycles: [{ completed_at: '2026-01-01T00:00:00Z', head: old, run_id: 'r', base: old }],
      },
    ];
    const result = await effects.primary(q({ repair_own_commits: [HEAD], items }), false);
    expect(names(result.queue)).toHaveLength(2);
  });
});
