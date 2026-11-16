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
    ownRange: async () => false,
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
          { number: 7, isDraft: false, baseRefName: 'main', headRefName: 'f', headRefOid: HEAD },
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
    expect(result.log).toEqual(['pr discovery skipped o/main: forge listing unavailable']);
    expect(names(result.queue)).toEqual([]);
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
});
