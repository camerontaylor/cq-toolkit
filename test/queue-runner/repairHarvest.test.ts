import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileRepairHarvestReads } from '../../src/adapters/crq/repairHarvestReads.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import type { Item, Queue } from '../../src/queue-runner/repairBackfill.js';
import { repairHarvest, type RepairHarvestEffects } from '../../src/queue-runner/repairHarvest.js';

const PYTHON_DIR = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);

/** `kind:message` raise directive for a fake effect. */
type Raise = string;

interface Spec {
  readonly item: Record<string, unknown>;
  readonly dry?: boolean;
  /** Files under `state/` (an object is JSON-encoded, a string is written raw). */
  readonly files?: Record<string, unknown>;
  /** job -> `require_canonical_delivery` raises. */
  readonly stale?: Record<string, Raise>;
  readonly verify?: Record<string, Raise>;
  readonly mechanical?: Record<string, Raise>;
  /** job -> `mark_finding_outcome` raises. */
  readonly outcome?: Record<string, Raise>;
  /** job -> the unpublished-FIXED sibling decision raises. */
  readonly sibling?: Record<string, Raise>;
  readonly publish?: Raise;
  /** `hasattr(c, 'WT_ROOT') and hasattr(c, 'CLONE')`; a job id keyed raise per alternate. */
  readonly cleanup?: boolean | Record<string, Raise>;
}

const PY = `
import sys, json, pathlib, builtins
sys.path.insert(0, sys.argv[1])
import repair_tick
import crq_repair
import crq_repair.retain as retain
root = pathlib.Path(sys.argv[2])
spec = json.loads(sys.argv[3])
calls = []
builtins.CALLS = calls
builtins.SPEC = spec

def dump(x):
    return json.dumps(x, separators=(',', ':'), ensure_ascii=False)

def raiser(directive):
    if not directive:
        return
    kind, _, msg = directive.partition(':')
    exc = {'value': ValueError, 'detector': crq_repair.DetectorUnavailable, 'runtime': RuntimeError,
           'os': OSError, 'key': KeyError, 'type': TypeError}[kind]
    raise exc(msg)

class C: pass
c = C()
c.STATE = root / 'state'
c.WT_ROOT = root / 'wt'
c.ROOT = root
c.CONFIG = {}
c.iso = lambda: '2026-11-20T00:00:00Z'
if spec.get('cleanup'):
    c.CLONE = root / 'clone'
def save_queue(q):
    calls.append(['save_queue', dump(q)])
c.save_queue = save_queue
def make_worktree(name, commit):
    calls.append(['make_worktree', name, commit])
    return (c.WT_ROOT / ('x-' + name), 'crq/' + name)
c.make_worktree = make_worktree
def remove_worktree(path, branch):
    calls.append(['remove_worktree', path.name, branch])
c.remove_worktree = remove_worktree

def canonical(_root, job):
    calls.append(['canonical', job['job']])
    raiser(spec.get('stale', {}).get(job['job']))
repair_tick.require_canonical_delivery = canonical
def verify(wt, predecessor, commits, job_id):
    calls.append(['verify', wt.name, predecessor, commits, job_id])
    raiser(spec.get('verify', {}).get(job_id))
repair_tick.verify = verify
def mark(_c, job, result, merge=None, fix_pr=None):
    calls.append(['mark', job.get('job'), dump(result)])
    raiser(spec.get('outcome', {}).get(job.get('job')))
repair_tick.mark_finding_outcome = mark
class Inbox:
    def repair_outcome(self, fid, job_id, action, reason, now, **kw):
        calls.append(['sibling', fid, job_id, action, reason, kw.get('repair_base'), kw.get('failure_class')])
        raiser(spec.get('sibling', {}).get(job_id))
repair_tick.finding_inbox = lambda _c: Inbox()
def publish(_c, q, item, run, record, fixed):
    calls.append(['publish', run, [v['job'] for v in fixed], dump(record)])
    raiser(spec.get('publish'))
repair_tick.publish = publish
def cleanup(clone, wt_root, path, item_id, job_id, result, alternate=False):
    calls.append(['cleanup', item_id, job_id, alternate])
    cfg = spec.get('cleanup')
    if isinstance(cfg, dict):
        raiser(cfg.get(job_id))
retain.cleanup_harvested = cleanup
(root / 'crq_repair.py').write_text(
    "import builtins\\n"
    "def mechanical(config, wt, predecessor, commits, job_id, directory):\\n"
    "    builtins.CALLS.append(['mechanical', wt.name, predecessor, commits, job_id, directory.name])\\n"
    "    import crq_repair\\n"
    "    directive = builtins.SPEC.get('mechanical', {}).get(job_id)\\n"
    "    if directive:\\n"
    "        kind, _, msg = directive.partition(':')\\n"
    "        raise {'value': ValueError, 'detector': crq_repair.DetectorUnavailable}[kind](msg)\\n")

q = {'items': [spec['item']]}
item = q['items'][0]
result = {}
try:
    result['messages'] = repair_tick.harvest(c, q, item, dry=bool(spec.get('dry')))
except Exception as e:
    name = type(e).__name__
    result['error'] = name if name in ('ValueError', 'RuntimeError', 'DetectorUnavailable') else 'other'
result['queue'] = q
result['calls'] = calls
print(json.dumps(result))
`;

