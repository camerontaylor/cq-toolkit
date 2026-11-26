import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  /** Symlinks under `state/`: relative path -> link target text. */
  readonly symlinks?: Record<string, string>;
  /** A `state/` directory chmod 000 once the layout is written (restored after the run). */
  readonly lock?: string;
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

def canonical(_root, job, **_kwargs):
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

function layout(root: string, spec: Spec): () => void {
  mkdirSync(join(root, 'wt'), { recursive: true });
  for (const [rel, doc] of Object.entries(spec.files ?? {})) {
    const path = join(root, 'state', rel);
    mkdirSync(dirname(path), { recursive: true });
    if (doc instanceof Uint8Array) {
      writeFileSync(path, doc); // raw bytes: a fixture that is not valid UTF-8
      continue;
    }
    const text = typeof doc === 'string' ? doc : JSON.stringify(doc);
    writeFileSync(path, text.replaceAll('{WT}', join(root, 'wt')));
  }
  for (const [rel, target] of Object.entries(spec.symlinks ?? {})) {
    const path = join(root, 'state', rel);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
  }
  if (spec.lock === undefined) return () => undefined;
  const locked = join(root, 'state', spec.lock);
  chmodSync(locked, 0o000);
  return () => chmodSync(locked, 0o755);
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
  const restore = layout(root, spec);
  let out: { messages?: string[]; error?: string; queue: { items: unknown[] }; calls: unknown[] };
  try {
    out = JSON.parse(
      execFileSync('python3', ['-I', '-c', PY, PYTHON_DIR, root, JSON.stringify(spec)], {
        encoding: 'utf8',
      }),
    ) as typeof out;
  } finally {
    restore();
  }
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
  const restore = layout(root, spec);
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
  } finally {
    restore();
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

  it('retries a publish_failed run: publish is called again and its error is replaced', async () => {
    const retained = { state: 'publish_failed', error: 'earlier failure' };
    const base = {
      item: item({ state: 'repair_failed' }, retained),
      files: files([J1, job(J1), fixed(J1)]),
    };
    // Publication keeps failing: the run stays publish_failed with the NEW error.
    const again = await same({ ...base, publish: 'value:still down' });
    expect(again.calls).toContain('"publish"');
    expect(again.queue).toContain('still down');
    expect(again.queue).not.toContain('earlier failure');
    expect(again.queue).toContain('"state":"publish_failed"');
    // Publication recovers: the harvest calls publish again (the injected publish
    // does the state change; here it leaves the run `ready`).
    const ok = await same(base);
    expect(ok.calls).toContain('"publish"');
    expect(ok.queue).toContain('"state":"ready"');
    // A dry run retries nothing.
    const dry = await same({ ...base, dry: true });
    expect(dry.calls).not.toContain('"publish"');
    expect(dry.queue).toContain('earlier failure');
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

  it('keeps the run retryable while the triage row is unreadable', async () => {
    const spec: Spec = {
      item: item(),
      files: files([J1, job(J1), fixed(J1)]),
      stale: { [J1]: 'value:canonical delivery state unavailable' },
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

// Harvest reads `result.json` through `Path.exists()`; Python 3.14 reports every
// stat OSError as absent. Here "absent" only ends the job scan (`break`), so the
// run stays open and is retried next tick: nothing is rebound or archived. The
// port matches that for every errno, and these runs pin the queue effects.
describe('repairHarvest result.json stat errors (differential vs Path.exists)', () => {
  const canLock = process.getuid?.() !== 0; // root ignores the mode bits
  const open = (): Spec['item'] => item();
  const runState = (out: Outcome): unknown =>
    (JSON.parse(out.queue) as { repair_runs: { R: { state: unknown } } }).repair_runs.R.state;
  const heldOpen = (out: Outcome): void => {
    expect(out.messages).toEqual([]);
    expect(out.calls).toBe('[]'); // no mark, verify, publish or save
    expect(runState(out)).toBe('queued');
  };

  it('keeps the run open when repair/<job> is a file (ENOTDIR)', async () => {
    heldOpen(
      await same({
        item: open(),
        files: { 'repair/inbox/crq-R-F1.json': job(J1), 'repair/crq-R-F1': 'not a dir' },
      }),
    );
  });

  it('keeps the run open behind a dangling result.json link (ENOENT)', async () => {
    heldOpen(
      await same({
        item: open(),
        files: files([J1, job(J1), undefined]),
        symlinks: { 'repair/crq-R-F1/result.json': 'gone.json' },
      }),
    );
  });

  it('keeps the run open behind a result.json symlink loop (ELOOP)', async () => {
    heldOpen(
      await same({
        item: open(),
        files: files([J1, job(J1), undefined]),
        symlinks: { 'repair/crq-R-F1/result.json': 'result.json' },
      }),
    );
  });

  it.skipIf(!canLock)(
    'keeps the run open, unharvested, while the result dir is unreadable (EACCES)',
    async () => {
      heldOpen(
        await same({
          item: open(),
          files: files([J1, job(J1), fixed(J1)]),
          lock: 'repair/crq-R-F1',
        }),
      );
    },
  );

  it.skipIf(!canLock)(
    'harvests the readable first job, then waits on the unreadable second',
    async () => {
      const out = await same({
        item: item({}, { jobs: [J1, J2] }),
        files: files([J1, job(J1), verdict(J1, 'NOT-FIXED')], [J2, job(J2), fixed(J2)]),
        lock: 'repair/crq-R-F2',
      });
      expect(runState(out)).toBe('queued');
      expect(out.calls).toContain('"mark"');
      expect(out.calls).not.toContain('"publish"');
    },
  );
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

  // The retry-timing case still pins the Python behavior; the identity case
  // now shares the checks that run ahead of the verdict dispatch in both
  // runtimes.
  it('terminalizes a mismatched sibling instead of recording its unpublished-FIXED decision', async () => {
    const out = await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1, { repair_base: 'wrong' })],
        [
          J2,
          job(J2, { canonical_finding_id: 'F2', repair_base: 'rb' }),
          fixed(J2, { job: 'crq-evil', item: 'other' }),
        ],
      ),
    });
    expect(out.calls).not.toContain('["sibling"');
    expect(out.calls).toContain('invalid repair result: sibling identity mismatch');
  });

  // TS-only: Python raises on any unreadable inbox. A malformed document is a
  // deterministic defect and fails its run without a finding write; a read
  // fault is not a content defect, so the run stays open for the next tick.
  it('terminalizes a malformed inbox without any finding write', async () => {
    const out = await runTs({
      item: item({}, { jobs: [J1] }),
      files: files([J1, '[]', fixed(J1)]),
    });
    expect(out.error).toBeUndefined();
    expect(out.queue).toContain('invalid repair inbox');
    expect(out.queue).toContain('"state":"failed"');
    expect(out.calls).not.toContain('["mark"');
  });

  it('terminalizes a mismatched inbox identity and still harvests a later run', async () => {
    const swapped = await runTs({
      item: item({}, { jobs: [J1] }),
      files: files([J1, job(J1, { job: 'crq-other', canonical_finding_id: 'F1' }), fixed(J1)]),
    });
    expect(swapped.error).toBeUndefined();
    expect(swapped.queue).toContain('invalid repair inbox: repair job identity mismatch');
    expect(swapped.queue).toContain('"state":"failed"');
    expect(swapped.calls).not.toContain('["mark"');
    const wrongItem = await runTs({
      item: item({}, { jobs: [J1] }),
      files: files([J1, job(J1, { item: 'zzz', canonical_finding_id: 'F1' }), fixed(J1)]),
    });
    expect(wrongItem.error).toBeUndefined();
    expect(wrongItem.queue).toContain('"state":"failed"');
    expect(wrongItem.calls).not.toContain('["mark"');

    // A later run on the same item is not blocked by the swapped inbox.
    const two = item({}, { jobs: [J1] }) as { repair_runs: Record<string, unknown> };
    two.repair_runs.R2 = { state: 'queued', base: 'b0', jobs: [J2] };
    const later = await runTs({
      item: two,
      files: files(
        [J1, job(J1, { job: 'crq-other' }), fixed(J1)],
        [J2, job(J2, { canonical_finding_id: 'F2' }), verdict(J2, 'FAILED')],
      ),
    });
    expect(later.error).toBeUndefined();
    expect(later.calls).toContain('"mark","crq-R-F2"');
  });

  // The malformed-inbox terminalization is a deliberate TS-only difference: a
  // content defect in the inbox fails its run once, where Python re-raises on every
  // tick. These fixtures run both sides and pin the boundary: Python raises (the
  // queue is left untouched, nothing is written), TS terminalizes without ever
  // handing the file's content to canonical delivery or the finding ledger.
  describe('malformed inbox content (Python raises, TS terminalizes)', () => {
    const SHAPES: Array<[string, unknown]> = [
      ['unparsable JSON', '{not json'],
      ['an empty file', ''],
      ['trailing garbage', '{"job":"x"} x'],
      ['invalid UTF-8', new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])],
      ['a UTF-8 byte-order mark', '﻿{}'],
      ['a UTF-16 document', new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00])],
      ['JSON null', 'null'],
      ['a JSON number', '7'],
      ['a JSON string', '"crq-R-F1"'],
      ['a JSON boolean', 'true'],
      ['a JSON list of objects', '[{"job":"crq-R-F1","item":"i1","canonical_finding_id":"F1"}]'],
    ];
    for (const [name, body] of SHAPES) {
      it(`fails the run alone on ${name}`, async () => {
        const spec: Spec = {
          item: item({}, { jobs: [J1] }),
          files: files([J1, body, fixed(J1)]),
        };
        const py = runPython(spec);
        expect(py.error).toBeDefined(); // Python never survives an unreadable inbox
        expect(py.calls).not.toContain('"mark"');
        expect(py.queue).not.toContain('"state":"failed"');
        const ts = await runTs(spec);
        expect(ts.error).toBeUndefined();
        expect(ts.queue).toContain('"state":"failed"');
        expect(ts.queue).toContain('"state":"repair_failed"');
        expect(ts.queue).toContain('"last_error":"repair_failed; needs human"');
        expect(ts.queue).toContain('"reason":"invalid repair inbox: ');
        expect(ts.queue).toContain('"finding":null');
        // Exactly one queue save, and no ledger or delivery call derived from the file.
        expect(ts.calls).toMatch(/^\[\["save_queue",/);
        expect(JSON.parse(ts.calls)).toHaveLength(1);
      });
    }

    it('refuses a byte-order-marked inbox that is otherwise valid, so no finding is written', async () => {
      // Stripping the BOM would make this a well-formed, correctly bound inbox, and the
      // harvest would write a finding outcome from a file Python's json.loads rejects.
      const spec: Spec = {
        item: item({}, { jobs: [J1] }),
        files: files([
          J1,
          `\ufeff${JSON.stringify(job(J1, { canonical_finding_id: 'F1' }))}`,
          verdict(J1, 'NOT-FIXED'),
        ]),
      };
      const py = runPython(spec);
      expect(py.error).toBeDefined(); // JSONDecodeError: Unexpected UTF-8 BOM
      expect(py.calls).not.toContain('"mark"');
      const ts = await runTs(spec);
      expect(ts.error).toBeUndefined();
      expect(ts.queue).toContain('"reason":"invalid repair inbox: ');
      expect(ts.queue).toContain('"state":"failed"');
      expect(ts.queue).toContain('"finding":null');
      expect(ts.calls).not.toContain('"mark"');
      expect(ts.calls).not.toContain('"canonical"');
      expect(JSON.parse(ts.calls)).toHaveLength(1); // the terminal queue save only
    });

    it('does not read the inbox while the result is absent (nothing to terminalize yet)', async () => {
      const out = await same({
        item: item({}, { jobs: [J1] }),
        files: { [`repair/inbox/${J1}.json`]: '{not json' }, // no result.json
      });
      expect(out.error).toBeUndefined();
      expect(out.queue).toContain('"state":"queued"');
    });

    it('terminalizes before the result artifact is read, even a retry_after one', async () => {
      const out = await runTs({
        item: item({}, { jobs: [J1] }),
        files: files([J1, '{not json', { ...verdict(J1, 'FAILED'), retry_after: 60 }]),
      });
      expect(out.error).toBeUndefined();
      expect(out.queue).toContain('invalid repair inbox');
    });

    it('terminalizes a receipt item as done with its repair outcome', async () => {
      const out = await runTs({
        item: item({ kind: 'merged-current' }, { jobs: [J1] }),
        files: files([J1, '[]', fixed(J1)]),
      });
      expect(out.error).toBeUndefined();
      expect(out.queue).toContain('"state":"done"');
      expect(out.queue).toContain('"repair_outcome":"failed"');
      expect(out.queue).toContain('"last_error":null');
    });

    it('leaves a dry harvest alone: no terminalization, no save', async () => {
      const spec: Spec = {
        item: item({}, { jobs: [J1] }),
        files: files([J1, '{not json', fixed(J1)]),
        dry: true,
      };
      expect(runPython(spec).error).toBeDefined();
      const ts = await runTs(spec);
      expect(ts.error).toBeUndefined();
      expect(ts.messages).toEqual([]);
      expect(ts.queue).toContain('"state":"queued"');
      expect(ts.calls).toBe('[]');
    });

    it('keeps the verdicts already harvested and writes nothing for the rejected job', async () => {
      const two = item({}, { jobs: [J1, J2] });
      const spec: Spec = {
        item: two,
        files: files(
          [J1, job(J1, { canonical_finding_id: 'F1' }), verdict(J1, 'NOT-FIXED')],
          [J2, '{not json', fixed(J2)],
        ),
      };
      const py = runPython(spec);
      expect(py.error).toBeDefined();
      expect(py.calls).toContain('"mark","crq-R-F1"'); // Python marked J1, then raised
      const ts = await runTs(spec);
      expect(ts.error).toBeUndefined();
      // Order: J1's own outcome, then the terminal save (before any write-back from
      // the rejection), then the idempotent sibling replay of J1. J2 is never
      // canonical-checked and never marked.
      const calls = JSON.parse(ts.calls) as string[][];
      expect(calls.map((c) => c[0])).toEqual(['canonical', 'mark', 'save_queue', 'mark']);
      expect(calls[1]?.[1]).toBe(J1);
      expect(calls[3]?.[1]).toBe(J1);
      expect(ts.calls).not.toContain(J2 + '","');
      const verdicts = (JSON.parse(ts.queue) as { repair_runs: { R: { verdicts: unknown[] } } })
        .repair_runs.R.verdicts;
      expect(verdicts).toHaveLength(2);
      expect(JSON.stringify(verdicts[0])).toContain('"verdict":"NOT-FIXED"');
      expect(JSON.stringify(verdicts[1])).toContain('invalid repair inbox: ');
    });

    it('terminalizes a wrong-shape inbox, then a replay tick leaves the failed run alone', async () => {
      const first = await runTs({
        item: item({}, { jobs: [J1, J2] }),
        files: files(
          [J1, '[]', fixed(J1)],
          [J2, job(J2, { canonical_finding_id: 'F2' }), fixed(J2)],
        ),
      });
      expect(first.error).toBeUndefined();
      // The J2 sibling is a verified FIXED result of a dead run: it gets its own decision.
      expect(first.calls).toContain('"sibling","F2"');
      const replay = await runTs({
        item: JSON.parse(first.queue) as Record<string, unknown>,
        files: files(
          [J1, '[]', fixed(J1)],
          [J2, job(J2, { canonical_finding_id: 'F2' }), fixed(J2)],
        ),
      });
      expect(replay.error).toBeUndefined();
      expect(replay.queue).toBe(first.queue);
      expect(replay.calls).toContain('"sibling","F2"'); // idempotent re-decision, nothing for J1
      expect(replay.calls).not.toContain('"sibling","F1"');
      expect(replay.calls).not.toContain('"mark"');
    });
  });

  // Not a content defect: the inbox may be fine, so the run stays open and the
  // read is retried on a later tick, exactly as Python's uncaught OSError does.
  describe('transient inbox state (Python and TS both retry)', () => {
    it('keeps the run open when the inbox is a directory (EISDIR)', async () => {
      const out = await same({
        item: item({}, { jobs: [J1] }),
        files: { [`repair/inbox/${J1}.json/x`]: '{}', [`repair/${J1}/result.json`]: fixed(J1) },
      });
      expect(out.error).toBe('other');
      expect(out.queue).toContain('"state":"queued"');
    });

    it('keeps the run open when the inbox is a dangling symlink', async () => {
      const out = await same({
        item: item({}, { jobs: [J1] }),
        files: { [`repair/${J1}/result.json`]: fixed(J1) },
        symlinks: { [`repair/inbox/${J1}.json`]: 'gone.json' },
      });
      expect(out.error).toBe('other');
      expect(out.queue).toContain('"state":"queued"');
    });

    it('keeps the run open when the inbox directory is unreadable', async () => {
      if (process.getuid?.() === 0) return; // root ignores the mode bits
      const out = await same({
        item: item({}, { jobs: [J1] }),
        files: files([J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1)]),
        lock: 'repair/inbox',
      });
      expect(out.error).toBe('other');
      expect(out.queue).toContain('"state":"queued"');
      expect(out.calls).not.toContain('"mark"');
    });

    it('harvests on the next tick once the inbox appears', async () => {
      const first = await same({
        item: item({}, { jobs: [J1] }),
        files: { [`repair/${J1}/result.json`]: verdict(J1, 'NOT-FIXED') },
      });
      expect(first.error).toBe('other');
      const next = await same({
        item: JSON.parse(first.queue) as Record<string, unknown>,
        files: files([J1, job(J1, { canonical_finding_id: 'F1' }), verdict(J1, 'NOT-FIXED')]),
      });
      expect(next.error).toBeUndefined();
      expect(next.queue).toContain('"state":"done"');
      expect(next.calls).toContain('"mark","crq-R-F1"');
    });

    it('treats a later missing inbox as transient after an earlier job was harvested', async () => {
      const out = await same({
        item: item({}, { jobs: [J1, J2] }),
        files: {
          ...files([J1, job(J1, { canonical_finding_id: 'F1' }), verdict(J1, 'NOT-FIXED')]),
          [`repair/${J2}/result.json`]: verdict(J2, 'NOT-FIXED'),
        },
      });
      expect(out.error).toBe('other');
      expect(out.calls).toContain('"mark","crq-R-F1"'); // J1's outcome is idempotent on the retry
      expect(out.queue).toContain('"state":"queued"');
    });
  });

  // Valid-to-Python documents the TS read must not mistake for malformed.
  describe('inbox documents Python accepts', () => {
    it('accepts the non-finite constants json.dump writes', async () => {
      for (const token of ['NaN', 'Infinity', '-Infinity']) {
        const body = `{"job":"${J1}","item":"i1","finding":{"id":"f-${J1}"},"canonical_finding_id":"F1","weight":${token}}`;
        const out = await same({
          item: item({}, { jobs: [J1] }),
          files: files([J1, body, verdict(J1, 'NOT-FIXED')]),
        });
        expect(out.error).toBeUndefined();
        expect(out.queue).toContain('"state":"done"');
        expect(out.calls).toContain('"mark","crq-R-F1"');
      }
    });

    it('keeps the last of a duplicated key', async () => {
      const body = `{"job":"${J1}","item":"i1","finding":{"id":"a"},"finding":{"id":"b"},"canonical_finding_id":"F1"}`;
      const out = await same({
        item: item({}, { jobs: [J1] }),
        files: files([J1, body, verdict(J1, 'NOT-FIXED')]),
      });
      expect(out.queue).toContain('"finding":{"id":"b"}');
    });

    it('accepts a non-finite constant in a result artifact too', async () => {
      // TS only: Python echoes the NaN into its own queue dump, which JSON.parse refuses.
      const out = await runTs({
        item: item({}, { jobs: [J1] }),
        files: files([
          J1,
          job(J1, { canonical_finding_id: 'F1' }),
          `{"job":"${J1}","item":"i1","verdict":"NOT-FIXED","reason":"r","cost":NaN}`,
        ]),
      });
      expect(out.error).toBeUndefined();
      expect(out.queue).toContain('"state":"done"'); // not terminalized as an invalid result
      expect(out.calls).toContain('"mark","crq-R-F1"');
    });

    it('refuses a byte-order-marked result as an invalid result, like Python', async () => {
      const spec: Spec = {
        item: item({}, { jobs: [J1] }),
        files: files([
          J1,
          job(J1, { canonical_finding_id: 'F1' }),
          `﻿${JSON.stringify(verdict(J1, 'NOT-FIXED'))}`,
        ]),
      };
      const py = runPython(spec);
      const ts = await runTs(spec);
      expect(py.queue).toContain('"state":"failed"');
      expect(py.queue).toContain('invalid repair result: ');
      expect(ts.queue).toContain('"state":"failed"');
      expect(ts.queue).toContain('invalid repair result: ');
    });
  });

  // An inbox whose JSON is a dict but lacks `finding` is not malformed content:
  // both sides read `expected['finding']` and raise KeyError, leaving the run to retry.
  it('lets an inbox without a finding raise KeyError on both sides', async () => {
    const noFinding = { job: J1, item: 'i1', canonical_finding_id: 'F1' };
    const ok = await same({
      item: item({}, { jobs: [J1] }),
      files: files([J1, noFinding, verdict(J1, 'NOT-FIXED')]),
    });
    expect(ok.error).toBe('other');
    expect(ok.queue).toContain('"state":"queued"');
    const bad = await same({
      item: item({}, { jobs: [J1] }),
      files: files([J1, noFinding, fixed(J1, { commits: [] })]),
    });
    expect(bad.error).toBe('other');
    expect(bad.queue).toContain('"state":"queued"');
  });

  it('keeps a rejected inbox out of the sibling replay on later ticks', async () => {
    // State after the first tick terminalized J1's swapped inbox (null finding).
    const rejected = {
      job: J1,
      item: 'i1',
      verdict: 'FAILED',
      reason: 'invalid repair inbox: repair job identity mismatch',
      finding: null,
    };
    const out = await runTs({
      item: item({}, { state: 'failed', jobs: [J1, J2], verdicts: [rejected] }),
      files: files(
        [J1, job(J1, { job: 'crq-other', canonical_finding_id: 'F1' }), fixed(J1)],
        [J2, job(J2, { canonical_finding_id: 'F2' }), fixed(J2)],
      ),
    });
    expect(out.error).toBeUndefined();
    expect(out.calls).not.toContain('"sibling","F1"');
    expect(out.calls).toContain('"sibling","F2"');
  });

  it('keeps the run open when the inbox read fails with an I/O error', async () => {
    const out = await runTs({
      item: item({}, { jobs: [J1] }),
      files: { [`repair/${J1}/result.json`]: fixed(J1) }, // inbox file absent: readFile fails
    });
    expect(out.error).toBe('other');
    expect(out.queue).not.toContain('"state":"failed"');
    expect(out.calls).not.toContain('["mark"');
  });

  it('records a sibling FAILED outcome even with retry_after set (as Python does)', async () => {
    const out = await same({
      item: item({}, { jobs: [J1, J2] }),
      files: files(
        [J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1, { repair_base: 'wrong' })],
        [J2, job(J2, { canonical_finding_id: 'F2' }), verdict(J2, 'FAILED', { retry_after: 'T' })],
      ),
    });
    expect(out.calls).toContain('"mark","crq-R-F2"');
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

  it('reconciles terminal records on a dry harvest too (as Python does, unguarded)', async () => {
    for (const state of ['done', 'failed']) {
      const receipt = await same({ item: item({ kind: 'merged-current' }, { state }), dry: true });
      expect(receipt.queue).toContain('"repair_outcome"');
      const open = await same({ item: item({}, { state }), dry: true });
      expect(open.queue).toContain(state === 'failed' ? '"repair_failed"' : '"state":"done"');
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

// Repeated harvest/terminal replay around a rejected inbox. The port terminalizes a
// malformed or swapped inbox (Python raises, or - for a swapped one - writes from
// it), so only the ticks where both sides can run are compared with `same`; the
// ticks where the difference is deliberate run each side and pin the boundary.
describe('repairHarvest rejected-inbox replay across ticks (Python vs port)', () => {
  const calls = (o: Outcome): string[][] => JSON.parse(o.calls) as string[][];
  const names = (o: Outcome): string[] => calls(o).map((c) => c[0] as string);
  const carry = (o: Outcome): Record<string, unknown> =>
    JSON.parse(o.queue) as Record<string, unknown>;
  const marksOf = (o: Outcome): string[][] => calls(o).filter((c) => c[0] === 'mark');
  const both = item({}, { jobs: [J1, J2] });
  const valid1 = [J1, job(J1, { canonical_finding_id: 'F1' }), verdict(J1, 'NOT-FIXED')] as [
    string,
    unknown,
    unknown,
  ];
  const swapped2 = (result: unknown): [string, unknown, unknown] => [
    J2,
    job(J2, { job: 'crq-other', canonical_finding_id: 'FSWAP' }),
    result,
  ];
  const malformed2: [string, unknown, unknown] = [J2, '{not json', verdict(J2, 'NOT-FIXED')];

  it('first tick: Python writes from a swapped inbox, the port rejects it after the earlier sibling', async () => {
    const spec: Spec = {
      item: both,
      files: files(valid1, swapped2(verdict(J2, 'NOT-FIXED'))),
    };
    const py = runPython(spec);
    // Python trusts the swapped file: it writes an outcome under the foreign job id.
    expect(py.calls).toContain('"mark","crq-other"');
    const ts = await runTs(spec);
    expect(ts.error).toBeUndefined();
    // J1's own outcome, the terminal save, then the idempotent sibling replay of J1.
    expect(names(ts)).toEqual(['canonical', 'mark', 'save_queue', 'mark']);
    expect(ts.calls).not.toContain('crq-other');
    expect(ts.calls).not.toContain('FSWAP');
    expect(JSON.stringify(calls(ts)).includes(`"mark","${J2}"`)).toBe(false);
    // The earlier valid outcome is written twice with the same payload (idempotent).
    expect(marksOf(ts)).toHaveLength(2);
    expect(marksOf(ts)[1]).toEqual(marksOf(ts)[0]);
    expect(carry(ts)).toMatchObject({ state: 'repair_failed' });
  });

  it('keeps a FIXED earlier sibling on one needs-human decision across repeated replays', async () => {
    const files1 = files(
      [J1, job(J1, { canonical_finding_id: 'F1' }), fixed(J1)],
      swapped2(fixed(J2)),
    );
    const first = await runTs({ item: both, files: files1 });
    expect(first.error).toBeUndefined();
    expect(names(first)).toEqual([
      'canonical',
      'make_worktree',
      'verify',
      'mechanical',
      'remove_worktree',
      'mark',
      'save_queue',
      'sibling',
    ]);
    const replay = await runTs({ item: carry(first), files: files1 });
    expect(replay.error).toBeUndefined();
    expect(replay.queue).toBe(first.queue);
    expect(names(replay)).toEqual(['sibling']);
    expect(replay.calls).toContain('"sibling","F1","crq-R-F1"');
    expect(replay.calls).not.toContain('FSWAP');
    expect(calls(replay)[0]).toEqual(calls(first)[7]);
    const third = await runTs({ item: carry(replay), files: files1 });
    expect(third.queue).toBe(first.queue);
    expect(third.calls).toBe(replay.calls);
  });

  it('replays a malformed rejected inbox identically in Python and the port, tick after tick', async () => {
    const files1 = files(valid1, malformed2);
    const first = await runTs({ item: both, files: files1 });
    expect(first.error).toBeUndefined();
    expect(names(first)).toEqual(['canonical', 'mark', 'save_queue', 'mark']);
    // From here Python can run: its replay skips the rejected verdict (reason is not
    // "invalid repair result: ") and its sibling replay skips the unreadable inbox.
    const second = await same({ item: carry(first), files: files1, cleanup: true });
    expect(second.error).toBeUndefined();
    expect(second.queue).toBe(first.queue);
    expect(marksOf(second)).toHaveLength(1);
    expect(marksOf(second)[0]).toEqual(marksOf(first)[0]);
    // Cleanup runs for both retained verdicts; the real cleanup refuses the rejected one.
    expect(names(second)).toEqual(['mark', 'cleanup', 'cleanup', 'cleanup', 'cleanup']);
    const third = await same({ item: carry(second), files: files1, cleanup: true });
    expect(third.queue).toBe(first.queue);
    expect(third.calls).toBe(second.calls);
  });

  it('earns no cleanup credit: the real cleanup_harvested leaves a rejected verdict alone', async () => {
    const first = await runTs({ item: both, files: files(valid1, malformed2) });
    const verdicts = (carry(first) as { repair_runs: { R: { verdicts: unknown[] } } }).repair_runs.R
      .verdicts;
    const rejected = verdicts[1];
    expect(rejected).toMatchObject({ verdict: 'FAILED', finding: null });
    const out = execFileSync(
      'python3',
      [
        '-I',
        '-c',
        [
          'import sys, json',
          'sys.path.insert(0, sys.argv[1])',
          'import crq_repair.retain as r',
          "print(json.dumps(r.cleanup_harvested(sys.argv[3], sys.argv[3], sys.argv[3], 'i1', 'crq-R-F2', json.loads(sys.argv[2]))))",
        ].join('\n'),
        PYTHON_DIR,
        JSON.stringify(rejected),
        tmpdir(),
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(out)).toBe(false); // only FIXED and NOT-FIXED results can be cleaned
  });

  // Python's terminal replay does not recognise the port's "invalid repair inbox:"
  // reason, so it falls through to the sibling replay and trusts the swapped file.
  it('replay: Python derives a decision from a swapped inbox, the port never does (deliberate)', async () => {
    const first = await runTs({
      item: both,
      files: files(valid1, swapped2(verdict(J2, 'NOT-FIXED'))),
    });
    const spec: Spec = {
      item: carry(first),
      files: files(valid1, swapped2(fixed(J2))),
    };
    const py = runPython(spec);
    expect(py.error).toBeUndefined();
    expect(py.queue).toBe(first.queue);
    expect(py.calls).toContain('"sibling","FSWAP","crq-R-F2"');
    const ts = await runTs(spec);
    expect(ts.error).toBeUndefined();
    expect(ts.queue).toBe(first.queue);
    expect(names(ts)).toEqual(['mark']);
    expect(marksOf(ts)[0]).toEqual(marksOf(first)[0]);
    expect(ts.calls).not.toContain('FSWAP');
    expect(ts.calls).not.toContain('"sibling"');
    // And a dry replay does nothing on either side.
    const dry: Spec = { ...spec, dry: true };
    expect(runPython(dry).calls).toBe('[]');
    expect((await runTs(dry)).calls).toBe('[]');
  });

  // A later repair of the inbox does not revive the rejected run: the failure is
  // terminal. Python would, on its sibling replay, record the decision it was never
  // able to before; the port keeps a rejected job out of every later replay.
  it('later repair: a corrected inbox neither revives the run nor earns a late finding write', async () => {
    const first = await runTs({ item: both, files: files(valid1, malformed2) });
    const repaired = files(valid1, [
      J2,
      job(J2, { canonical_finding_id: 'F2' }),
      verdict(J2, 'NOT-FIXED'),
    ]);
    const spec: Spec = { item: carry(first), files: repaired };
    const py = runPython(spec);
    expect(py.error).toBeUndefined();
    expect(py.queue).toBe(first.queue);
    expect(py.calls).toContain('"mark","crq-R-F2"'); // Python's late sibling write
    const ts = await runTs(spec);
    expect(ts.error).toBeUndefined();
    expect(ts.queue).toBe(first.queue);
    expect(names(ts)).toEqual(['mark']);
    expect(ts.calls).not.toContain('crq-R-F2');
    expect(ts.calls).not.toContain('"canonical"');
  });

  it('transient recovery: a missing inbox retries, then harvests with the earlier outcome replayed once per tick', async () => {
    const first = await same({
      item: both,
      files: { ...files(valid1), [`repair/${J2}/result.json`]: verdict(J2, 'NOT-FIXED') },
    });
    expect(first.error).toBe('other');
    expect(first.queue).toContain('"state":"queued"');
    expect(names(first)).toEqual(['canonical', 'mark']);
    const valid2 = [J2, job(J2, { canonical_finding_id: 'F2' }), verdict(J2, 'NOT-FIXED')] as [
      string,
      unknown,
      unknown,
    ];
    const recovered = await same({ item: carry(first), files: files(valid1, valid2) });
    expect(recovered.error).toBeUndefined();
    expect(recovered.queue).toContain('"state":"done"');
    expect(names(recovered)).toEqual(['canonical', 'mark', 'canonical', 'mark']);
    expect(marksOf(recovered)[0]).toEqual(marksOf(first)[0]);
    const settled = await same({ item: carry(recovered), files: files(valid1, valid2) });
    expect(settled.queue).toBe(recovered.queue);
    expect(settled.calls).toBe('[]');
  });

  it('transient then malformed: the port terminalizes once, replays the earlier outcome, and stays rejected', async () => {
    const transient = await same({
      item: both,
      files: {
        [`repair/inbox/${J2}.json/x`]: '{}',
        ...files(valid1),
        [`repair/${J2}/result.json`]: verdict(J2, 'NOT-FIXED'),
      },
    });
    expect(transient.error).toBe('other');
    const spec: Spec = { item: carry(transient), files: files(valid1, malformed2) };
    expect(runPython(spec).error).toBeDefined(); // Python raises on every tick
    const rejected = await runTs(spec);
    expect(rejected.error).toBeUndefined();
    expect(names(rejected)).toEqual(['canonical', 'mark', 'save_queue', 'mark']);
    for (const m of marksOf(rejected)) expect(m).toEqual(marksOf(transient)[0]);
    expect(rejected.calls).not.toContain(J2 + '","');
    // The inbox is then repaired: the failed run is not re-harvested.
    const healed = await runTs({
      item: carry(rejected),
      files: files(valid1, [J2, job(J2, { canonical_finding_id: 'F2' }), verdict(J2, 'NOT-FIXED')]),
    });
    expect(healed.queue).toBe(rejected.queue);
    expect(names(healed)).toEqual(['mark']);
    expect(healed.calls).not.toContain('F2');
  });

  it('later run: a rejected run stays inert while the next run harvests, and replays settle', async () => {
    const twoRuns = item({}, { jobs: [J1] }) as { repair_runs: Record<string, unknown> };
    twoRuns.repair_runs.R2 = { state: 'queued', base: 'b0', jobs: [J2] };
    const rejectedFiles = files(
      [J1, '{not json', verdict(J1, 'NOT-FIXED')],
      [J2, job(J2, { canonical_finding_id: 'F2' })],
    );
    const first = await runTs({ item: twoRuns, files: rejectedFiles }); // R2 has no result yet
    expect(first.error).toBeUndefined();
    expect(names(first)).toEqual(['save_queue']);
    const harvestFiles = {
      ...rejectedFiles,
      [`repair/${J2}/result.json`]: verdict(J2, 'NOT-FIXED'),
    };
    const second = await same({ item: carry(first), files: harvestFiles });
    expect(second.error).toBeUndefined();
    expect(names(second)).toEqual(['canonical', 'mark']);
    expect(second.calls).toContain('"mark","crq-R-F2"');
    expect(second.calls).not.toContain('crq-R-F1');
    const third = await same({ item: carry(second), files: harvestFiles });
    expect(third.queue).toBe(second.queue);
    expect(third.calls).toBe('[]');
  });
});

// Sibling retry timing. A `retry_after` result is a wait only while its run is open
// (harvest `break`s before any decision); once the run is terminal, the sibling
// replay (`record_unpublished_siblings`) ignores `retry_after` and records the
// sibling's FAILED verdict like any other. Both sides run every tick below, so
// the shared policy is pinned by `same`, and the tests assert that no tick writes
// a second, different decision for a job whose result did not change.
describe('repairHarvest sibling retry timing across ticks (Python vs port)', () => {
  const calls = (o: Outcome): string[][] => JSON.parse(o.calls) as string[][];
  const names = (o: Outcome): string[] => calls(o).map((c) => c[0] as string);
  const carry = (o: Outcome): Record<string, unknown> =>
    JSON.parse(o.queue) as Record<string, unknown>;
  const marksOf = (o: Outcome, id: string): string[][] =>
    calls(o).filter((c) => c[0] === 'mark' && c[1] === id);
  const both = item({}, { jobs: [J1, J2] });
  const inbox1 = job(J1, { canonical_finding_id: 'F1' });
  const inbox2 = job(J2, { canonical_finding_id: 'F2' });
  const waiting = verdict(J2, 'FAILED', { retry_after: '2026-11-21T00:00:00Z' });

  it('active run: a retry_after sibling is waited on, recording nothing for it', async () => {
    const out = await same({
      item: both,
      files: files([J1, inbox1, verdict(J1, 'NOT-FIXED')], [J2, inbox2, waiting]),
    });
    expect(out.error).toBeUndefined();
    expect(out.queue).toContain('"state":"queued"');
    // The waiting job's delivery is checked (as Python does) before its retry_after stops the loop.
    expect(names(out)).toEqual(['canonical', 'mark', 'canonical']);
    expect(marksOf(out, J1)).toHaveLength(1);
    expect(marksOf(out, J2)).toHaveLength(0);
    expect(out.calls).not.toContain('"sibling"');
  });

  it('active run: the earlier outcome is replayed each tick, the waiting sibling is recorded once its retry clears', async () => {
    const first = await same({
      item: both,
      files: files([J1, inbox1, verdict(J1, 'NOT-FIXED')], [J2, inbox2, waiting]),
    });
    // Still waiting on the next tick: an identical replay of J1 only, queue unchanged.
    const stillWaiting = await same({
      item: carry(first),
      files: files([J1, inbox1, verdict(J1, 'NOT-FIXED')], [J2, inbox2, waiting]),
    });
    expect(stillWaiting.queue).toBe(first.queue);
    expect(stillWaiting.calls).toBe(first.calls);
    // The retry finished: J2's result no longer carries retry_after.
    const cleared = [J2, inbox2, verdict(J2, 'FAILED', { reason: 'retry exhausted' })] as [
      string,
      unknown,
      unknown,
    ];
    const recovered = await same({
      item: carry(stillWaiting),
      files: files([J1, inbox1, verdict(J1, 'NOT-FIXED')], cleared),
    });
    expect(recovered.error).toBeUndefined();
    expect(marksOf(recovered, J1)[0]).toEqual(marksOf(first, J1)[0]);
    expect(marksOf(recovered, J2)).toHaveLength(1);
    expect(marksOf(recovered, J2)[0]?.[2]).not.toContain('retry_after');
    expect(recovered.calls).not.toContain('"sibling"');
  });

  it('active run: a falsy retry_after is not a wait, so the sibling FAILED is recorded', async () => {
    for (const falsy of [0, '', null, false, [], {}]) {
      const out = await same({
        item: both,
        files: files(
          [J1, inbox1, verdict(J1, 'NOT-FIXED')],
          [J2, inbox2, verdict(J2, 'FAILED', { retry_after: falsy })],
        ),
      });
      expect(marksOf(out, J2)).toHaveLength(1);
    }
  });

  // The owning run died on J1, so J2's retry can no longer publish: the terminal
  // path records J2's FAILED verdict (retry_after and all) once, and every later
  // replay writes the identical payload with no second kind of decision.
  describe('terminal run', () => {
    const dead = [J1, inbox1, fixed(J1, { repair_base: 'wrong' })] as [string, unknown, unknown];

    it('first tick: the sibling FAILED is recorded with its retry_after payload', async () => {
      const out = await same({ item: both, files: files(dead, [J2, inbox2, waiting]) });
      expect(out.error).toBeUndefined();
      expect(out.queue).toContain('"state":"failed"');
      expect(names(out)).toEqual(['canonical', 'save_queue', 'mark', 'mark']);
      expect(marksOf(out, J1)).toHaveLength(1);
      expect(marksOf(out, J2)).toHaveLength(1);
      expect(marksOf(out, J2)[0]?.[2]).toContain('retry_after');
      expect(out.calls).not.toContain('"sibling"');
    });

    it('replays on later ticks write the same two payloads, never a duplicate kind', async () => {
      const f = files(dead, [J2, inbox2, waiting]);
      const first = await same({ item: both, files: f });
      const replay = await same({ item: carry(first), files: f });
      expect(replay.error).toBeUndefined();
      expect(replay.queue).toBe(first.queue);
      // Replay order: the terminal save, the retained invalid-result outcome, then the sibling.
      expect(names(replay)).toEqual(['save_queue', 'mark', 'mark']);
      expect(marksOf(replay, J1)).toEqual(marksOf(first, J1));
      expect(marksOf(replay, J2)).toEqual(marksOf(first, J2));
      const third = await same({ item: carry(replay), files: f });
      expect(third.queue).toBe(replay.queue);
      expect(third.calls).toBe(replay.calls);
    });

    it('a dry replay records nothing for the sibling', async () => {
      const f = files(dead, [J2, inbox2, waiting]);
      const first = await same({ item: both, files: f });
      const dry = await same({ item: carry(first), files: f, dry: true });
      expect(dry.calls).toBe('[]');
    });

    // Shared policy: when the retry result is replaced after the run died, the next
    // replay records the sibling's new verdict, as Python's replay does. Pinned, not
    // changed here: it is the "late ledger write" boundary, owned elsewhere.
    it('a retry that finishes after the run died is replayed as the new verdict', async () => {
      const first = await same({ item: both, files: files(dead, [J2, inbox2, waiting]) });
      const later = verdict(J2, 'NOT-FIXED', { reason: 'retry settled' });
      const replay = await same({
        item: carry(first),
        files: files(dead, [J2, inbox2, later]),
      });
      expect(replay.error).toBeUndefined();
      expect(replay.queue).toBe(first.queue);
      expect(marksOf(replay, J1)).toEqual(marksOf(first, J1));
      expect(marksOf(replay, J2)).toHaveLength(1);
      expect(marksOf(replay, J2)[0]?.[2]).toContain('NOT-FIXED');
      expect(marksOf(replay, J2)[0]?.[2]).not.toContain('retry_after');
    });

    it('a retry_after FIXED sibling is the unpublished-FIXED decision, not a wait', async () => {
      const out = await same({
        item: both,
        files: files(dead, [J2, inbox2, fixed(J2, { retry_after: 60 })]),
      });
      expect(out.error).toBeUndefined();
      expect(out.calls).toContain('"sibling","F2","crq-R-F2","needs-human"');
      expect(marksOf(out, J2)).toHaveLength(0);
    });
  });
});

// The canonical-delivery check runs before the result file is read, so it also
// runs ahead of a `retry_after` wait. The passing check is pinned above; here the
// two failing checks decide what a waiting job does: a confirmed stale binding
// retires the run (nothing is waited on), an unreadable triage row only defers
// it (the run stays open and retryable). A malformed result file is the probe
// for ordering: had the result been read first it would be terminalized as an
// invalid result, which neither failing check does.
describe('repairHarvest canonical delivery check ahead of a retry_after wait (Python vs port)', () => {
  const calls = (o: Outcome): string[][] => JSON.parse(o.calls) as string[][];
  const names = (o: Outcome): string[] => calls(o).map((c) => c[0] as string);
  const carry = (o: Outcome): Record<string, unknown> =>
    JSON.parse(o.queue) as Record<string, unknown>;
  const runOf = (o: Outcome): Record<string, unknown> =>
    (JSON.parse(o.queue) as { repair_runs: { R: Record<string, unknown> } }).repair_runs.R;
  const inbox1 = job(J1, { canonical_finding_id: 'F1' });
  const inbox2 = job(J2, { canonical_finding_id: 'F2' });
  const waiting = (id: string) => verdict(id, 'FAILED', { retry_after: '2026-11-21T00:00:00Z' });
  const STALE = 'value:selection moved';
  const UNREADABLE = 'value:canonical delivery state unavailable';
  const results: Array<[string, unknown]> = [
    ['a waiting retry_after result', waiting(J1)],
    ['a malformed result file', '{not json'],
  ];

  describe.each(results)('with %s', (_label, result) => {
    it('stale binding: the run is retired, nothing is waited on or recorded', async () => {
      const spec: Spec = {
        item: item(),
        files: files([J1, inbox1, result]),
        stale: { [J1]: STALE },
      };
      const out = await same(spec);
      expect(out.error).toBeUndefined();
      expect(names(out)).toEqual(['canonical']);
      const run = runOf(out);
      expect(run.state).toBe('stale');
      expect(run.error).toBe('selection moved');
      expect(out.queue).toContain('"state":"done"'); // the item, no longer repairing
      expect(out.calls).not.toContain('"mark"');
      const dry = await same({ ...spec, dry: true });
      expect(names(dry)).toEqual(['canonical']);
      expect(runOf(dry).state).toBe('queued');
      expect(dry.queue).toContain('"state":"repairing"');
    });

    it('unreadable delivery: the run stays open and retryable, nothing is recorded', async () => {
      const spec: Spec = {
        item: item(),
        files: files([J1, inbox1, result]),
        stale: { [J1]: UNREADABLE },
      };
      const out = await same(spec);
      expect(out.error).toBeUndefined();
      expect(names(out)).toEqual(['canonical']);
      expect(runOf(out).state).toBe('queued');
      expect(runOf(out).error).toBeUndefined();
      expect(out.queue).toContain('"state":"repairing"');
      expect(out.calls).not.toContain('"mark"');
      // Another unreadable tick changes nothing, dry or not.
      const again = await same({ ...spec, item: carry(out) });
      expect(again.queue).toBe(out.queue);
      expect(again.calls).toBe(out.calls);
      const dry = await same({ ...spec, dry: true });
      expect(dry.queue).toBe(out.queue);
    });
  });

  it('unreadable delivery then readable: the retry_after wait resumes unchanged', async () => {
    const f = files([J1, inbox1, waiting(J1)]);
    const deferred = await same({ item: item(), files: f, stale: { [J1]: UNREADABLE } });
    const waited = await same({ item: carry(deferred), files: f });
    expect(waited.error).toBeUndefined();
    expect(names(waited)).toEqual(['canonical']);
    expect(waited.queue).toBe(deferred.queue);
    expect(waited.calls).not.toContain('"mark"');
    // The retry settles on a later tick: the verdict is recorded and the run ends.
    const settled = await same({
      item: carry(waited),
      files: files([J1, inbox1, verdict(J1, 'NOT-FIXED')]),
    });
    expect(settled.calls).toContain('"mark","crq-R-F1"');
  });

  describe('behind an earlier job that recorded its own outcome', () => {
    const f = files([J1, inbox1, verdict(J1, 'NOT-FIXED')], [J2, inbox2, waiting(J2)]);
    const both = item({}, { jobs: [J1, J2] });

    it('stale binding on the waiting job retires the run after the earlier mark', async () => {
      const out = await same({ item: both, files: f, stale: { [J2]: STALE } });
      expect(out.error).toBeUndefined();
      expect(names(out)).toEqual(['canonical', 'mark', 'canonical']);
      expect(runOf(out).state).toBe('stale');
      expect(out.calls).not.toContain('"mark","crq-R-F2"');
    });

    it('unreadable delivery on the waiting job keeps the run open; the earlier mark replays', async () => {
      const first = await same({ item: both, files: f, stale: { [J2]: UNREADABLE } });
      expect(first.error).toBeUndefined();
      expect(names(first)).toEqual(['canonical', 'mark', 'canonical']);
      expect(runOf(first).state).toBe('queued');
      const replay = await same({ item: carry(first), files: f, stale: { [J2]: UNREADABLE } });
      expect(replay.queue).toBe(first.queue);
      expect(replay.calls).toBe(first.calls);
      expect(replay.calls).not.toContain('"mark","crq-R-F2"');
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

  it('resolves components in filesystem order, like Path.resolve (a ".." after a symlink)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-hv-fs-'));
    dirs.push(root);
    mkdirSync(join(root, 'real', 'nested', 'deep'), { recursive: true });
    writeFileSync(join(root, 'real', 'f'), 'x');
    symlinkSync('real/nested', join(root, 'link'));
    symlinkSync(join(root, 'real'), join(root, 'abs'));
    symlinkSync('../real/nested', join(root, 'real', 'up'));
    symlinkSync('loop2', join(root, 'loop1'));
    symlinkSync('loop1', join(root, 'loop2'));
    symlinkSync('missing/..', join(root, 'dangling'));
    const cases = [
      'link/..',
      'link/../nested',
      'link/deep/../..',
      'link/../../real',
      'abs/nested/..',
      'abs/../real',
      'real/up/deep',
      'real/up/..',
      'link/missing/..',
      'link/missing/../deep',
      'missing/../real',
      'real/f/x',
      'real/f/..',
      'real/f/../nested',
      'loop1',
      'loop1/x',
      'loop1/..',
      'dangling',
      'dangling/x',
      'real/./nested//deep/',
      '',
    ].map((rel) => `${root}/${rel}`); // not join(): it would collapse the `..` lexically
    cases.push('/', '/..', '/../..', '.', './real/../real', '..');
    const reads = fileRepairHarvestReads({ stateRoot: root, worktreeRoot: root });
    const ts: string[] = [];
    for (const path of cases) ts.push(await reads.resolvePath(path));
    const py = JSON.parse(
      execFileSync(
        'python3',
        [
          '-I',
          '-c',
          'import sys,json,pathlib;print(json.dumps([str(pathlib.Path(p).resolve()) for p in json.loads(sys.argv[1])]))',
          JSON.stringify(cases),
        ],
        { encoding: 'utf8' },
      ),
    ) as string[];
    expect(ts).toEqual(py);
    // The case the lexical shortcut got wrong: `..` leaves the symlink's target.
    expect(ts[0]).toBe(join(await reads.resolvePath(root), 'real'));
  });

  it('reports an unreadable result as absent, like Path.exists on 3.14', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-hv-acc-'));
    dirs.push(root);
    const job = join(root, 'repair', 'crq-locked');
    mkdirSync(job, { recursive: true });
    writeFileSync(join(job, 'result.json'), '{}');
    const reads = fileRepairHarvestReads({ stateRoot: root, worktreeRoot: root });
    const pyExists = (): boolean =>
      execFileSync(
        'python3',
        [
          '-I',
          '-c',
          'import sys,pathlib;print(pathlib.Path(sys.argv[1]).exists())',
          join(job, 'result.json'),
        ],
        { encoding: 'utf8' },
      ).trim() === 'True';
    expect(await reads.resultExists('crq-locked')).toBe(true);
    expect(pyExists()).toBe(true);
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    chmodSync(job, 0o000);
    try {
      // `os.path.exists` swallows every OSError, so Python reports False, not a raise.
      expect(pyExists()).toBe(false);
      expect(await reads.resultExists('crq-locked')).toBe(false);
      // Reading the same file is a PermissionError, which the harvest does see.
      await expect(reads.readResult('crq-locked')).rejects.toMatchObject({ kind: 'OSError' });
    } finally {
      chmodSync(job, 0o755);
    }
  });
});

// CPython caps `int(str)` at `sys.get_int_max_str_digits()` (default 4300, 3.11+), and
// `json.loads` converts every bare integer literal with `int()`. `repairStateSource`
// already refuses an oversized literal; `readJson` in `repairHarvestReads` parses
// integers losslessly and has no such guard (#2312 residual). The first block pins
// that gap as it stands; the controls are the same documents Python accepts.
describe('repairHarvest JSON integer digit limit (Python vs port)', () => {
  const DIGITS = '1'.repeat(4300);
  const OVER = '1'.repeat(4301);

  /** `json.loads(path.read_text())` outcome, plus the interpreter's own limit. */
  function pyLoads(path: string): { limit: number; outcome: string } {
    const script = [
      'import sys, json, pathlib',
      'try:',
      '    json.loads(pathlib.Path(sys.argv[1]).read_text()); outcome = "ok"',
      'except Exception as e:',
      '    outcome = type(e).__name__',
      'print(json.dumps({"limit": sys.get_int_max_str_digits(), "outcome": outcome}))',
    ].join('\n');
    return JSON.parse(
      execFileSync('python3', ['-I', '-c', script, path], { encoding: 'utf8' }),
    ) as { limit: number; outcome: string };
  }

  /** The same bytes through Python's `json.loads` and the port's inbox and result reads. */
  async function readBoth(literal: string): Promise<{
    py: { limit: number; outcome: string };
    job: PyError | 'ok';
    result: PyError | 'ok';
  }> {
    const root = mkdtempSync(join(tmpdir(), 'repair-hv-digits-'));
    dirs.push(root);
    mkdirSync(join(root, 'repair', 'inbox'), { recursive: true });
    mkdirSync(join(root, 'repair', J1), { recursive: true });
    const body = `{"job":"${J1}","weight":${literal}}`;
    const inbox = join(root, 'repair', 'inbox', `${J1}.json`);
    writeFileSync(inbox, body);
    writeFileSync(join(root, 'repair', J1, 'result.json'), body);
    const reads = fileRepairHarvestReads({ stateRoot: root, worktreeRoot: root });
    const settle = (read: Promise<unknown>): Promise<PyError | 'ok'> =>
      read.then(
        () => 'ok' as const,
        (e: unknown) => {
          if (e instanceof PyError) return e;
          throw e;
        },
      );
    return {
      py: pyLoads(inbox),
      job: await settle(reads.readJob(J1)),
      result: await settle(reads.readResult(J1)),
    };
  }

  describe('Python and the port agree', () => {
    const CONTROLS: Array<[string, string]> = [
      ['4300 digits (the limit itself)', DIGITS],
      ['4300 digits with a minus sign (the sign is not counted)', `-${DIGITS}`],
      ['4301 digits written as a float with a fraction', `${OVER}.0`],
      ['4301 digits written with an exponent', `${OVER}e0`],
      ['a negative float over the limit', `-${OVER}.5`],
    ];
    for (const [name, literal] of CONTROLS) {
      it(`reads ${name}`, async () => {
        const out = await readBoth(literal);
        expect(out.py).toEqual({ limit: 4300, outcome: 'ok' });
        expect(out.job).toBe('ok');
        expect(out.result).toBe('ok');
      });
    }

    it('reads a 4301-digit run inside a string', async () => {
      const out = await readBoth(`"${OVER}"`);
      expect(out.py).toEqual({ limit: 4300, outcome: 'ok' });
      expect(out.job).toBe('ok');
      expect(out.result).toBe('ok');
    });

    it('still refuses a malformed document at the same boundary', async () => {
      // The oracle is not simply accepting everything: a bare sign is an error on both sides.
      const out = await readBoth('-');
      expect(out.py.outcome).toBe('JSONDecodeError');
      expect(out.job).toMatchObject({ kind: 'ValueError' });
      expect(out.result).toMatchObject({ kind: 'ValueError' });
    });
  });

  // RESIDUAL (#2312): Python raises ValueError ("Exceeds the limit (4300 digits) for
  // integer string conversion"); the port parses the literal as a bigint and returns it.
  // When `readJson` gains the guard, flip these to `toMatchObject({ kind: 'ValueError' })`
  // and move the 4301 cases into the agreement block above. That brings the READER into
  // agreement only: the harvest-level RESIDUAL below does not become a parity case, because
  // the port then terminalizes the inbox (`invalid repair inbox: Exceeds the limit ...`,
  // `repair_failed`) where Python raises and leaves the run queued. That is #2312's
  // terminalization-vs-raise difference, pinned in 'malformed inbox content'.
  describe('Python refuses, the port still reads (residual)', () => {
    for (const [name, literal] of [
      ['4301 digits', OVER],
      ['4301 digits with a minus sign', `-${OVER}`],
    ] as const) {
      it(`${name}: ValueError in Python, accepted by readJob and readResult`, async () => {
        const out = await readBoth(literal);
        expect(out.py).toEqual({ limit: 4300, outcome: 'ValueError' });
        expect(out.job).toBe('ok');
        expect(out.result).toBe('ok');
      });
    }
  });

  describe('through the harvest inbox', () => {
    const inboxWith = (literal: string): string =>
      `{"job":"${J1}","item":"i1","finding":{"id":"f-${J1}"},"canonical_finding_id":"F1","weight":${literal}}`;
    const specWith = (literal: string): Spec => ({
      item: item({}, { jobs: [J1] }),
      files: files([J1, inboxWith(literal), verdict(J1, 'NOT-FIXED')]),
    });

    it('harvests identically at 4300 digits', async () => {
      const out = await same(specWith(DIGITS));
      expect(out.error).toBeUndefined();
      expect(out.queue).toContain('"state":"done"');
      expect(out.calls).toContain('"mark","crq-R-F1"');
    });

    it('harvests identically for a 4301-digit float', async () => {
      const out = await same(specWith(`${OVER}.0`));
      expect(out.error).toBeUndefined();
      expect(out.queue).toContain('"state":"done"');
    });

    it('RESIDUAL: 4301 digits raise ValueError in Python but harvest in the port', async () => {
      const spec = specWith(OVER);
      const py = runPython(spec);
      // Uncaught: the run stays open, nothing is terminalized and no outcome is written.
      // With the reader guard this case flips to the #2312 terminalization difference, not to parity.
      expect(py.error).toBe('ValueError');
      expect(py.queue).toContain('"state":"queued"');
      expect(py.calls).not.toContain('"mark"');
      const ts = await runTs(spec);
      expect(ts.error).toBeUndefined();
      expect(ts.queue).toContain('"state":"done"');
      expect(ts.calls).toContain('"mark","crq-R-F1"');
    });
  });
});
