// Seeded composed offline shadow of the S6 repair-harvest path: the TypeScript
// `repairHarvest` driving `publishRepair`, `finalizePublication`,
// `publicationNewItem` and `decideRepairCleanup` through its two effect seams
// (`publish` and `cleanupHarvested`), against Python's real
// `repair_tick.harvest` driving the real `publish`, `recover_publication`,
// `finalize_publication`, `crq.new_item` and `crq_repair.retain.cleanup_harvested`
// (apps/crq-python) via test/helpers/repairHarvestShadowOracle.py.
//
// Each scenario is a fixed synthetic queue plus files, replayed over several
// ticks with restarts between them. A restart is an in-memory queue JSON round
// trip and a fresh `FixPrBacklog` in the same process; it does not re-read
// `state/queue.json`. The world persists, and what recovery reads back from disk
// is the publication journal (`state/repair/<job>/publication.json`) plus the
// result, inbox and snapshot files. Per tick the queue and the journal/patch/
// body/queue files are snapshotted and compared as JSON text; the ordered effect
// log and the in-memory removal set are compared once over the whole run, and the
// first diverging effect is named.
//
// Offline and non-destructive by construction. Git, `gh`, the forge, the
// provider, the finding ledger and the worktree removal are all scripted in
// memory on BOTH sides: a push moves a ref in a dict, a PR create appends a
// row, and `git worktree remove` is only recorded and added to a removed set
// that the directory probe consults. No directory is ever deleted; the only
// disk is a throwaway tree: the inputs the layout writes (state, result, inbox
// and retained-snapshot files, empty worktree directories) and the journal/
// patch/body/queue files the real writers produce there. Nothing is bound into `tick` or the runtime, nothing
// is pushed, and nothing leaves the process.
//
// A second family of scenarios (the "durable restart" describe at the end) makes
// every restart a real process boundary instead. Python runs one separate
// `python3` process per segment; each reloads `state/queue.json` with the real
// `crq.load_queue` and the in-memory world from `world.json`, a scratch file
// outside `state/`. The TypeScript side runs each segment through `runTs` with
// a fresh effects world, backlog and reads built only from disk: the queue
// comes back through `loadQueueDocument` and the world from `world.json`, and
// nothing is carried in memory between segments. (The vitest process is shared,
// so this is isolation by construction, not a separate OS process.) A tick's
// `save_fail` makes its N-th queue save fail before writing. A durable tick
// also does what `crq.tick` does around `harvest`: an exception becomes
// `last_error` and the queue is saved at the end of the tick; a tick's `crash`
// is the process dying right after harvest, so neither happens.
//
// Out of scope here, pinned elsewhere: the fix-PR backlog accounting
// (publicationBacklog.test.ts), the individual policy edges of harvest
// (repairHarvest.test.ts), of cleanup (repairCleanup.test.ts) and of enrollment
// (publicationEnroll.test.ts). The scenarios here are the cross-component ones.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { filePublicationEffects } from '../../src/adapters/crq/publicationFiles.js';
import { loadQueueDocument } from '../../src/adapters/crq/queueEffects.js';
import { fileRepairHarvestReads } from '../../src/adapters/crq/repairHarvestReads.js';
import { toPlainJson } from '../../src/policy/crq/jsonValue.js';
import { receiptJsonDigest } from '../../src/policy/crq/pythonJson.js';
import { FixPrBacklog } from '../../src/queue-runner/fixPrBacklog.js';
import {
  finalizePublication,
  type PublicationFinalizeEffects,
} from '../../src/queue-runner/publicationFinalize.js';
import { publicationNewItem } from '../../src/queue-runner/publicationEnroll.js';
import {
  publishRepair,
  type PublicationPublishEffects,
} from '../../src/queue-runner/publicationPublish.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import type { Item, Queue } from '../../src/queue-runner/repairBackfill.js';
import {
  decideRepairCleanup,
  RETAINED_ARCHIVES,
  type RepairCleanupProbes,
  type RetentionRecord,
} from '../../src/queue-runner/repairCleanup.js';
import { repairHarvest, type RepairHarvestEffects } from '../../src/queue-runner/repairHarvest.js';