function layout(root: string, spec: Spec): void {
  mkdirSync(join(root, 'wt'), { recursive: true });
  for (const [rel, doc] of Object.entries(spec.files ?? {})) {
    const path = join(root, 'state', rel);
    mkdirSync(dirname(path), { recursive: true });
    const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
    writeFileSync(path, text.replaceAll('{WT}', join(root, 'wt')));
  }
}

interface Outcome {
  readonly messages?: string[] | undefined;
  readonly error?: string | undefined;
  readonly queue: string;
  readonly calls: string;
}

function runPython(spec: Spec): Outcome {
  const root = mkdtempSync(join(tmpdir(), 'repair-hv-py-'));
  dirs.push(root);
  layout(root, spec);
  const out = JSON.parse(
    execFileSync('python3', ['-I', '-c', PY, PYTHON_DIR, root, JSON.stringify(spec)], {
      encoding: 'utf8',
    }),
  ) as { messages?: string[]; error?: string; queue: { items: unknown[] }; calls: unknown[] };
  return {
    messages: out.messages,
    error: out.error,
    queue: JSON.stringify(out.queue.items[0]).replaceAll(root, '<ROOT>'),
    calls: JSON.stringify(out.calls).replaceAll(root, '<ROOT>'),
  };
}

function kindOf(e: unknown): string {
  if (
    e instanceof PyError &&
    ['ValueError', 'RuntimeError', 'DetectorUnavailable'].includes(e.kind)
  ) {
    return e.kind;
  }
  return 'other';
}

function raise(directive: Raise | undefined): void {
  if (!directive) return;
  const [kind, ...rest] = directive.split(':');
  const names: Record<string, PyError['kind']> = {
    value: 'ValueError',
    detector: 'DetectorUnavailable',
    runtime: 'RuntimeError',
    os: 'OSError',
    key: 'KeyError',
    type: 'TypeError',
  };
  const text = rest.join(':');
  // `str(KeyError('k'))` is the repr of the key.
  throw new PyError(names[kind as string] as PyError['kind'], kind === 'key' ? `'${text}'` : text);
}

