import { describe, expect, it } from 'vitest';
import { FixPrBacklog } from '../../src/queue-runner/fixPrBacklog.js';
import { isPyError, PyError } from '../../src/queue-runner/pyErrors.js';
import {
  finalizePublication,
  type PublicationFinalizeEffects,
} from '../../src/queue-runner/publicationFinalize.js';
import {
  publishRepair,
  REFUSE_NOT_FAST_FORWARD,
  REFUSE_PR_MOVED,
  REFUSE_SECRET_SCAN,
  STALE_DOES_NOT_APPLY,
  STALE_NOT_FAST_FORWARD,
  STALE_PR_CLOSED,
  type PublicationPublishEffects,
} from '../../src/queue-runner/publicationPublish.js';
import type { RecoveryPrInfo } from '../../src/queue-runner/publicationRecovery.js';

// Mirrors the first-publication arm of repair_tick.publish as pinned by
// apps/crq-python/test_repair_replay.py (stale vs retryable replay),
// test_repair_backlog.py (#2288 item-owned branch naming, via finalize) and
// test_repair_publication_lease.py (the journal-present arm is recovery).
// Real Git, the forge and the runtime are out of scope: every fact is a fixture.

type Rec = Record<string, unknown>;

const BASE = 'b'.repeat(40);
const TARGET = 't'.repeat(40);
const CLAIM = 'c'.repeat(40);
const HEAD = 'h'.repeat(40);

interface Harness {
  effects: PublicationPublishEffects;
  readonly calls: string[];
  readonly journals: Rec[];
  readonly saves: Rec[];
  readonly pushes: { branch: string; expected: string; sha: string }[];
  readonly patches: string[];
  journal: Rec | null;
  info: RecoveryPrInfo;
  /** Successive `prInfo` reads; the last one repeats. */
  infos: RecoveryPrInfo[];
  claims: string[];
  diff: string;
  cherryPick: () => void;
  cherryPickHead: () => void;
  conflicts: string;
  staged: string;
  hack: () => void;
  secretOk: boolean;
  ancestors: (older: string, newer: string) => boolean;
  finalized: Rec[];
  pushImpl: () => void;
  listed: { headRefOid: unknown }[];
  lsRemote: string;
}

function harness(): Harness {
  const calls: string[] = [];
  const h: Harness = {
    calls,
    journals: [],
    saves: [],
    pushes: [],
    patches: [],
    finalized: [],
    journal: null,
    info: { state: 'OPEN', headRefName: 'fix-branch', headRefOid: TARGET },
    infos: [],
    claims: [CLAIM],
    diff: 'diff --git a/f b/f',
    cherryPick: () => undefined,
    cherryPickHead: () => {
      throw new PyError('RuntimeError', 'git rev-parse failed');
    },
    conflicts: '',
    staged: '',
    hack: () => undefined,
    secretOk: true,
    ancestors: () => true,
    pushImpl: () => undefined,
    listed: [],
    lsRemote: '',
    effects: undefined as unknown as PublicationPublishEffects,
  };
  let reads = 0;
  h.effects = {
    iso: () => 'now',
    async readJournal() {
      calls.push('read-journal');
      return h.journal;
    },
    async revParseDefaultRef() {
      calls.push('default-ref');
      return TARGET;
    },
    async prInfo() {
      calls.push('pr-info');
      const next = h.infos[Math.min(reads, h.infos.length - 1)] ?? h.info;
      reads += 1;
      return next;
    },
    async isAncestor(older, newer) {
      calls.push(`ancestor:${older}->${newer}`);
      return h.ancestors(older, newer);
    },
    async makeWorktree(name, sha) {
      calls.push(`worktree:${name}@${sha}`);
      return { path: '/wt', branch: 'wtb' };
    },
    async removeWorktree() {
      calls.push('remove-worktree');
    },
    async revParseHead() {
      calls.push('head');
      return calls.includes('cherry-pick') ? HEAD : BASE;
    },
    async cherryPick(_wt, sha) {
      calls.push('cherry-pick');
      calls.push(`pick:${sha}`);
      h.cherryPick();
    },
    async verifyCherryPickHead() {
      calls.push('cherry-pick-head');
      h.cherryPickHead();
    },
    async conflictedFiles() {
      calls.push('conflicts');
      return h.conflicts;
    },
    async stagedFiles() {
      calls.push('staged');
      return h.staged;
    },
    async revListSince() {
      calls.push('rev-list');
      return h.claims;
    },
    async verify(_wt, _before, claims, job) {
      calls.push(`verify:${String(job)}:${claims.join(',')}`);
    },
    async diffSince() {
      calls.push('diff');
      return h.diff;
    },
    async writePatch(_job, text) {
      calls.push('write-patch');
      h.patches.push(text);
    },
    async hackDetector() {
      calls.push('hack');
      h.hack();
    },
    async secretScan() {
      calls.push('secret-scan');
      return h.secretOk;
    },
    async updateRef(ref, sha) {
      calls.push(`update-ref:${ref}=${sha}`);
    },
    async writeJournal(_job, publication) {
      calls.push('write-journal');
      h.journals.push(structuredClone(publication));
    },
    async saveQueue(q) {
      calls.push('save');
      h.saves.push(structuredClone(q));
    },
    async push(branch, expected, sha) {
      calls.push('push');
      h.pushes.push({ branch, expected, sha });
      h.pushImpl();
    },
    async finalize(publication) {
      calls.push('finalize');
      h.finalized.push(publication);
    },
    async lsRemoteHeads() {
      calls.push('ls-remote');
      return h.lsRemote;
    },
    async listBranchPrs() {
      calls.push('list-prs');
      return h.listed;
    },
  };
  return h;
}