const ORACLE = fileURLToPath(new URL('../helpers/repairHarvestShadowOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));

type Rec = Record<string, unknown>;
type Entry = unknown[];
type Mode = 'ok' | 'runtime' | 'timeout-landed' | 'timeout-lost';

const SHA1 = 'a'.repeat(40);
const BASE = 'b0';
const J1 = 'crq-R-F1';
const J2 = 'crq-R-F2';
const ITEM = 'pr7';
const tree = (job: string, suffix = ''): string => `crq-repair-${ITEM}-${job}${suffix}`;

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

interface Tick {
  restart?: boolean;
  dry?: boolean;
  /** Files under `state/` written before the tick (an object is JSON, a string is raw). */
  files?: Record<string, unknown>;
  create?: Mode;
  push_fail?: boolean;
  /** job -> `kind:message` raise from `require_canonical_delivery`. */
  stale?: Record<string, string>;
  /** job -> `kind:message` raise from `mark_finding_outcome`. */
  outcome?: Record<string, string>;
  /** `git rev-parse HEAD` in a cleanup tree fails with this message. */
  head_error?: string;
  /** The N-th (1-based) queue save of this tick raises OSError before writing. */
  save_fail?: number;
  /** Durable runs: the process dies right after harvest, so no `last_error` and no tick-end save. */
  crash?: boolean;
}

/** One process of a durable run: the ticks it runs and where they sit in the whole run. */
interface Segment {
  root: string;
  spec: Spec;
  ticks: Tick[];
  offset: number;
}

interface Retained {
  job: string;
  head: string;
  base: string;
}

interface Spec {
  item: Rec;
  extra?: Rec[];
  files: Record<string, unknown>;
  /** Worktree directories under WT_ROOT: name -> scripted head and `git status` text. */
  trees: Record<string, { head: string; status: string }>;
  retained?: Retained[];
  remote?: Record<string, string>;
  prs?: Record<string, unknown[]>;
  pr_info?: Rec | null;
  ancestor?: boolean;
  ticks: Tick[];
}

interface Outcome {
  log: Entry[];
  ticks: { messages?: string[]; error?: string; queue: Rec; files: Record<string, string> }[];
  files: Record<string, string>;
  removed: string[];
}

// --- the synthetic world ----------------------------------------------------

const STUB_REPAIR = `import builtins
def mechanical(config, wt, predecessor, commits, job_id, directory):
    builtins.SHADOW_LOG.append(['mechanical', wt.name, predecessor, list(commits), job_id, directory.name])
`;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** One `retained-<token>/` snapshot written the way `retain()` does. */
function writeRetained(root: string, r: Retained, index: number): void {
  const contents = Object.fromEntries(
    RETAINED_ARCHIVES.map((name) => [name, `${name}:${String(index)}\n`]),
  );
  const manifest = {
    base: r.base,
    head: r.head,
    commits: [] as string[],
    untracked: [] as string[],
    sha256: Object.fromEntries(Object.entries(contents).map(([k, v]) => [k, sha(v)])),
  };
  const target = join(
    root,
    'state',
    'repair',
    r.job,
    'final',
    `retained-${receiptJsonDigest(manifest as unknown as never)}`,
  );
  mkdirSync(target, { recursive: true });
  for (const [name, body] of Object.entries(contents)) writeFileSync(join(target, name), body);
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest));
}

function putFile(state: string, rel: string, doc: unknown): void {
  const path = join(state, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc));
}

/** The spec with `{WT}` bound to this side's worktree root. */
function materialize(spec: Spec, root: string): Spec {
  return JSON.parse(JSON.stringify(spec).replaceAll('{WT}', join(root, 'wt'))) as Spec;
}

/** Lay out one side's throwaway tree. Both sides get byte-identical state. */
function layout(spec: Spec, durable = false): { root: string; spec: Spec } {
  const root = mkdtempSync(join(tmpdir(), 'repair-shadow-'));
  cleanups.push(root);
  const bound = materialize(spec, root);
  mkdirSync(join(root, 'wt'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'crq_repair.py'), STUB_REPAIR);
  for (const [rel, doc] of Object.entries(bound.files)) putFile(join(root, 'state'), rel, doc);
  // A durable run starts from a queue on disk; both sides get these exact bytes.
  if (durable)
    putFile(join(root, 'state'), 'queue.json', { items: [bound.item, ...(bound.extra ?? [])] });
  for (const name of Object.keys(bound.trees))
    mkdirSync(join(root, 'wt', name), { recursive: true });
  for (const [index, r] of (bound.retained ?? []).entries()) writeRetained(root, r, index);
  return { root, spec: bound };
}

// --- the Python side --------------------------------------------------------

function runPython(spec: Spec): { out: Outcome; root: string } {
  const { root, spec: bound } = layout(spec);
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ root, spec: bound }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  return { out: JSON.parse(stdout) as Outcome, root };
}

/** One durable run: a separate `python3` process per segment, outcomes concatenated. */
function runPythonDurable(spec: Spec): { out: Outcome; root: string } {
  const { root, spec: bound } = layout(spec, true);
  const parts = segmentsOf(bound.ticks).map((segment) => {
    const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
      input: JSON.stringify({ root, spec: bound, segment }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    });
    return JSON.parse(stdout) as Outcome;
  });
  return { out: joinSegments(parts), root };
}

/** A `restart` tick starts the next process; the first segment starts at tick 0. */
function segmentsOf(ticks: Tick[]): { ticks: Tick[]; offset: number }[] {
  const segments: { ticks: Tick[]; offset: number }[] = [];
  for (const [index, tick] of ticks.entries()) {
    if (segments.length === 0 || tick.restart) segments.push({ ticks: [], offset: index });
    segments.at(-1)!.ticks.push(tick);
  }
  return segments;
}

/** The effect log and ticks concatenate; the files and removals are the last process's view. */
function joinSegments(parts: Outcome[]): Outcome {
  const last = parts.at(-1)!;
  return {
    log: parts.flatMap((p) => p.log),
    ticks: parts.flatMap((p) => p.ticks),
    files: last.files,
    removed: last.removed,
  };
}

// --- the TypeScript side ----------------------------------------------------

const NAMES: Record<string, PyError['kind']> = {
  value: 'ValueError',
  runtime: 'RuntimeError',
  os: 'OSError',
  key: 'KeyError',
  type: 'TypeError',
};