async function runTs(spec: Spec): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'repair-hv-ts-'));
  dirs.push(root);
  layout(root, spec);
  const calls: unknown[] = [];
  const reads = fileRepairHarvestReads({
    stateRoot: join(root, 'state'),
    worktreeRoot: join(root, 'wt'),
  });
  const cleanup = spec.cleanup;
  const fx: RepairHarvestEffects = {
    ...reads,
    async requireCanonicalDelivery(job) {
      calls.push(['canonical', job.job]);
      raise(spec.stale?.[job.job as string]);
    },
    async makeWorktree(name, commit) {
      calls.push(['make_worktree', name, commit]);
      return { path: join(root, 'wt', `x-${name}`), branch: `crq/${name}` };
    },
    async removeWorktree(path, branch) {
      calls.push(['remove_worktree', basename(path), branch]);
    },
    async verify(wt, predecessor, commits, jobId) {
      calls.push(['verify', basename(wt), predecessor, commits, jobId]);
      raise(spec.verify?.[jobId]);
    },
    async mechanical(wt, predecessor, commits, jobId) {
      calls.push(['mechanical', basename(wt), predecessor, commits, jobId, jobId]);
      raise(spec.mechanical?.[jobId]);
    },
    async saveQueue(q) {
      calls.push(['save_queue', JSON.stringify(q)]);
    },
    async markFindingOutcome(job, result) {
      calls.push(['mark', job.job ?? null, JSON.stringify(result)]);
      raise(spec.outcome?.[job.job as string]);
    },
    async recordUnpublishedFixedSibling(findingId, jobId, reason, repairBase) {
      calls.push(['sibling', findingId, jobId, 'needs-human', reason, repairBase, 'exhausted']);
      raise(spec.sibling?.[jobId]);
    },
    cleanupHarvested: cleanup
      ? async (itemId, jobId, _result, alternate) => {
          calls.push(['cleanup', itemId, jobId, alternate]);
          if (typeof cleanup === 'object') raise(cleanup[jobId]);
        }
      : undefined,
    async publish(_q, _item, run, record, fixed) {
      calls.push(['publish', run, fixed.map((v) => v.job), JSON.stringify(record)]);
      raise(spec.publish);
    },
  };
  const parsed = JSON.parse(JSON.stringify(spec.item).replaceAll('{WT}', join(root, 'wt'))) as Item;
  const q: Queue = { items: [parsed] };
  let messages: string[] | undefined;
  let error: string | undefined;
  try {
    messages = await repairHarvest(q, parsed, fx, spec.dry === true);
  } catch (e) {
    error = kindOf(e);
  }
  return {
    messages,
    error,
    queue: JSON.stringify(parsed).replaceAll(root, '<ROOT>'),
    calls: JSON.stringify(calls).replaceAll(root, '<ROOT>'),
  };
}

async function same(spec: Spec): Promise<Outcome> {
  const py = runPython(spec);
  const ts = await runTs(spec);
  expect(ts.queue).toBe(py.queue);
  expect(ts.calls).toBe(py.calls);
  expect(ts.error).toBe(py.error);
  expect(ts.messages).toEqual(py.messages);
  return py;
}

// ------------------------------------------------------------------ fixtures

const J1 = 'crq-R-F1';
const J2 = 'crq-R-F2';

function item(over: Record<string, unknown> = {}, record: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    kind: 'push',
    state: 'repairing',
    repair_runs: { R: { state: 'queued', base: 'b0', jobs: [J1], ...record } },
    ...over,
  };
}

function job(id: string, over: Record<string, unknown> = {}) {
  return { job: id, item: 'i1', finding: { id: `f-${id}` }, ...over };
}

function fixed(id: string, over: Record<string, unknown> = {}) {
  return {
    job: id,
    item: 'i1',
    verdict: 'FIXED',
    commits: [SHA1],
    attempts: [{ rung: 'A1' }],
    worktree: `{WT}/crq-repair-i1-${id}`,
    repair_base: 'b0',
    reason: 'fixed',
    ...over,
  };
}

function verdict(id: string, v: string, over: Record<string, unknown> = {}) {
  return { job: id, item: 'i1', verdict: v, reason: `${v} reason`, ...over };
}

function files(...entries: Array<[string, unknown, unknown?]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, inbox, result] of entries) {
    out[`repair/inbox/${id}.json`] = inbox;
    if (result !== undefined) out[`repair/${id}/result.json`] = result;
  }
  return out;
}

