import { describe, expect, it } from 'vitest';
import { fileLocalReviewAssociateEffects } from '../../../src/adapters/crq/localReviewAssociateSource.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { ValueError } from '../../../src/policy/crq/reviewAdmission.js';
import { GitUnavailable } from '../../../src/policy/crq/reviewHistory.js';

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const ID = 'c'.repeat(64);
const DIGEST = 'd'.repeat(64);
const RID = 'e'.repeat(64);
const inputs = {
  v: 1,
  repo: 'o/main',
  base_commit: BASE,
  base_tree: '1'.repeat(40),
  head_commit: HEAD,
  head_tree: '2'.repeat(40),
  scope: 'full-diff',
  projection: 'full-diff',
  config_digest: DIGEST,
  profile: { adapter: 'coderabbit-cli', revision: 'committed-full-diff-v1' },
};
const profile = {
  adapter: 'coderabbit-cli',
  revision: 'committed-full-diff-v1',
  flags: ['--agent'],
};
const receipt = (over: Record<string, unknown> = {}) => ({
  v: 1,
  kind: 'local-review-full-diff',
  identity: ID,
  identity_inputs: inputs,
  profile,
  run_id: 'r1',
  outcome: 'clean',
  scope_adequate: true,
  findings: [],
  report: '',
  observed: {},
  independent_acceptance: false,
  ...over,
});
const j = (value: unknown): JsonObject => parseJsonValue(JSON.stringify(value)) as JsonObject;
const item = (over: Record<string, unknown> = {}) =>
  j({
    kind: 'local-review',
    state: 'done',
    outcome: 'clean',
    scope_adequate: true,
    identity: ID,
    identity_inputs: inputs,
    receipt_id: RID,
    ...over,
  });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function build(opts: { resolve?: () => Promise<JsonObject>; receipt?: Uint8Array | Error } = {}) {
  const calls: string[][] = [];
  const resolved: unknown[] = [];
  const effects = fileLocalReviewAssociateEffects({
    config: j({ local_review_profile: { revision: 'rev-9', flags: ['--x'] } }),
    effects: {
      historyGit:
        (repo) =>
        async (...args: string[]) => {
          calls.push([repo, ...args]);
          return new TextEncoder().encode(
            `${args[1]?.startsWith(BASE) ? '1'.repeat(40) : '2'.repeat(40)}\n`,
          );
        },
      resolveIdentity: async (repo, input, prof) => {
        resolved.push([repo, input, prof]);
        return opts.resolve ? opts.resolve() : j({ ok: true });
      },
      readReceipt: async (id) => {
        if (opts.receipt instanceof Error) throw opts.receipt;
        expect(id).toBe(RID);
        return opts.receipt ?? bytes(receipt());
      },
    },
  });
  return { effects, calls, resolved };
}

describe('fileLocalReviewAssociateEffects.facts', () => {
  it('resolves the pinned identity with the configured profile for the PR base', async () => {
    const { effects, calls, resolved } = build();
    const out = await effects.facts('o/lib', BASE, HEAD);
    expect(out?.get('ok')).toBe(true);
    expect(calls.map((c) => c.join(' '))).toEqual([
      `o/lib rev-parse ${BASE}^{tree}`,
      `o/lib rev-parse ${HEAD}^{tree}`,
    ]);
    const [repo, input, prof] = resolved[0] as [string, JsonObject, JsonObject];
    expect(repo).toBe('o/lib');
    expect(input.get('base_commit')).toBe(BASE);
    expect(input.get('head_commit')).toBe(HEAD);
    expect(JSON.stringify(prof.get('flags'))).toBe(JSON.stringify(['--x', '--base-commit', BASE]));
    expect(prof.get('revision')).toBe('rev-9');
  });

  it('turns the expected failures into no facts', async () => {
    for (const error of [
      new ValueError('x'),
      new GitUnavailable('x'),
      Object.assign(new Error('x'), { code: 'ENOENT' }),
    ]) {
      const { effects } = build({
        resolve: async () => {
          throw error;
        },
      });
      expect(await effects.facts('o/main', BASE, HEAD)).toBeNull();
    }
  });

  it('lets a programming error through', async () => {
    const { effects } = build({
      resolve: async () => {
        throw new TypeError('bug');
      },
    });
    await expect(effects.facts('o/main', BASE, HEAD)).rejects.toThrow('bug');
  });
});

describe('fileLocalReviewAssociateEffects.retained', () => {
  it('accepts a matching clean or findings receipt', async () => {
    expect(await build().effects.retained(item())).toBe(true);
    const found = build({ receipt: bytes(receipt({ outcome: 'findings' })) });
    expect(await found.effects.retained(item())).toBe(true);
  });

  it('refuses an item that is not adequate even when its receipt would match', async () => {
    const { effects } = build();
    expect(await effects.retained(item({ state: 'queued' }))).toBe(false);
  });

  it.each([
    ['identity mismatch', receipt({ identity: 'f'.repeat(64) })],
    ['inputs mismatch', receipt({ identity_inputs: { ...inputs, head_tree: '9'.repeat(40) } })],
    ['scope inadequate', receipt({ scope_adequate: false })],
    ['no-verdict outcome', receipt({ outcome: 'no-verdict' })],
    ['schema-invalid', { v: 1 }],
  ])('refuses %s', async (_name, doc) => {
    expect(await build({ receipt: bytes(doc) }).effects.retained(item())).toBe(false);
  });

  it('treats an unreadable or malformed receipt as not retained', async () => {
    expect(await build({ receipt: new Error('ENOENT') }).effects.retained(item())).toBe(false);
    expect(await build({ receipt: new TextEncoder().encode('{') }).effects.retained(item())).toBe(
      false,
    );
    expect(await build({ receipt: new Uint8Array([0xff, 0xfe]) }).effects.retained(item())).toBe(
      false,
    );
  });
});