function parts(itemId = 'pr5', run = 'run-1', openPr = false) {
  const item: Rec = { id: itemId, pr: 5, kind: 'open', state: 'repairing' };
  const record: Rec = {
    jobs: ['job-1'],
    base: BASE,
    open_pr: openPr,
    branch: 'fix-branch',
    state: 'ready',
    verdicts: [{ job: 'job-1', verdict: 'FIXED', reason: 'ok' }],
  };
  const fixed: Rec[] = [{ job: 'job-1', verdict: 'FIXED', reason: 'ok', commits: [CLAIM] }];
  const q: Rec = { items: [item] };
  return { item, record, fixed, q, run };
}

async function publish(h: Harness, p: ReturnType<typeof parts>) {
  let thrown: unknown;
  try {
    await publishRepair(h.effects, p.q, p.item, p.run, p.record, p.fixed);
  } catch (e) {
    thrown = e;
  }
  return thrown;
}

describe('publishRepair: replay outcomes (test_repair_replay.py)', () => {
  it('a conflicting cherry-pick marks the record stale and publishes nothing', async () => {
    const h = harness();
    h.cherryPick = () => {
      throw new PyError('RuntimeError', 'git cherry-pick failed: conflict');
    };
    h.cherryPickHead = () => undefined;
    h.conflicts = 'file';
    h.staged = 'file';
    const p = parts();
    expect(await publish(h, p)).toBeUndefined();
    expect(p.record.state).toBe('stale');
    expect(p.record.error).toBe(`${STALE_DOES_NOT_APPLY}git cherry-pick failed: conflict`);
    expect(h.calls).not.toContain('write-journal');
    expect(h.calls).not.toContain('push');
    expect(h.calls.at(-1)).toBe('remove-worktree');
  });

  it('an empty cherry-pick (nothing staged, no conflicts) is stale too', async () => {
    const h = harness();
    h.cherryPick = () => {
      throw new PyError('RuntimeError', 'git cherry-pick failed: empty');
    };
    h.cherryPickHead = () => undefined;
    const p = parts();
    expect(await publish(h, p)).toBeUndefined();
    expect(p.record.state).toBe('stale');
    expect(h.calls).toContain('conflicts');
    expect(h.calls).toContain('staged');
  });

  it('truncates the stale reason to 200 code points', async () => {
    const h = harness();
    h.cherryPick = () => {
      throw new PyError('RuntimeError', '𝒳'.repeat(300));
    };
    h.cherryPickHead = () => undefined;
    const p = parts();
    await publish(h, p);
    expect(p.record.error).toBe(STALE_DOES_NOT_APPLY + '𝒳'.repeat(200));
  });

  it('a failure with no CHERRY_PICK_HEAD propagates the original error for retry', async () => {
    const h = harness();
    h.cherryPick = () => {
      throw new PyError('RuntimeError', 'temporary git failure');
    };
    const p = parts();
    const thrown = await publish(h, p);
    expect(isPyError(thrown, 'RuntimeError')).toBe(true);
    expect((thrown as Error).message).toBe('temporary git failure');
    expect(p.record.state).toBe('ready');
    expect(h.calls).not.toContain('conflicts');
    expect(h.calls.at(-1)).toBe('remove-worktree');
  });

  it('a recorded cherry-pick with staged changes and no conflicts is still retryable', async () => {
    const h = harness();
    h.cherryPick = () => {
      throw new PyError('RuntimeError', 'hook failed');
    };
    h.cherryPickHead = () => undefined;
    h.staged = 'file';
    const p = parts();
    const thrown = await publish(h, p);
    expect((thrown as Error).message).toBe('hook failed');
    expect(p.record.state).toBe('ready');
  });

  it('a non-RuntimeError from the pick propagates without probing CHERRY_PICK_HEAD', async () => {
    const h = harness();
    h.cherryPick = () => {
      throw new Error('spawn timeout');
    };
    const p = parts();
    expect(((await publish(h, p)) as Error).message).toBe('spawn timeout');
    expect(h.calls).not.toContain('cherry-pick-head');
  });

  it('a successful replay reaches verification of each repair over its own range', async () => {
    const h = harness();
    const p = parts();
    expect(await publish(h, p)).toBeUndefined();
    expect(h.calls).toContain(`verify:job-1:${CLAIM}`);
    expect(h.calls.indexOf('verify:job-1:' + CLAIM)).toBeGreaterThan(h.calls.indexOf('rev-list'));
  });
});