describe('repairHarvest open runs (differential vs repair_tick.harvest)', () => {
  it('leaves a run alone while its result is missing', async () => {
    const out = await same({ item: item(), files: files([J1, job(J1), undefined]) });
    expect(out.messages).toEqual([]);
  });

  it('ignores a run in an unknown state', async () => {
    await same({ item: item({}, { state: 'weird' }), files: files([J1, job(J1), fixed(J1)]) });
  });

  it('publishes a verified FIXED job and marks the item done', async () => {
    const out = await same({ item: item(), files: files([J1, job(J1), fixed(J1)]) });
    expect(out.messages).toEqual(['i1: repair ready']);
    expect(out.queue).toContain('"state":"done"');
  });

  it('chains a second FIXED job on the first job commit', async () => {
    await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1)],
        [J2, job(J2), fixed(J2, { commits: [SHA2, SHA3], repair_base: SHA1 })],
      ),
    });
  });

  it('records publish_failed with a 300-character error', async () => {
    const out = await same({
      item: item(),
      files: files([J1, job(J1), fixed(J1)]),
      publish: `runtime:${'é'.repeat(400)}`,
    });
    expect(out.queue).toContain('publish_failed');
    expect(out.queue).toContain('repair_failed');
  });

  it('keeps a publish_failed run retrying and clears nothing on a repeat', async () => {
    await same({
      item: item({}, {}),
      files: files([J1, job(J1), fixed(J1)]),
      publish: 'value:no',
    });
  });

  it('treats a receipt item as done with its repair outcome', async () => {
    await same({
      item: item({ kind: 'merged-current' }),
      files: files([J1, job(J1), fixed(J1)]),
    });
    await same({
      item: item({ kind: 'merged-current' }),
      files: files([J1, job(J1), fixed(J1)]),
      publish: 'value:boom',
    });
  });

  it('ends a run of only NOT-FIXED verdicts done, and a FAILED one failed', async () => {
    await same({ item: item(), files: files([J1, job(J1), verdict(J1, 'NOT-FIXED')]) });
    await same({ item: item(), files: files([J1, job(J1), verdict(J1, 'FAILED')]) });
    await same({ item: item(), files: files([J1, job(J1), verdict(J1, 'STALE')]) });
    await same({
      item: item({ kind: 'merged-current' }),
      files: files([J1, job(J1), verdict(J1, 'FAILED')]),
    });
  });

  it('waits on a retry_after result without recording anything', async () => {
    await same({
      item: item(),
      files: files([
        J1,
        job(J1),
        { ...verdict(J1, 'FAILED'), retry_after: '2026-11-21T00:00:00Z' },
      ]),
    });
  });

  it('marks the first job outcome, then waits for the second result', async () => {
    await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), verdict(J1, 'NOT-FIXED')],
        [J2, job(J2)],
      ),
    });
  });

  it('marks the item stale when the canonical selection moved, unless dry', async () => {
    const spec: Spec = {
      item: item(),
      files: files([J1, job(J1), fixed(J1)]),
      stale: { [J1]: 'value:selection moved' },
    };
    await same(spec);
    await same({ ...spec, dry: true });
  });

  it('lets any other canonical-delivery failure escape', async () => {
    await same({
      item: item(),
      files: files([J1, job(J1), fixed(J1)]),
      stale: { [J1]: 'runtime:git down' },
    });
  });

  it('reports a dry harvest without effects', async () => {
    const out = await same({
      item: item(),
      files: files([J1, job(J1), fixed(J1)]),
      dry: true,
    });
    expect(out.messages).toEqual(['would harvest repair R']);
  });

  it('keeps a dry FIXED chain checked against the unmoved predecessor', async () => {
    await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1), fixed(J1)],
        [J2, job(J2), fixed(J2, { commits: [SHA2], repair_base: SHA1 })],
      ),
      dry: true,
    });
  });
});

