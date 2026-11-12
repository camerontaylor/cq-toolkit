import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeRepoDiffScanner } from '../../../src/ops/dev/denylist.js';
import { cycleReview, managedTerminal, reviewerCalls } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});
// The independent review's probe (PR #334 review 5562869931): the REAL
// project scanner over a real repo whose src/a.ts carries a synthetic
// sentinel. A valid rule must block it before any upload; a MALFORMED rule
// must fail CLOSED — refuse the review with zero uploads — never parse into
// a weaker regex that lets the reviewer run.
describe('dev.review pre-upload project scan fails closed', () => {
  const SENTINEL = 'review334_forbidden_probe';
  const patterns = (regex: string): string =>
    [
      'rules:',
      '  - id: class:review334-probe',
      '    description: synthetic sentinel',
      `    regex: ${regex}`,
      `    sample: '${SENTINEL}'`,
      'clean_probes:',
      "  - 'an ordinary sentence'",
      '',
    ].join('\n');

  /** The policy with one raw byte spliced in right after the sentinel inside the quoted regex. */
  const withByteAfterSentinel = (byte: number): Buffer => {
    const text = patterns(`'${SENTINEL}'`);
    const at = text.indexOf(SENTINEL) + SENTINEL.length;
    return Buffer.concat([
      Buffer.from(text.slice(0, at)),
      Buffer.from([byte]),
      Buffer.from(text.slice(at)),
    ]);
  };

  test.each([
    ['a valid rule', patterns(`'${SENTINEL}'`), 'class:review334-probe in committed:src/a.ts'],
    [
      'a malformed single-quoted rule',
      patterns(`'${SENTINEL}' # typo'`),
      'unterminated single-quoted value',
    ],
    ['invalid UTF-8 inside the rule regex', withByteAfterSentinel(0xff), 'not valid UTF-8'],
    [
      'a truncated UTF-8 sequence in the rule regex',
      withByteAfterSentinel(0xc3),
      'not valid UTF-8',
    ],
  ])('%s refuses the review with zero uploads', async (_label, policy, reason) => {
    await repo.write('policy/denylist/patterns.yml', policy);
    await repo.write('src/a.ts', `export const leak = '${SENTINEL}';\n`);
    repo.commitAll('sentinel');
    // S2b-i: the scan fails closed before the managed queue submit — the
    // scripted leg throws if the gate ever lets the submit through.
    const effects = repoEffects(repo);
    const result = await cycleReview(
      effects,
      makeRepoDiffScanner(repo.root),
      undefined,
      (async () => {
        throw new Error('fixture: the managed leg must not run past a scan refusal');
      }) as ReturnType<typeof managedTerminal>,
    )({
      repoRoot: repo.root,
    });
    expect(result.status).toBe('needs-human');
    expect(reviewerCalls(effects)).toEqual([]);
    expect(result.status === 'needs-human' && result.reason).toContain(reason);
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  });
});