describe('publishRepair: pre-worktree stale marks', () => {
  it('a closed PR marks stale before any worktree is made', async () => {
    const h = harness();
    h.info = { state: 'MERGED', headRefName: 'fix-branch', headRefOid: TARGET };
    const p = parts('pr5', 'run-1', true);
    expect(await publish(h, p)).toBeUndefined();
    expect(p.record.state).toBe('stale');
    expect(p.record.error).toBe(STALE_PR_CLOSED);
    expect(h.calls.some((c) => c.startsWith('worktree:'))).toBe(false);
  });

  it('a PR head that does not descend from the pinned base marks stale', async () => {
    const h = harness();
    h.ancestors = (older) => older !== BASE;
    const p = parts('pr5', 'run-1', true);
    expect(await publish(h, p)).toBeUndefined();
    expect(p.record.error).toBe(STALE_NOT_FAST_FORWARD);
    expect(h.calls.some((c) => c.startsWith('worktree:'))).toBe(false);
  });

  it('a branch publication targets the default ref and never reads a PR or the base ancestry', async () => {
    const h = harness();
    const p = parts();
    await publish(h, p);
    expect(h.calls).toContain('default-ref');
    expect(h.calls).not.toContain('pr-info');
    expect(h.calls).toContain(`worktree:publish-run-1@${TARGET}`);
    expect(h.calls.some((c) => c === `ancestor:${BASE}->${TARGET}`)).toBe(false);
  });

  it('a missing record key is a KeyError before any read or worktree', async () => {
    const h = harness();
    const p = parts();
    delete p.record.open_pr;
    const thrown = await publish(h, p);
    expect(isPyError(thrown, 'KeyError')).toBe(true);
    expect(h.calls).toEqual(['read-journal']);
  });
});