describe('repairHarvest result validation (differential)', () => {
  const bad = (name: string, result: unknown, extra: Partial<Spec> = {}, jobOver = {}): void => {
    it(`terminalizes ${name}`, async () => {
      const out = await same({
        item: item(),
        files: files([J1, job(J1, { canonical_finding_id: 'F1', ...jobOver }), result]),
        ...extra,
      });
      expect(out.queue).toContain('invalid repair result');
    });
  };

  bad('a non-object result', ['x']);
  bad('an identity mismatch', fixed(J1, { job: 'crq-other' }));
  bad('an item mismatch', fixed(J1, { item: 'zzz' }));
  bad('a source binding mismatch', fixed(J1, { source_sha: 'x' }), {}, { source_sha: 'y' });
  bad('FIXED without commits', fixed(J1, { commits: [] }));
  bad('FIXED with a non-hex commit', fixed(J1, { commits: ['z'.repeat(40)] }));
  bad('FIXED with a short commit', fixed(J1, { commits: [SHA1, 'abc'] }));
  bad('FIXED with a non-list commits', fixed(J1, { commits: SHA1 }));
  bad('FIXED without attempts', fixed(J1, { attempts: [] }));
  bad('FIXED with an unknown rung', fixed(J1, { attempts: [{ rung: 'A9' }] }));
  bad('FIXED with a non-dict attempt', fixed(J1, { attempts: ['A1'] }));
  bad('FIXED with no worktree key', (({ worktree: _w, ...rest }) => rest)(fixed(J1)));
  bad('FIXED with a non-string worktree', fixed(J1, { worktree: 7 }));
  bad('FIXED with a null worktree', fixed(J1, { worktree: null }));
  bad(
    'FIXED with a worktree outside the root',
    fixed(J1, { worktree: '/elsewhere/crq-repair-i1' }),
  );
  bad('FIXED with a wrong worktree name', fixed(J1, { worktree: '{WT}/other' }));
  bad('FIXED with a nested worktree', fixed(J1, { worktree: '{WT}/sub/crq-repair-i1' }));
  bad('FIXED with a NUL in the worktree path', fixed(J1, { worktree: '{WT}/a\u0000b' }));
  bad('FIXED on the wrong base', fixed(J1, { repair_base: 'other' }));
  bad('an unknown verdict', verdict(J1, 'MAYBE'));
  bad('a missing verdict', { job: J1, item: 'i1', reason: 'r' });
  bad('a non-string reason', { ...verdict(J1, 'FAILED'), reason: 3 });

  it('terminalizes malformed result JSON (parser message text is a known gap)', async () => {
    const spec: Spec = {
      item: item(),
      files: files([J1, job(J1, { canonical_finding_id: 'F1' }), '{not json']),
    };
    const py = runPython(spec);
    const ts = await runTs(spec);
    const mask = (text: string, message: string): string => text.replaceAll(message, '<MSG>');
    const pyMsg = 'Expecting property name enclosed in double quotes: line 1 column 2 (char 1)';
    const tsMsg = 'expected an object key at byte offset 1';
    expect(py.queue).toContain(pyMsg);
    expect(mask(ts.queue, tsMsg)).toBe(mask(py.queue, pyMsg));
    expect(mask(ts.calls, tsMsg)).toBe(mask(py.calls, pyMsg));
    expect(ts.queue).toContain('invalid repair result: ');
  });

  it('accepts the legacy and A2 worktree names', async () => {
    for (const worktree of ['{WT}/crq-repair-i1', `{WT}/crq-repair-i1-${J1}-A2`]) {
      await same({
        item: item(),
        files: files([J1, job(J1), fixed(J1, { worktree })]),
      });
    }
  });

  it('accepts a source-bound result and rejects it once the binding differs', async () => {
    const bound = { source_sha: 's', finding_sha256: 'f', origin_job: 'o' };
    await same({ item: item(), files: files([J1, job(J1, bound), fixed(J1, bound)]) });
    await same({
      item: item(),
      files: files([J1, job(J1, bound), fixed(J1, { ...bound, origin_job: 'x' })]),
    });
  });

  it('terminalizes before saving the queue and notes unpublished FIXED siblings', async () => {
    const out = await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1, { repair_base: 'wrong' })],
        [J2, job(J2, { canonical_finding_id: 'F2', repair_base: 'rb' }), fixed(J2)],
      ),
    });
    expect(out.calls.indexOf('save_queue')).toBeLessThan(out.calls.indexOf('sibling'));
  });

  it('applies the sibling identity and binding checks to terminal siblings', async () => {
    const bound = { source_sha: 's', finding_sha256: 'f', origin_job: 'o' };
    await same({
      item: item({}, { jobs: [J1, J2, 'crq-R-F3', 'crq-R-F4'] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1, { repair_base: 'wrong' })],
        [J2, job(J2, { canonical_finding_id: 'F2' }), verdict(J2, 'FAILED', { job: 'crq-evil' })],
        [
          'crq-R-F3',
          job('crq-R-F3', { canonical_finding_id: 'F3', ...bound }),
          verdict('crq-R-F3', 'STALE'),
        ],
        [
          'crq-R-F4',
          job('crq-R-F4', { canonical_finding_id: 'F4' }),
          verdict('crq-R-F4', 'NOT-FIXED'),
        ],
      ),
    });
  });

  it('skips siblings without a finding id, a result, or readable files', async () => {
    await same({
      item: item({}, { jobs: [J1, J2, 'crq-R-F3', 'crq-R-F4', 7] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), verdict(J1, 'FAILED', { reason: 3 })],
        [J2, job(J2), verdict(J2, 'NOT-FIXED')],
        ['crq-R-F3', job('crq-R-F3', { canonical_finding_id: 'F3' }), undefined],
        ['crq-R-F4', '{broken', verdict('crq-R-F4', 'FAILED')],
      ),
    });
  });

  it('rethrows the first sibling failure after trying every sibling', async () => {
    const spec: Spec = {
      item: item({}, { jobs: [J1, J2, 'crq-R-F3'] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1, { repair_base: 'wrong' })],
        [J2, job(J2, { canonical_finding_id: 'F2' }), fixed(J2)],
        ['crq-R-F3', job('crq-R-F3', { canonical_finding_id: 'F3' }), fixed('crq-R-F3')],
      ),
      sibling: { [J2]: 'value:ledger down' },
    };
    const out = await same(spec);
    expect(out.error).toBe('ValueError');
    expect(out.calls).toContain('crq-R-F3');
  });

  it('lets a non-ledger sibling failure escape unclassified', async () => {
    await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1, { repair_base: 'wrong' })],
        [J2, job(J2, { canonical_finding_id: 'F2' }), fixed(J2)],
      ),
      sibling: { [J2]: 'detector:x' },
    });
  });

  it('lets a failing outcome write-back escape the terminal path', async () => {
    await same({
      item: item(),
      files: files([J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1, { commits: [] })]),
      outcome: { [J1]: 'value:ledger down' },
    });
  });
});

