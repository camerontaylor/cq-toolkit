// pr.open op tests — the readiness gate (a not-ready branch is refused
// with the gaps), the adopt-or-create rule (never a second PR), the managed
// body section (an adopted PR's prose survives the refresh), the
// dispositions comment, and the author-evidence marking on every artifact.
import { describe, expect, test } from 'vitest';
import { DEV_LEDGER_VERSION, type DevLedgerFile } from '../../../src/ops/dev/record.js';
import { BASE, BRANCH, HEAD, makeFakeEffects, okResult } from '../dev/fakes.js';
import type { DevRecord } from '../../../src/ops/dev/record.js';
import { checkRecord, cycleRecord, dispositionRecord, ledgerWith } from '../dev/fakes.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import {
  DEV_READINESS_SECTION_MARKER,
  makePrOpen,
  renderDispositionsComment,
  renderReadinessSection,
} from '../../../src/ops/pr/open.js';

interface GhExisting {
  number?: number;
  state?: 'open' | 'closed' | 'merged';
  isCrossRepository?: boolean;
}

/** A gh fake implementing the PrEffects seam with a recording list. */
function ghFake(existing: GhExisting | null) {
  const calls: { effect: string; args: unknown[] }[] = [];
  const gh: PrEffects = {
    searchPrByHead: async (head, base) => {
      calls.push({ effect: 'searchPrByHead', args: [head, base] });
      if (existing === null) return null;
      return {
        number: existing.number ?? 41,
        state: existing.state ?? 'open',
        isCrossRepository: existing.isCrossRepository ?? false,
      };
    },
    createPr: async (request) => {
      calls.push({ effect: 'createPr', args: [request] });
      return { number: 42, url: 'https://example.invalid/pull/42' };
    },
    editPrBody: async (number, body) => {
      calls.push({ effect: 'editPrBody', args: [number, body] });
    },
    getPrBody: async (number) => {
      calls.push({ effect: 'getPrBody', args: [number] });
      return '# existing prose\n\ncustom section\n';
    },
    comment: async (number, body) => {
      calls.push({ effect: 'comment', args: [number, body] });
    },
    getPrReadiness: async (number) => {
      calls.push({ effect: 'getPrReadiness', args: [number] });
      throw new Error('not used by pr.open');
    },
  };
  return { gh, calls };
}

/** Dev effects whose ledger holds a complete, ready record set (for `target`). */
function readyEffects(withDispositions: boolean, target: string = 'merge-queue') {
  const effects = makeFakeEffects((command, args) => {
    if (command === 'git' && args[0] === 'log') return okResult('feat(dev): the lane\n');
    return undefined;
  });
  const records: DevRecord[] = [
    cycleRecord({ cycleId: 'c000-aaaaaaaa', target, dirtySha256: 'clean-tree' }),
    cycleRecord({
      target,
      dirtySha256: 'clean-tree',
      findings: withDispositions ? [{ id: 'c001-aaaaaaaa#f1', severity: 'minor' }] : [],
    }),
    checkRecord({ dirtySha256: 'clean-tree', target }),
  ];
  if (withDispositions) {
    records.push(
      dispositionRecord({
        findingId: 'c001-aaaaaaaa#f1',
        action: 'rejected',
        why: 'false positive: x',
      }),
    );
  }
  effects.store.save({ version: DEV_LEDGER_VERSION, branch: BRANCH, records });
  return effects;
}