describe('publishRepair: scans precede the journal', () => {
  it('a hack-detector rejection is rewrapped and nothing is journaled or pushed', async () => {
    const h = harness();
    h.hack = () => {
      throw new PyError('DetectorUnavailable', 'hack detector did not complete: timeout');
    };
    const p = parts();
    const thrown = await publish(h, p);
    expect(isPyError(thrown, 'ValueError')).toBe(true);
    expect((thrown as PyError).kind).toBe('ValueError');
    expect((thrown as Error).message).toBe('publication hack detector did not complete: timeout');
    expect(h.patches).toEqual(['diff --git a/f b/f\n']);
    expect(h.calls).not.toContain('write-journal');
    expect(h.calls).not.toContain('push');
    expect(h.calls.at(-1)).toBe('remove-worktree');
  });

  it('a failed secret scan refuses before the journal', async () => {
    const h = harness();
    h.secretOk = false;
    const thrown = await publish(h, parts());
    expect((thrown as Error).message).toBe(REFUSE_SECRET_SCAN);
    expect(h.calls).not.toContain('write-journal');
    expect(h.calls).not.toContain('update-ref:refs/crq/publication/run-1=' + HEAD);
  });

  it('a non-ValueError detector failure propagates unchanged', async () => {
    const h = harness();
    h.hack = () => {
      throw new Error('spawn');
    };
    expect(((await publish(h, parts())) as Error).message).toBe('spawn');
  });
});

describe('publishRepair: branch naming is item-owned (#2288)', () => {
  const prefixed = async (itemId: string, run: string) => {
    const h = harness();
    const p = parts(itemId, run);
    expect(await publish(h, p)).toBeUndefined();
    return { h, p };
  };

  it('an ordinary item publishes crq/fix-<run>', async () => {
    const { h } = await prefixed('pr5', 'run-1');
    expect(h.pushes).toEqual([{ branch: 'crq/fix-run-1', expected: '', sha: HEAD }]);
  });

  it('a backfill item keeps the counted prefix, even for a prepared revalidated- run', async () => {
    const { h, p } = await prefixed('backfill-finding-a', 'revalidated-x');
    expect(h.pushes[0]!.branch).toBe('crq/fix-backfill-revalidated-x');
    expect((p.record.publication as Rec).branch).toBe('crq/fix-backfill-revalidated-x');
  });

  it('a non-backfill item with a backfill-looking run id stays outside the cap', async () => {
    const { h } = await prefixed('pr5', 'backfill-finding-a');
    expect(h.pushes[0]!.branch).toBe('crq/fix-backfill-finding-a');
    // The prefix collision is the run id's, not the item's: the item is ordinary.
    const ordinary = await prefixed('pr6', 'run-2');
    expect(ordinary.h.pushes[0]!.branch).toBe('crq/fix-run-2');
  });

  it('an open-PR publication pushes to the record branch, whatever the item id', async () => {
    const h = harness();
    const p = parts('backfill-finding-a', 'run-1', true);
    expect(await publish(h, p)).toBeUndefined();
    expect(h.pushes).toEqual([{ branch: 'fix-branch', expected: TARGET, sha: HEAD }]);
  });
});