describe('repairHarvest verification (differential)', () => {
  const spec = (over: Partial<Spec>): Spec => ({
    item: item(),
    files: files([
      J1,
      job(J1, { canonical_finding_id: 'F1' }),
      fixed(J1, { commits: [SHA1, SHA2] }),
    ]),
    ...over,
  });

  it('verifies in a detached worktree and removes it', async () => {
    const out = await same(spec({}));
    expect(out.calls).toContain('make_worktree');
    expect(out.calls).toContain('remove_worktree');
  });

  it('terminalizes a rejected claimed range and still removes the worktree', async () => {
    await same(spec({ verify: { [J1]: 'value:duplicate commits' } }));
    await same(spec({ mechanical: { [J1]: 'value:oversize diff' } }));
  });

  it('keeps DetectorUnavailable and other failures on the retry path', async () => {
    await same(spec({ verify: { [J1]: 'detector:cli never ran' } }));
    await same(spec({ mechanical: { [J1]: 'detector:cli never ran' } }));
    await same(spec({ verify: { [J1]: 'runtime:git failed' } }));
    await same(spec({ verify: { [J1]: 'os:disk' } }));
  });

  it('does not verify in a dry run', async () => {
    await same(spec({ dry: true }));
  });

  it('records a later job against the verified predecessor', async () => {
    await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1), fixed(J1, { commits: [SHA1, SHA2] })],
        [J2, job(J2), fixed(J2, { commits: [SHA3], repair_base: SHA2 })],
      ),
    });
  });

  it('terminalizes the second job when it is not based on the first', async () => {
    await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1), fixed(J1, { commits: [SHA1, SHA2] })],
        [
          J2,
          job(J2, { canonical_finding_id: 'F2' }),
          fixed(J2, { commits: [SHA3], repair_base: SHA1 }),
        ],
      ),
    });
  });
});