describe('pr.open', () => {
  test('creates the PR from a ready record: readiness section body, dispositions comment', async () => {
    const effects = readyEffects(true);
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toMatchObject({
      number: 42,
      created: true,
      base: 'merge-queue',
      branch: BRANCH,
      evidenceClass: 'author',
    });
    const create = calls.find((call) => call.effect === 'createPr');
    expect(create).toBeDefined();
    if (create?.effect === 'createPr') {
      const request = create.args[0] as { head: string; base: string; title: string; body: string };
      expect(request.head).toBe(BRANCH);
      expect(request.base).toBe('merge-queue');
      expect(request.title).toBe('feat(dev): the lane');
      expect(request.body).toContain(DEV_READINESS_SECTION_MARKER);
      expect(request.body).toContain('Author readiness evidence');
      expect(request.body).toContain('c001-aaaaaaaa');
      expect(request.body).toContain('k001-aaaaaaaa');
      // The dispositions also live in the managed body section (updated in
      // place on every re-run).
      expect(request.body).toContain('finding dispositions');
      expect(request.body).toContain('false positive: x');
    }
    const comment = calls.find((call) => call.effect === 'comment');
    expect(comment).toBeDefined();
    if (comment?.effect === 'comment') {
      const body = comment.args[1] as string;
      expect(body).toContain('c001-aaaaaaaa#f1');
      expect(body).toContain('rejected');
    }
  });

  test('adopts the existing OPEN PR: body composed over existing prose, never a second PR', async () => {
    const effects = readyEffects(false);
    const { gh, calls } = ghFake({ number: 41, state: 'open' });
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo', title: 'explicit title' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.created).toBe(false);
    expect(result.value.number).toBe(41);
    expect(calls.find((call) => call.effect === 'createPr')).toBeUndefined();
    const edit = calls.find((call) => call.effect === 'editPrBody');
    expect(edit).toBeDefined();
    if (edit?.effect === 'editPrBody') {
      const body = edit.args[1] as string;
      expect(body).toContain('# existing prose'); // the adopted prose survives
      expect(body).toContain(DEV_READINESS_SECTION_MARKER);
    }
    // No dispositions recorded → no comment.
    expect(calls.find((call) => call.effect === 'comment')).toBeUndefined();
  });

  test('adoption with dispositions updates them IN the body and posts NO duplicate comment', async () => {
    const effects = readyEffects(true);
    const { gh, calls } = ghFake({ number: 41, state: 'open' });
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo', title: 't' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const edit = calls.find((call) => call.effect === 'editPrBody');
    expect(edit).toBeDefined();
    if (edit?.effect === 'editPrBody') {
      const body = edit.args[1] as string;
      expect(body).toContain('finding dispositions');
      expect(body).toContain('c001-aaaaaaaa#f1');
    }
    // The comment posts only on creation — never a duplicate on re-run.
    expect(calls.find((call) => call.effect === 'comment')).toBeUndefined();
  });

  test('refuses a landed (non-open) or foreign PR instead of rewriting it', async () => {
    const effects = readyEffects(false);
    const merged = ghFake({ number: 41, state: 'merged' });
    const mergedResult = await makePrOpen(effects, merged.gh)({ repoRoot: '/repo' });
    expect(mergedResult.status).toBe('failed');
    const fork = ghFake({ number: 41, state: 'open', isCrossRepository: true });
    const forkResult = await makePrOpen(effects, fork.gh)({ repoRoot: '/repo' });
    expect(forkResult.status).toBe('failed');
  });

  test('a not-ready branch is refused with the gaps and ZERO gh calls', async () => {
    const effects = makeFakeEffects(); // empty ledger
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('not dev.ready');
      expect(result.reason).toContain('terminal-review-cycle');
    }
    expect(calls).toHaveLength(0);
  });

  test('a remote branch at a DIFFERENT head is needs-human before any gh call', async () => {
    const effects = readyEffects(false);
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'ls-remote') {
        return okResult('9999999999999999999999999999999999999999\trefs/heads/test/branch\n');
      }
      return original(command, args, opts);
    };
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('9999999');
      expect(result.reason).toContain('never post readiness for a different head');
    }
    expect(calls).toHaveLength(0);
  });

  test('a branch that was never pushed is needs-human before any gh call', async () => {
    const effects = readyEffects(false);
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'ls-remote') return okResult('');
      return original(command, args, opts);
    };
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('never pushed');
    expect(calls).toHaveLength(0);
  });

  test('worktree drift between assembly and mutation aborts before any gh call', async () => {
    const effects = readyEffects(false);
    let headReads = 0;
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headReads += 1;
        if (headReads >= 2) return okResult('8888888888888888888888888888888888888888\n');
      }
      return original(command, args, opts);
    };
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('nothing was posted');
    expect(calls).toHaveLength(0);
  });

  test('a DIRTY worktree is refused before any gh call even when remote and record agree', async () => {
    // The PR carries pushed commits only; a record describing uncommitted
    // content would evidence a state the PR cannot contain.
    const effects = makeFakeEffects((command, args) => {
      if (command === 'git' && args[0] === 'log') return okResult('feat(dev): the lane\n');
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary') {
        return okResult('uncommitted patch text');
      }
      return undefined;
    });
    const { createHash } = await import('node:crypto');
    const dirtySha = createHash('sha256').update('uncommitted patch text').digest('hex');
    effects.store.save({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [
        cycleRecord({ cycleId: 'c000-aaaaaaaa', dirtySha256: dirtySha }),
        cycleRecord({ dirtySha256: dirtySha }),
        checkRecord({ dirtySha256: dirtySha }),
      ],
    });
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('uncommitted changes');
      expect(result.reason).toContain('commit the work');
    }
    expect(calls).toHaveLength(0);
  });

  test('a FAILED pre-mutation recheck read is needs-human — it never folds into clean', async () => {
    const effects = readyEffects(false);
    let dirtyReads = 0;
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'diff' && args[1] === '--binary') {
        dirtyReads += 1;
        if (dirtyReads >= 2) {
          return { exitCode: 128, stdout: '', stderr: 'fatal: bad object', timedOut: false };
        }
      }
      return original(command, args, opts);
    };
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('identity recheck failed');
      expect(result.reason).toContain('nothing was posted');
    }
    expect(calls).toHaveLength(0);
  });

  test('the body renders the CITED identity-bound check, never an unrelated passed one', async () => {
    const effects = readyEffects(false);
    effects.store.save({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [
        checkRecord({
          checkId: 'k001-older',
          dirtySha256: 'an-older-identity',
          passed: false,
          gates: [
            {
              name: 'unique-old-gate',
              status: 'fail',
              exitCode: 1,
              durationMs: 1,
              evidence: 'old',
            },
          ],
        }),
        cycleRecord({ cycleId: 'c000-aaaaaaaa', dirtySha256: 'clean-tree' }),
        cycleRecord({ dirtySha256: 'clean-tree' }),
        checkRecord({
          checkId: 'k002-aaaaaaaa',
          dirtySha256: 'clean-tree',
          passed: true,
          gates: [
            { name: 'check:static', status: 'pass', exitCode: 0, durationMs: 777, evidence: 'ok' },
          ],
        }),
      ],
    });
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo', title: 't' });
    expect(result.status).toBe('ok');
    const create = calls.find((call) => call.effect === 'createPr');
    expect(create).toBeDefined();
    if (create?.effect === 'createPr') {
      const body = (create.args[0] as { body: string }).body;
      expect(body).toContain('k002-aaaaaaaa'); // the cited check id
      expect(body).toContain('777'); // its gate row
      expect(body).not.toContain('unique-old-gate'); // never an unrelated check
    }
  });

  test('a ledger that turns NOT-READY at the mutation boundary aborts before any gh call', async () => {
    const effects = readyEffects(false);
    let ledgerLoads = 0;
    const store = effects.openLedger(BRANCH);
    const originalLoad = store.load.bind(store);
    store.load = () => {
      ledgerLoads += 1;
      if (ledgerLoads >= 2) {
        // A concurrent writer dropped the green check after the first read
        // (e.g. a red re-check landed): the boundary re-read must see it.
        return {
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: originalLoad().records.slice(0, 1),
        };
      }
      return originalLoad();
    };
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('mutation boundary');
      expect(result.reason).toContain('no longer ready');
    }
    expect(calls).toHaveLength(0);
  });

  test('a remote head that moves during the reads aborts before any gh call', async () => {
    const effects = readyEffects(false);
    let remoteReads = 0;
    const original = effects.runCommand;
    effects.runCommand = async (command, args, opts) => {
      if (command === 'git' && args[0] === 'ls-remote') {
        remoteReads += 1;
        if (remoteReads >= 2)
          return okResult('7777777777777777777777777777777777777777\trefs/heads/test/branch\n');
      }
      return original(command, args, opts);
    };
    const { gh, calls } = ghFake(null);
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('moved during');
      expect(result.reason).toContain('nothing was posted');
    }
    expect(calls).toHaveLength(0);
  });

  test('a comment fault fails naming the PR and the idempotent re-run', async () => {
    const effects = readyEffects(true);
    const gh: PrEffects = {
      searchPrByHead: async () => null,
      createPr: async () => ({ number: 42 }),
      editPrBody: async () => undefined,
      getPrBody: async () => '',
      comment: async () => {
        throw new Error('gh: network refused');
      },
      getPrReadiness: async () => {
        throw new Error('not used');
      },
    };
    const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('#42');
      expect(result.error).toContain('dispositions in its body');
      expect(result.error).not.toContain('idempotent');
    }
  });

  test('an explicit --draft and target pass through to the create request and base', async () => {
    const effects = readyEffects(false, 'main'); // evidence recorded FOR main
    const { gh, calls } = ghFake(null);
    await makePrOpen(effects, gh)({ repoRoot: '/repo', draft: true, target: 'main', title: 't' });
    const create = calls.find((call) => call.effect === 'createPr');
    expect(create).toBeDefined();
    if (create?.effect === 'createPr') {
      const request = create.args[0] as { base: string; draft: boolean };
      expect(request.base).toBe('main');
      expect(request.draft).toBe(true);
    }
  });
});