describe('publishRepair: journal ordering and lease', () => {
  it('pins the ref, journals, saves the queue, then leases and pushes before finalizing', async () => {
    const h = harness();
    const p = parts();
    expect(await publish(h, p)).toBeUndefined();
    const tail = h.calls.slice(h.calls.indexOf('secret-scan'));
    expect(tail).toEqual([
      'secret-scan',
      `update-ref:refs/crq/publication/run-1=${HEAD}`,
      'write-journal',
      'save',
      'push',
      'finalize',
      'remove-worktree',
    ]);
    expect(h.journals[0]).toEqual({
      head: HEAD,
      target: TARGET,
      branch: 'crq/fix-run-1',
      commits: [CLAIM],
      open_pr: false,
      at: 'now',
    });
    // The queue saved with the record already carrying the journal.
    const saved = h.saves[0]!.items as Rec[];
    expect(saved).toHaveLength(1);
    expect(p.record.publication).toBe(h.finalized[0]);
  });

  it("collects every repair's claims in order across multiple fixed verdicts", async () => {
    const h = harness();
    const p = parts();
    p.fixed.push({ job: 'job-2', verdict: 'FIXED', reason: 'ok', commits: ['d'.repeat(40)] });
    h.claims = [CLAIM];
    await publish(h, p);
    expect(h.calls.filter((c) => c.startsWith('verify:'))).toEqual([
      `verify:job-1:${CLAIM}`,
      `verify:job-2:${CLAIM}`,
    ]);
    expect(h.journals[0]!.commits as string[]).toEqual([CLAIM, CLAIM]);
  });

  it('an open PR is re-read after the scans and refused if it moved', async () => {
    const moved: RecoveryPrInfo = { state: 'OPEN', headRefName: 'fix-branch', headRefOid: 'x' };
    const h = harness();
    h.infos = [h.info, moved];
    const p = parts('pr5', 'run-1', true);
    const thrown = await publish(h, p);
    expect((thrown as Error).message).toBe(REFUSE_PR_MOVED);
    expect(h.calls).not.toContain('write-journal');
    expect(h.calls.filter((c) => c === 'pr-info')).toHaveLength(2);
  });

  it('a renamed or closed PR on the re-read is refused', async () => {
    for (const latest of [
      { state: 'CLOSED', headRefName: 'fix-branch', headRefOid: TARGET },
      { state: 'OPEN', headRefName: 'other', headRefOid: TARGET },
    ]) {
      const h = harness();
      h.infos = [h.info, latest];
      const thrown = await publish(h, parts('pr5', 'run-1', true));
      expect((thrown as Error).message).toBe(REFUSE_PR_MOVED);
    }
  });

  it('a lease that is not an ancestor of the prepared head refuses after the journal, before the push', async () => {
    const h = harness();
    h.ancestors = (older, newer) => !(older === TARGET && newer === HEAD);
    const p = parts('pr5', 'run-1', true);
    const thrown = await publish(h, p);
    expect((thrown as Error).message).toBe(REFUSE_NOT_FAST_FORWARD);
    expect(h.calls).toContain('write-journal');
    expect(h.calls).toContain('save');
    expect(h.calls).not.toContain('push');
    expect(h.calls).not.toContain('finalize');
    expect(h.calls.at(-1)).toBe('remove-worktree');
    expect(p.record.publication).toEqual(h.journals[0]);
  });

  it('a new branch leases the empty value and never checks ancestry of the lease', async () => {
    const h = harness();
    await publish(h, parts());
    expect(h.pushes[0]!.expected).toBe('');
    expect(h.calls.filter((c) => c.startsWith('ancestor:'))).toEqual([]);
  });

  it('removes the worktree when the push fails, leaving the journal behind', async () => {
    const h = harness();
    h.pushImpl = () => {
      throw new PyError('RuntimeError', 'git push failed');
    };
    const p = parts();
    const thrown = await publish(h, p);
    expect((thrown as Error).message).toBe('git push failed');
    expect(h.calls.at(-1)).toBe('remove-worktree');
    expect(h.journals).toHaveLength(1);
    expect(h.calls).not.toContain('finalize');
  });
});

describe('publishRepair: handoff to recovery and finalize', () => {
  it('a present journal is recovered: no worktree, no replay, no new journal', async () => {
    const h = harness();
    h.journal = {
      head: HEAD,
      target: TARGET,
      branch: 'crq/fix-run-1',
      commits: [CLAIM],
      open_pr: false,
    };
    h.lsRemote = `${HEAD}\trefs/heads/crq/fix-run-1`;
    const p = parts();
    expect(await publish(h, p)).toBeUndefined();
    expect(h.calls).toEqual(['read-journal', 'ls-remote', 'list-prs', 'finalize']);
    expect(h.finalized[0]).toBe(h.journal);
  });

  it('recovery pushes an unpushed journal with the lease recovery computes', async () => {
    const h = harness();
    h.journal = {
      head: HEAD,
      target: TARGET,
      branch: 'crq/fix-run-1',
      commits: [],
      open_pr: false,
    };
    const p = parts();
    await publish(h, p);
    expect(h.pushes).toEqual([{ branch: 'crq/fix-run-1', expected: '', sha: HEAD }]);
    expect(h.calls).not.toContain('head');
  });

  it("refuses the journal-present path with recovery's ValueError, nothing pushed", async () => {
    const h = harness();
    h.journal = {
      head: HEAD,
      target: TARGET,
      branch: 'crq/fix-run-1',
      commits: [],
      open_pr: false,
    };
    h.lsRemote = `${'9'.repeat(40)}\trefs/heads/crq/fix-run-1`;
    const thrown = await publish(h, parts());
    expect(isPyError(thrown, 'ValueError')).toBe(true);
    expect(h.pushes).toEqual([]);
  });

  it('a push failure on the first tick is picked up by the next tick from the journal', async () => {
    const h = harness();
    h.pushImpl = () => {
      throw new PyError('RuntimeError', 'network');
    };
    const p = parts();
    await publish(h, p);
    // Next tick: the journal now exists on disk, the branch is still absent.
    h.pushImpl = () => undefined;
    h.journal = h.journals[0]!;
    h.calls.length = 0;
    expect(await publish(h, p)).toBeUndefined();
    expect(h.pushes.at(-1)).toEqual({ branch: 'crq/fix-run-1', expected: '', sha: HEAD });
    expect(h.calls.some((c) => c.startsWith('worktree:'))).toBe(false);
    expect(h.calls).toContain('finalize');
  });
});