describe('repairHarvest terminal runs (differential)', () => {
  const failedRecord = (verdicts: unknown[], extra: Record<string, unknown> = {}) => ({
    state: 'failed',
    base: 'b0',
    jobs: [J1, J2],
    verdicts,
    ...extra,
  });
  const invalid = (id: string, over: Record<string, unknown> = {}) => ({
    job: id,
    item: 'i1',
    verdict: 'FAILED',
    reason: 'invalid repair result: bad',
    finding: { id: 'f' },
    ...over,
  });

  it('settles terminal receipt and repairing items without a write-back', async () => {
    for (const state of ['published', 'done', 'failed', 'stale']) {
      await same({ item: item({}, { state }) });
      await same({ item: item({ kind: 'merged-current' }, { state }) });
      await same({ item: item({ state: 'done' }, { state }) });
    }
  });

  it('replays a retained invalid-result failure through the ledger', async () => {
    await same({
      item: item({}, failedRecord([invalid(J1)])),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), undefined],
        [J2, job(J2, { canonical_finding_id: 'F2' }), fixed(J2)],
      ),
    });
  });

  it('replays nothing for other verdicts, reasons or a non-failed record', async () => {
    const spec = (record: Record<string, unknown>): Spec => ({
      item: item({}, record),
      files: files([J1, job(J1, { canonical_finding_id: 'F1' })], [J2, job(J2)]),
    });
    await same(spec(failedRecord([invalid(J1, { verdict: 'NOT-FIXED', reason: 3 })])));
    await same(spec(failedRecord([invalid(J1, { reason: 'plain' })])));
    await same(spec({ ...failedRecord([invalid(J1)]), state: 'done' }));
    await same({ ...spec(failedRecord([invalid(J1)])), dry: true });
  });

  it('skips the save for a job with no canonical finding id', async () => {
    await same({
      item: item({}, failedRecord([invalid(J1)])),
      files: files([J1, job(J1)], [J2, job(J2)]),
    });
  });

  it('refuses a retained outcome or inbox job with the wrong identity', async () => {
    await same({
      item: item({}, failedRecord([invalid(J1, { job: 'crq-other' })])),
      files: files([J1, job(J1)]),
    });
    await same({
      item: item({}, failedRecord([invalid(J1, { item: 'zzz' })])),
      files: files([J1, job(J1)]),
    });
    await same({
      item: item({}, failedRecord([invalid(J1)])),
      files: files([J1, job(J1, { job: 'crq-other' })]),
    });
    await same({
      item: item({}, failedRecord([invalid(J1)])),
      files: files([J1, job(J1, { item: 'zzz' })]),
    });
  });

  it('fails the replay when a retained job file is gone', async () => {
    await same({ item: item({}, failedRecord([invalid(J1)])), files: {} });
  });

  it('cleans up every retained verdict, then a failed cleanup is a message', async () => {
    const record = (extra: Record<string, unknown> = {}) =>
      item(
        {},
        {
          state: 'done',
          jobs: [J1, J2],
          verdicts: [
            verdict(J1, 'FIXED'),
            verdict(J2, 'FAILED'),
            'junk',
            { job: 7 },
            { job: 'not-a-job' },
          ],
          ...extra,
        },
      );
    await same({ item: record(), cleanup: true });
    await same({ item: record(), cleanup: { [J1]: `os:${'x'.repeat(400)}` } });
    await same({ item: record(), cleanup: { [J2]: 'value:bad' } });
    await same({ item: record(), cleanup: { [J2]: 'runtime:bad' } });
    await same({ item: record(), cleanup: { [J2]: 'detector:bad' } });
    await same({ item: record(), cleanup: false });
    await same({ item: record(), cleanup: true, dry: true });
    await same({ item: record({ verdicts: [] }), cleanup: true });
  });

  it('does not let a cleanup KeyError past the message', async () => {
    await same({
      item: item({}, { state: 'done', jobs: [J1], verdicts: [verdict(J1, 'FIXED')] }),
      cleanup: { [J1]: 'key:missing' },
    });
  });
});

describe('repairHarvest with the file reads', () => {
  it('resolves paths like Path.resolve (symlinks and missing tails)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-hv-res-'));
    dirs.push(root);
    const reads = fileRepairHarvestReads({ stateRoot: root, worktreeRoot: root });
    expect(await reads.resolvePath(join(root, 'a', 'b'))).toBe(
      join(await reads.resolvePath(root), 'a', 'b'),
    );
    await expect(reads.resolvePath('a\0b')).rejects.toMatchObject({ kind: 'ValueError' });
    expect(await reads.resultExists('crq-none')).toBe(false);
    await expect(reads.readResult('crq-none')).rejects.toMatchObject({ kind: 'OSError' });
    mkdirSync(join(root, 'repair', 'crq-bad'), { recursive: true });
    writeFileSync(join(root, 'repair', 'crq-bad', 'result.json'), Buffer.from([0xff]));
    await expect(reads.readResult('crq-bad')).rejects.toMatchObject({ kind: 'ValueError' });
    writeFileSync(join(root, 'repair', 'crq-bad', 'result.json'), '{nope');
    await expect(reads.readResult('crq-bad')).rejects.toMatchObject({ kind: 'ValueError' });
  });
});