describe('the readiness renderers', () => {
  const record = {
    ready: true as const,
    evidenceClass: 'author' as const,
    caveat: 'the caveat',
    branch: BRANCH,
    target: 'merge-queue',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    cycleId: 'c001-aaaaaaaa',
    checkId: 'k001-aaaaaaaa',
    at: '2026-10-17T00:00:00.000Z',
  };
  const ledger: DevLedgerFile = {
    version: DEV_LEDGER_VERSION,
    branch: BRANCH,
    records: [dispositionRecord()],
  };

  test('the section renders start and end markers, a markdown-safe gate table, and the caveat', () => {
    const section = renderReadinessSection(record, ledger, [
      { name: 'check:static', status: 'pass', durationMs: 12 },
      { name: 'a|b', status: 'pass', durationMs: 1 },
    ]);
    expect(section.startsWith(DEV_READINESS_SECTION_MARKER)).toBe(true);
    expect(section).toContain('<!-- /cq:dev-readiness -->');
    expect(section).toContain('| a\\|b |');
    expect(section).toContain('the caveat');
  });

  test('the dispositions comment lists every disposition with its action and reason', () => {
    const body = renderDispositionsComment(ledger);
    expect(body).toContain('c001-aaaaaaaa#f1');
    expect(body).toContain('**fixed**');
    expect(body).toContain('addressed in the diff');
  });

  test('an empty disposition list renders the explicit none-note, never a bare section', () => {
    const body = renderDispositionsComment({ ...ledger, records: [] });
    expect(body).toContain('No findings were dispositioned');
  });
});