function raise(directive: string | undefined): void {
  if (!directive) return;
  const [kind, ...rest] = directive.split(':');
  const text = rest.join(':');
  throw new PyError(NAMES[kind as string] as PyError['kind'], kind === 'key' ? `'${text}'` : text);
}

/** Python's `family()` reports the exception class name; PyError carries it as `kind`. */
const familyOf = (e: unknown): string => (e instanceof PyError ? e.kind : (e as Error).name);

interface PrRow extends Rec {
  number: number;
  url: string;
  state: string;
  headRefOid: string;
}

function walkRetained(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let walk = false;
    try {
      walk = !lstatSync(path).isSymbolicLink() && statSync(path).isDirectory();
    } catch {
      walk = false;
    }
    if (!walk) continue;
    if (entry.startsWith('retained-')) {
      try {
        statSync(join(path, 'manifest.json'));
        out.push(path);
      } catch {
        // no manifest: not a snapshot
      }
    }
    walkRetained(path, out);
  }
}

function readBytes(path: string): Promise<Buffer> {
  try {
    return Promise.resolve(readFileSync(path));
  } catch (e) {
    return Promise.reject(new PyError('OSError', e instanceof Error ? e.message : String(e)));
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

async function runTs(spec: Spec, segment?: Segment): Promise<{ out: Outcome; root: string }> {
  const { root, spec: bound } = segment ?? layout(spec);
  const ticksToRun = segment?.ticks ?? bound.ticks;
  const stateRoot = join(root, 'state');
  const wtRoot = join(root, 'wt');
  const log: Entry[] = [];
  const worldPath = join(root, 'world.json');
  const saved = segment
    ? (() => {
        try {
          return JSON.parse(readFileSync(worldPath, 'utf8')) as {
            prs: Record<string, PrRow[]>;
            remote: Record<string, string>;
            removed: string[];
            n: number;
          };
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const world = {
    prs: new Map<string, PrRow[]>(
      Object.entries(saved?.prs ?? ((bound.prs ?? {}) as Record<string, PrRow[]>)),
    ),
    remote: new Map<string, string>(Object.entries(saved?.remote ?? bound.remote ?? {})),
    removed: saved?.removed ?? ([] as string[]),
    n: saved?.n ?? 0,
  };
  const cur = { tick: {} as Tick, run: '', picked: false, saves: 0 };
  const reads = fileRepairHarvestReads({ stateRoot, worktreeRoot: wtRoot });
  const files = filePublicationEffects({ stateRoot });
  const saveQueue = async (queue: Rec): Promise<void> => {
    cur.saves += 1;
    if (cur.tick.save_fail === cur.saves) {
      log.push(['save-fail', cur.saves]);
      throw new PyError('OSError', 'disk full');
    }
    log.push(['save', structuredClone(queue)]);
    await files.saveQueue(queue);
  };
  let backlog = new FixPrBacklog();

  /** The journal, patch, body and queue files the real writers have produced so far. */
  const snapshotFiles = (): Record<string, string> => {
    const found: Record<string, string> = {};
    for (const path of listFiles(stateRoot).sort()) {
      if (
        !['publication.json', 'queue.json', 'publication.patch', 'fix-pr.md'].includes(
          basename(path),
        )
      ) {
        continue;
      }
      found[relative(stateRoot, path)] = readFileSync(path, 'utf8');
    }
    return found;
  };

  // The cleanup probes: read-only questions over the fixture, with an in-memory
  // removal overlay in place of the directory deletion.
  const probes: RepairCleanupProbes = {
    resolve: (path) => reads.resolvePath(path),
    isSymlink: async (path) => {
      try {
        return (await lstat(path)).isSymbolicLink();
      } catch {
        return false;
      }
    },
    isDirectory: (path) => {
      if (world.removed.includes(basename(path)) && dirname(path) === wtRoot) {
        return Promise.resolve(false);
      }
      try {
        return Promise.resolve(statSync(path).isDirectory());
      } catch {
        return Promise.resolve(false);
      }
    },
    status: (worktree) => {
      log.push(['wt-status', basename(worktree)]);
      return Promise.resolve({
        failed: false,
        stdout: bound.trees[basename(worktree)]?.status ?? '',
      });
    },
    head: (worktree) => {
      log.push(['wt-head', basename(worktree)]);
      if (cur.tick.head_error !== undefined) {
        return Promise.reject(new PyError('RuntimeError', cur.tick.head_error));
      }
      return Promise.resolve(bound.trees[basename(worktree)]!.head);
    },
    retainedManifests: (directory) => {
      const found: string[] = [];
      walkRetained(directory, found);
      return Promise.resolve(
        found.map((path): RetentionRecord => {
          const name = basename(path);
          return {
            directoryName: name,
            readManifest: () => readBytes(join(path, 'manifest.json')),
            archiveDigest: async (archive) =>
              sha((await readBytes(join(path, archive))).toString()),
          };
        }),
      );
    },
  };

  const listBranchPrs = async (branch: string): Promise<PrRow[]> => {
    log.push(['list', branch]);
    return structuredClone(world.prs.get(branch) ?? []);
  };

  const finalizeEffects: PublicationFinalizeEffects = {
    repo: 'o/r',
    iso: () => 'now',
    listBranchPrs,
    repairProvenance: async () => [],
    writeFixPrBody: (job, body) => files.writeFixPrBody(job, body),
    writeJournal: (job, publication) => files.writeJournal(job, publication),
    saveQueue,
    async createPr(request) {
      const mode = cur.tick.create ?? 'ok';
      log.push(['create', request.head, mode, request.title]);
      if (mode === 'runtime') throw new PyError('RuntimeError', 'gh pr create failed');
      if (mode !== 'timeout-lost') {
        world.n += 1;
        const rows = world.prs.get(request.head) ?? [];
        rows.push({
          number: 100 + world.n,
          url: `u${world.n}`,
          state: 'OPEN',
          headRefOid: `head-${cur.run}`,
        });
        world.prs.set(request.head, rows);
      }
      if (mode.startsWith('timeout')) {
        // `str(subprocess.TimeoutExpired(argv, 600))`: harvest stores it in the
        // record, so the fixture reproduces CPython's text for the exact argv.
        const argv = [
          'gh',
          'pr',
          'create',
          '--repo',
          'o/r',
          '--base',
          request.base,
          '--head',
          request.head,
          '--title',
          request.title,
          '--body-file',
          request.bodyFile,
        ];
        const text = `[${argv.map((a) => `'${a}'`).join(', ')}]`;
        throw Object.assign(new Error(`Command '${text}' timed out after 600 seconds`), {
          name: 'TimeoutExpired',
        });
      }
    },
    newItem: publicationNewItem({
      iso: () => 'now',
      event: async (id, reason) => {
        log.push(['event', id, reason]);
      },
    }),
  };

  const publishEffects = (p: {
    q: Rec;
    item: Rec;
    run: string;
    rec: Rec;
  }): PublicationPublishEffects => ({
    iso: () => 'now',
    readJournal: (job) => files.readJournal(job),
    async revParseDefaultRef() {
      return 'target-main';
    },
    async prInfo(pr) {
      log.push(['pr-info', pr]);
      return structuredClone(bound.pr_info) as never;
    },
    async isAncestor(older, newer) {
      log.push(['ancestor', older, newer]);
      return bound.ancestor ?? true;
    },
    async makeWorktree(name, sha1) {
      log.push(['worktree', name, sha1]);
      return { path: join(wtRoot, `x-${name}`), branch: `wtb-${name}` };
    },
    async removeWorktree(worktree) {
      log.push(['remove-worktree', basename(worktree.path), worktree.branch]);
    },
    async revParseHead() {
      return cur.picked ? `head-${cur.run}` : `base-${cur.run}`;
    },
    async cherryPick() {
      cur.picked = true;
    },
    async verifyCherryPickHead() {
      throw new PyError('RuntimeError', 'no CHERRY_PICK_HEAD');
    },
    async conflictedFiles() {
      return '';
    },
    async stagedFiles() {
      return '';
    },
    async revListSince() {
      return [`claim-${cur.run}`];
    },
    async verify(wt, before, claims, job) {
      log.push(['verify', basename(wt.path), before, [...claims], job]);
    },
    async diffSince() {
      return `diff-${cur.run}`;
    },
    writePatch: (job, body) => files.writePatch(job, body),
    async hackDetector(_wt, diff) {
      log.push(['hack', diff]);
    },
    async secretScan(_job, target, head) {
      log.push(['secret-scan', target, head]);
      return true;
    },
    async updateRef(ref, sha1) {
      log.push(['update-ref', ref, sha1]);
    },
    writeJournal: (job, publication) => files.writeJournal(job, publication),
    saveQueue,
    async push(branch, expected, sha1) {
      log.push(['push', branch, expected, sha1]);
      if (cur.tick.push_fail) throw new PyError('RuntimeError', 'git push failed: network');
      world.remote.set(branch, sha1);
    },
    async lsRemoteHeads(branch) {
      log.push(['ls-remote', branch]);
      const head = world.remote.get(branch);
      return head === undefined ? '' : `${head}\trefs/heads/${branch}`;
    },
    listBranchPrs,
    finalize: (publication) =>
      finalizePublication(finalizeEffects, backlog, p.q, p.item, p.run, p.rec, publication),
  });

  let q: Queue = { items: [bound.item as Item, ...((bound.extra ?? []) as Item[])] };

  const fx: RepairHarvestEffects = {
    ...reads,
    async requireCanonicalDelivery(job) {
      log.push(['canonical', job.job]);
      raise(cur.tick.stale?.[job.job as string]);
    },
    async makeWorktree(name, commit) {
      log.push(['worktree', name, commit]);
      return { path: join(wtRoot, `x-${name}`), branch: `wtb-${name}` };
    },
    async removeWorktree(path, branch) {
      log.push(['remove-worktree', basename(path), branch]);
    },
    async verify(wt, predecessor, commits, jobId) {
      log.push(['verify', basename(wt), predecessor, [...commits], jobId]);
    },
    async mechanical(wt, predecessor, commits, jobId) {
      log.push(['mechanical', basename(wt), predecessor, [...commits], jobId, jobId]);
    },
    saveQueue: (queue) => saveQueue(queue as Rec),
    async markFindingOutcome(job, result) {
      log.push(['mark', job.job ?? null, JSON.stringify(result)]);
      raise(cur.tick.outcome?.[job.job as string]);
    },
    async recordUnpublishedFixedSibling(findingId, jobId, reason, repairBase) {
      log.push(['sibling', findingId, jobId, 'needs-human', reason, repairBase, 'exhausted']);
    },
    async cleanupHarvested(itemId, jobId, result, alternate) {
      log.push(['cleanup', itemId, jobId, alternate]);
      const decision = await decideRepairCleanup(
        {
          worktreeRoot: wtRoot,
          directory: join(stateRoot, 'repair', jobId),
          itemId,
          jobId,
          result,
          alternate,
        },
        probes,
      );
      if (decision.remove) {
        // `git worktree remove` is recorded, never run; the overlay is the removal.
        log.push(['wt-remove', basename(decision.worktree)]);
        world.removed.push(basename(decision.worktree));
      }
    },
    publish: (queue, item, run, record, fixed) =>
      publishRepair(
        publishEffects({ q: queue as Rec, item, run, rec: record }),
        queue as Rec,
        item,
        run,
        record,
        fixed,
      ),
  };

  const ticks: Outcome['ticks'] = [];
  for (const [index, tick] of ticksToRun.entries()) {
    cur.tick = tick;
    cur.saves = 0;
    log.push(['tick', index + (segment?.offset ?? 0)]);
    for (const [rel, doc] of Object.entries(tick.files ?? {})) putFile(stateRoot, rel, doc);
    if (segment && index === 0) {
      // A fresh process: the queue is only what is on disk.
      q = toPlainJson(await loadQueueDocument(join(stateRoot, 'queue.json'))) as unknown as Queue;
    }
    if (tick.restart) {
      if (!segment) {
        q = JSON.parse(JSON.stringify(q)) as Queue;
        backlog = new FixPrBacklog();
      }
      log.push(['restart']);
    }
    const item = q.items[0]!;
    for (const run of Object.keys((item.repair_runs ?? {}) as Rec)) {
      cur.run = run;
      cur.picked = false;
    }
    const out: Partial<Outcome['ticks'][number]> = {};
    let caught = '';
    try {
      out.messages = await repairHarvest(q, item, fx, tick.dry === true);
    } catch (e) {
      out.error = familyOf(e);
      caught = e instanceof Error ? e.message : String(e);
    }
    // Key order matters to the JSON-text comparison: messages|error, queue, files.
    if (segment && !tick.crash) {
      if (out.error !== undefined) {
        // `crq.tick` catches a harvest failure into the item.
        q.items[0]!.last_error = `repair harvest failed: ${caught.slice(0, 300)}`;
      }
      log.push(['tick-save']);
      await files.saveQueue(q as Rec);
    }
    out.queue = structuredClone(q) as Rec;
    out.files = snapshotFiles();
    ticks.push(out as Outcome['ticks'][number]);
    log.push(['backlog', { open: backlog.open, limit: backlog.limit }]);
  }

  if (segment) {
    writeFileSync(
      worldPath,
      JSON.stringify({
        prs: Object.fromEntries(world.prs),
        remote: Object.fromEntries(world.remote),
        removed: world.removed,
        n: world.n,
      }),
    );
  }
  const out = snapshotFiles();
  return { out: { log, ticks, files: out, removed: world.removed }, root };
}

/** One durable run: each segment is built from disk alone, nothing carried between them. */
async function runTsDurable(spec: Spec): Promise<{ out: Outcome; root: string }> {
  const { root, spec: bound } = layout(spec, true);
  const parts: Outcome[] = [];
  for (const segment of segmentsOf(bound.ticks)) {
    parts.push((await runTs(bound, { root, spec: bound, ...segment })).out);
  }
  return { out: joinSegments(parts), root };
}

// --- the comparison ---------------------------------------------------------

const norm = (value: unknown, root: string): unknown =>
  JSON.parse(JSON.stringify(value).replaceAll(root, '<ROOT>')) as unknown;

/** Run one scenario on both sides; fail naming the first diverging piece. */
async function parity(spec: Spec, durable = false): Promise<Outcome> {
  const py = durable ? runPythonDurable(spec) : runPython(spec);
  const ts = durable ? await runTsDurable(spec) : await runTs(spec);
  const a = norm(py.out, py.root) as Outcome;
  const b = norm(ts.out, ts.root) as Outcome;
  const at = a.log.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(b.log[i]));
  if (at !== -1 || a.log.length !== b.log.length) {
    const i = at === -1 ? Math.min(a.log.length, b.log.length) : at;
    expect({ at: i, py: a.log[i], ts: b.log[i] }).toEqual({ at: i, py: b.log[i], ts: a.log[i] });
  }
  expect(JSON.stringify(b.ticks)).toBe(JSON.stringify(a.ticks));
  expect(JSON.stringify(b.files)).toBe(JSON.stringify(a.files));
  expect(b.removed).toEqual(a.removed);
  return a;
}

// --- fixtures ---------------------------------------------------------------

function record(over: Rec = {}): Rec {
  return {
    state: 'queued',
    base: BASE,
    jobs: [J1],
    branch: 'fix-branch',
    open_pr: false,
    ...over,
  };
}

function item(over: Rec = {}, rec: Rec = {}): Rec {
  return {
    id: ITEM,
    pr: 0,
    kind: 'merged',
    state: 'repairing',
    repair_runs: { R: record(rec) },
    ...over,
  };
}

function fixed(job: string, over: Rec = {}): Rec {
  return {
    job,
    item: ITEM,
    verdict: 'FIXED',
    commits: [SHA1],
    attempts: [{ rung: 'A1' }],
    worktree: `{WT}/${tree(job)}`,
    repair_base: BASE,
    reason: 'fixed',
    ...over,
  };
}

function notFixed(job: string, over: Rec = {}): Rec {
  return {
    job,
    item: ITEM,
    verdict: 'NOT-FIXED',
    reason: 'nothing to change',
    worktree: `{WT}/${tree(job)}`,
    repair_base: BASE,
    ...over,
  };
}

function inbox(job: string, over: Rec = {}): Rec {
  return {
    job,
    item: ITEM,
    finding: { id: `f-${job}` },
    canonical_finding_id: `c-${job}`,
    ...over,
  };
}

/** `state/` files for one job: its result and its inbox row. */
function jobFiles(job: string, result: Rec, over: Rec = {}): Record<string, unknown> {
  return {
    [`repair/${job}/result.json`]: result,
    [`repair/inbox/${job}.json`]: inbox(job, over),
  };
}

const CLEAN = { head: 'h'.repeat(40), status: '' };
const HEAD = CLEAN.head;

function base(over: Partial<Spec> = {}): Spec {
  return {
    item: item(),
    files: jobFiles(J1, fixed(J1)),
    trees: { [tree(J1)]: CLEAN },
    retained: [{ job: J1, head: HEAD, base: BASE }],
    ticks: [{}, {}, { restart: true }],
    ...over,
  };
}

const OPEN_INFO = { state: 'OPEN', headRefName: 'fix-branch', headRefOid: 'target-open' };

function states(o: Outcome): string[] {
  return o.ticks.map(
    (t) => ((t.queue.items as Rec[])[0]!.repair_runs as Record<string, Rec>).R!.state as string,
  );
}

function removals(o: Outcome): string[] {
  return o.log.filter((e) => e[0] === 'wt-remove').map((e) => String(e[1]));
}

function count(o: Outcome, kind: string): number {
  return o.log.filter((e) => e[0] === kind).length;
}

// --- scenarios --------------------------------------------------------------

describe('S6 repair-harvest shadow: harvest -> publish -> finalize -> enroll -> cleanup', () => {
  it('publishes on the first tick, cleans up on the next, and a restart replays nothing', async () => {
    const o = await parity(base());
    expect(states(o)).toEqual(['published', 'published', 'published']);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    expect(count(o, 'event')).toBe(1);
    // The first tick harvests; cleanup only runs in the terminal branch after it.
    expect(removals(o)).toEqual([tree(J1)]);
    expect(o.log.findIndex((e) => e[0] === 'wt-remove')).toBeGreaterThan(
      o.log.findIndex((e) => e[0] === 'tick' && e[1] === 1),
    );
    expect(o.removed).toEqual([tree(J1)]);
  });

  it('a push failure is publish_failed; a restart recovers it from the journal without a second create', async () => {
    const o = await parity(
      base({ ticks: [{ push_fail: true }, { restart: true }, {}, { restart: true }] }),
    );
    expect(states(o)).toEqual(['publish_failed', 'published', 'published', 'published']);
    expect(count(o, 'push')).toBe(2);
    expect(count(o, 'create')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a create that timed out after landing is adopted on the restart, never created twice', async () => {
    const o = await parity(
      base({ ticks: [{ create: 'timeout-landed' }, { restart: true }, {}, { restart: true }] }),
    );
    expect(count(o, 'create')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a create that timed out and was lost is retried by the recovery of a later tick', async () => {
    const o = await parity(
      base({ ticks: [{ create: 'timeout-lost' }, { restart: true }, {}, { restart: true }] }),
    );
    expect(count(o, 'create')).toBeGreaterThanOrEqual(2);
  });

  it('repeated create failures across restarts end stale, and a stale run is still cleaned up', async () => {
    const o = await parity(
      base({
        ticks: [
          { create: 'runtime' },
          { restart: true, create: 'runtime' },
          { restart: true, create: 'runtime' },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(states(o).at(-1)).toBe('stale');
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a NOT-FIXED-only run publishes nothing and is cleaned up on the next tick', async () => {
    const o = await parity(
      base({
        files: jobFiles(J1, notFixed(J1)),
        retained: [{ job: J1, head: HEAD, base: BASE }],
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(states(o)).toEqual(['done', 'done', 'done']);
    expect(count(o, 'push')).toBe(0);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a dirty tree, a missing snapshot or a mismatched head each keep the tree across restarts', async () => {
    const dirty = await parity(
      base({
        trees: { [tree(J1)]: { head: HEAD, status: '?? stray.txt' } },
        ticks: [{}, {}, { restart: true }, { restart: true }],
      }),
    );
    expect(removals(dirty)).toEqual([]);
    expect(dirty.removed).toEqual([]);
    const missing = await parity(base({ retained: [], ticks: [{}, {}, { restart: true }] }));
    expect(removals(missing)).toEqual([]);
    const moved = await parity(
      base({
        retained: [{ job: J1, head: 'z'.repeat(40), base: BASE }],
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(removals(moved)).toEqual([]);
  });

  it('a legacy worktree name passes harvest and is then refused by cleanup (tree kept)', async () => {
    const legacy = `crq-repair-${ITEM}`;
    const o = await parity(
      base({
        files: jobFiles(J1, fixed(J1, { worktree: `{WT}/${legacy}` })),
        trees: { [legacy]: CLEAN },
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(states(o)[0]).toBe('published');
    expect(removals(o)).toEqual([]);
  });

  it('a two-job run cleans the base tree and the -A2 alternate of each verdict once', async () => {
    const o = await parity(
      base({
        item: item({}, { jobs: [J1, J2] }),
        files: {
          ...jobFiles(J1, fixed(J1)),
          ...jobFiles(J2, notFixed(J2, { worktree: `{WT}/${tree(J2, '-A2')}`, repair_base: BASE })),
        },
        trees: {
          [tree(J1)]: CLEAN,
          [tree(J2)]: CLEAN,
          [tree(J2, '-A2')]: CLEAN,
        },
        retained: [
          { job: J1, head: HEAD, base: BASE },
          { job: J2, head: HEAD, base: BASE },
        ],
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(removals(o).sort()).toEqual([tree(J1), tree(J2), tree(J2, '-A2')].sort());
  });

  it('a stale canonical delivery strands nothing: no publish, no cleanup, replay is a no-op', async () => {
    const o = await parity(
      base({
        ticks: [{ stale: { [J1]: 'value:canonical delivery mismatch' } }, { restart: true }, {}],
      }),
    );
    expect(states(o)[0]).toBe('stale');
    expect(count(o, 'push')).toBe(0);
    expect(removals(o)).toEqual([]);
  });

  it('a ledger write that fails late aborts the tick and the restart completes the same run', async () => {
    const o = await parity(
      base({
        ticks: [
          { outcome: { [J1]: 'os:ledger offline' } },
          { restart: true },
          {},
          { restart: true },
        ],
      }),
    );
    expect(o.ticks[0]!.error).toBe('OSError');
    expect(states(o)[0]).toBe('queued');
    expect(states(o)[1]).toBe('published');
    expect(count(o, 'push')).toBe(1);
  });

  it('a defective result becomes a terminal failure whose replay across restarts is compared effect for effect', async () => {
    await parity(
      base({
        files: jobFiles(J1, { job: J1, item: ITEM, verdict: 'BOGUS', reason: 'x' }),
        ticks: [{}, { restart: true }, { restart: true }],
      }),
    );
  });

  it('an open-PR run publishes without creating a PR, and a closed PR goes stale before any push', async () => {
    const open = await parity(
      base({
        item: item({ pr: 5, kind: 'open' }, { open_pr: true }),
        pr_info: OPEN_INFO,
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(count(open, 'create')).toBe(0);
    expect(states(open)[0]).toBe('published');
    const closed = await parity(
      base({
        item: item({ pr: 5, kind: 'open' }, { open_pr: true }),
        pr_info: { ...OPEN_INFO, state: 'MERGED' },
        ticks: [{}, {}, { restart: true }],
      }),
    );
    expect(states(closed)[0]).toBe('stale');
    expect(count(closed, 'push')).toBe(0);
  });

  it('a failing HEAD read is a recorded cleanup message each tick, and the tree stays', async () => {
    const o = await parity(
      base({
        ticks: [
          {},
          { head_error: 'git rev-parse failed' },
          { restart: true, head_error: 'git rev-parse failed' },
        ],
      }),
    );
    const messages = o.ticks.flatMap((t) => t.messages ?? []);
    expect(messages.some((m) => m.startsWith(`repair cleanup ${J1}:`))).toBe(true);
    expect(removals(o)).toEqual([]);
  });

  it('a dry tick plans the harvest and touches nothing; the live tick then publishes', async () => {
    const o = await parity(base({ ticks: [{ dry: true }, {}, {}, { restart: true }] }));
    expect(o.ticks[0]!.messages).toEqual(['would harvest repair R']);
    expect(states(o)).toEqual(['queued', 'published', 'published', 'published']);
  });
});

// --- durable restarts -------------------------------------------------------

const durable = (spec: Spec): Promise<Outcome> => parity(spec, true);

/** `state/queue.json` as it stood when tick `index` ended (disk, not memory). */
function diskItem(o: Outcome, index: number): Rec {
  return (JSON.parse(o.ticks[index]!.files['queue.json']!) as { items: Rec[] }).items[0]!;
}

/** The run's state in that file. */
function diskState(o: Outcome, index: number): string {
  return (diskItem(o, index).repair_runs as Record<string, Rec>).R!.state as string;
}

const JOURNAL = `repair/${J1}/publication.json`;

describe('S6 repair-harvest shadow: durable restarts reload state/queue.json', () => {
  it('a clean publish across three processes performs each external effect once', async () => {
    const o = await durable(base({ ticks: [{}, { restart: true }, { restart: true }] }));
    expect(states(o)).toEqual(['published', 'published', 'published']);
    for (const kind of ['push', 'create', 'event', 'mark', 'wt-remove']) {
      expect(count(o, kind), kind).toBe(1);
    }
    expect(count(o, 'restart')).toBe(2);
    // What the next process starts from is what the last one persisted.
    expect([0, 1, 2].map((i) => diskState(o, i))).toEqual(['published', 'published', 'published']);
    // Only the first process publishes; the later ones reload a published run
    // and go straight to cleanup, which removes the tree once.
    expect(removals(o)).toEqual([tree(J1)]);
    expect(o.removed).toEqual([tree(J1)]);
    expect(Object.keys(o.files).sort()).toEqual(
      [JOURNAL, `repair/${J1}/publication.patch`, `repair/${J1}/fix-pr.md`, 'queue.json'].sort(),
    );
  });

  it('a crash before the first queue save leaves queue.json untouched and the next process starts over', async () => {
    const o = await durable(
      base({
        ticks: [
          { save_fail: 1, crash: true },
          { restart: true },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(states(o)[0]).toBe('publish_failed');
    // In memory the run failed; on disk it never left its seeded state.
    expect(diskState(o, 0)).toBe('queued');
    expect(states(o).slice(1)).toEqual(['published', 'published', 'published']);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    // The ledger write is not suppressed: the second process re-harvests the run.
    expect(count(o, 'mark')).toBe(2);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a push that landed before the queue save was lost is adopted from the remote, never pushed twice', async () => {
    const o = await durable(
      base({
        ticks: [
          { save_fail: 2, crash: true },
          { restart: true },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    // The first save (`ready`) landed; the one after the push did not.
    expect(diskState(o, 0)).toBe('ready');
    expect(JOURNAL in o.ticks[0]!.files).toBe(true);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'ls-remote')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    expect(states(o).at(-1)).toBe('published');
  });

  it('a create that landed before the final queue save was lost is adopted; only the enrolment event repeats', async () => {
    const o = await durable(
      base({
        ticks: [
          { save_fail: 3, crash: true },
          { restart: true },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(diskState(o, 0)).toBe('ready');
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    // The PR is adopted by the second process, which enrols it again: Python's
    // `enrolled` event is a log line, not a deduplicated effect.
    expect(count(o, 'event')).toBe(2);
    expect(states(o).at(-1)).toBe('published');
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a ledger write that fails late is caught into last_error and saved; the next process completes the run once', async () => {
    const o = await durable(
      base({
        ticks: [{ outcome: { [J1]: 'os:ledger offline' } }, { restart: true }, { restart: true }],
      }),
    );
    expect(o.ticks[0]!.error).toBe('OSError');
    expect(diskState(o, 0)).toBe('queued');
    expect(diskItem(o, 0).last_error).toBe('repair harvest failed: ledger offline');
    expect(states(o).slice(1)).toEqual(['published', 'published']);
    expect(count(o, 'mark')).toBe(2);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
  });

  it('a create that timed out after landing is adopted by a later process, never created twice', async () => {
    const o = await durable(
      base({
        ticks: [
          { create: 'timeout-landed' },
          { restart: true },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(count(o, 'create')).toBe(1);
    expect(states(o).at(-1)).toBe('published');
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('repeated create failures across processes end stale, and the persisted counter survives each reload', async () => {
    const o = await durable(
      base({
        ticks: [
          { create: 'runtime' },
          { restart: true, create: 'runtime' },
          { restart: true, create: 'runtime' },
          { restart: true },
          { restart: true },
        ],
      }),
    );
    expect(states(o).at(-1)).toBe('stale');
    expect(diskState(o, 4)).toBe('stale');
    expect(count(o, 'push')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('the queue on disk is authoritative: an operator edit between processes beats the last in-memory state', async () => {
    const edited = { items: [item({}, { state: 'done' })] };
    const o = await durable(
      base({
        ticks: [
          { save_fail: 1, crash: true },
          { restart: true, files: { 'queue.json': edited } },
          { restart: true },
        ],
      }),
    );
    // Without the edit the second process would harvest and publish the queued run.
    expect(diskState(o, 0)).toBe('queued');
    expect(diskState(o, 1)).toBe('done');
    expect(count(o, 'push')).toBe(0);
    expect(count(o, 'create')).toBe(0);
  });

  it('a failed queue save is survivable: the tick persists publish_failed and the next process recovers from the journal', async () => {
    const o = await durable(
      base({ ticks: [{ save_fail: 1 }, { restart: true }, { restart: true }, { restart: true }] }),
    );
    expect(diskState(o, 0)).toBe('publish_failed');
    expect(JOURNAL in o.ticks[0]!.files).toBe(true);
    expect(states(o).slice(1)).toEqual(['published', 'published', 'published']);
    expect(count(o, 'push')).toBe(1);
    expect(count(o, 'create')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });

  it('a NOT-FIXED-only run is done on disk after one process and never publishes', async () => {
    const o = await durable(
      base({
        files: jobFiles(J1, notFixed(J1)),
        ticks: [{}, { restart: true }, { restart: true }],
      }),
    );
    expect(states(o)).toEqual(['done', 'done', 'done']);
    expect([0, 1, 2].map((i) => diskState(o, i))).toEqual(['done', 'done', 'done']);
    expect(count(o, 'push')).toBe(0);
    expect(count(o, 'mark')).toBe(1);
    expect(removals(o)).toEqual([tree(J1)]);
  });
});