describe('publishRepair composed with finalizePublication', () => {
  function compose(itemId: string, run: string, open: number | null, limit: number | null) {
    const h = harness();
    const created: string[] = [];
    const listedByBranch = new Map<
      string,
      { number: number; url: string; state: string; headRefOid: string }[]
    >();
    const finalizeEffects: PublicationFinalizeEffects = {
      repo: 'o/r',
      iso: () => 'now',
      async listBranchPrs(branch) {
        return listedByBranch.get(branch) ?? [];
      },
      async repairProvenance() {
        return [];
      },
      async writeFixPrBody() {
        return '/body.md';
      },
      async writeJournal() {},
      async saveQueue() {},
      async createPr(request) {
        created.push(request.head);
        listedByBranch.set(request.head, [
          { number: 101, url: 'u', state: 'OPEN', headRefOid: HEAD },
        ]);
      },
      async newItem(q, fields) {
        (q.items as Rec[]).push(fields);
      },
    };
    const backlog = new FixPrBacklog();
    backlog.open = open;
    backlog.limit = limit;
    const p = parts(itemId, run);
    h.effects = {
      ...h.effects,
      finalize: (publication) =>
        finalizePublication(finalizeEffects, backlog, p.q, p.item, p.run, p.record, publication),
    };
    return { h, p, created, backlog };
  }

  it('creates an ordinary fix PR on the item-owned branch and publishes the record', async () => {
    const { h, p, created } = compose('pr5', 'run-1', null, null);
    await publishRepair(h.effects, p.q, p.item, p.run, p.record, p.fixed);
    expect(created).toEqual(['crq/fix-run-1']);
    expect(p.record.state).toBe('published');
    expect(p.item.state).toBe('done');
  });

  it('a backfill item publishes on the counted prefix and takes a slot', async () => {
    const { h, p, created, backlog } = compose('backfill-finding-a', 'revalidated-x', 3, 4);
    await publishRepair(h.effects, p.q, p.item, p.run, p.record, p.fixed);
    expect(created).toEqual(['crq/fix-backfill-revalidated-x']);
    expect(backlog.open).toBe(4);
    expect(p.record.state).toBe('published');
  });

  it('a backfill item with no free slot pushes, journals, then holds untouched for a later tick', async () => {
    const { h, p, created } = compose('backfill-finding-a', 'run-1', 4, 4);
    await publishRepair(h.effects, p.q, p.item, p.run, p.record, p.fixed);
    expect(created).toEqual([]);
    expect(h.pushes).toHaveLength(1);
    expect(h.journals).toHaveLength(1);
    expect(p.record.state).toBe('ready');
    // `publish` set `record.publication` before finalize, so the hold restores
    // exactly the journal (no pr_create_* bookkeeping); a later tick recovers it.
    expect(p.record.publication).toEqual(h.journals[0]);
    expect(p.record.publication).not.toHaveProperty('pr_create_attempts');
    expect(p.record).not.toHaveProperty('fix_pr');
  });
});