describe('the readiness section markdown escaping', () => {
  const baseRecord = {
    ready: true as const,
    evidenceClass: 'author' as const,
    caveat: 'the caveat',
    branch: BRANCH,
    target: 'merge-`queue`',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    cycleId: 'c001-aaaaaaaa',
    checkId: 'k001-aaaaaaaa',
    at: '2026-10-17T00:00:00.000Z',
  };

  test('a backtick in a recorded field cannot close the managed code span', () => {
    const section = renderReadinessSection(baseRecord, ledgerWith([], BRANCH), []);
    // mdSafe's spelling: backticks become typographic apostrophes — the
    // field stays inert inside the generated span.
    expect(section).toContain('`merge-’queue’`');
    expect(section).not.toContain('merge-`queue`');
  });

  test('angle brackets in a disposition reason are stripped, not rendered', () => {
    const ledger = ledgerWith([dispositionRecord({ why: '<script>alert(1)</script>' })], BRANCH);
    const section = renderReadinessSection(baseRecord, ledger, []);
    expect(section).not.toContain('<script>');
    expect(section).toContain('scriptalert(1)/script');
  });
});

test('refuses an independently dirty index even when worktree equals HEAD', async () => {
  const effects = readyEffects(false);
  const original = effects.runCommand;
  effects.runCommand = async (command, args, opts) =>
    command === 'git' && args[0] === 'diff' && args[1] === '--cached'
      ? okResult('staged patch')
      : original(command, args, opts);
  const { gh, calls } = ghFake(null);
  const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
  expect(result.status).toBe('needs-human');
  expect(calls).toEqual([]);
});

test('refuses index-only drift at the publication boundary after clean initial reads', async () => {
  const effects = readyEffects(false);
  const original = effects.runCommand;
  let reads = 0;
  effects.runCommand = async (command, args, opts) => {
    if (command === 'git' && args[0] === 'diff' && args[1] === '--cached' && ++reads === 2)
      return okResult('new staged patch');
    return original(command, args, opts);
  };
  const { gh, calls } = ghFake(null);
  const result = await makePrOpen(effects, gh)({ repoRoot: '/repo' });
  expect(result.status).toBe('needs-human');
  expect(calls.some((entry) => ['createPr', 'editPrBody', 'comment'].includes(entry.effect))).toBe(
    false,
  );
});
