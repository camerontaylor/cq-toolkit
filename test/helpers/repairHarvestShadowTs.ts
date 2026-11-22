/**
 * The TypeScript side of the repair-harvest shadow (test/queue-runner/repairHarvestShadow.test.ts).
 *
 * One module, two hosts. The in-process scenarios call `runTs` with the `src`
 * modules under vitest. A durable run executes this very file as a separate
 * `node` process (`node repairHarvestShadowTs.ts`, native type stripping) with
 * the built `dist/` modules, so a restart really is a new process whose only
 * memory is the disposable scratch tree. For that reason this file has no
 * runtime import of anything under `src/` and only erasable TypeScript syntax:
 * every runtime dependency arrives through `Mods`.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { filePublicationEffects as FilePublicationEffects } from '../../src/adapters/crq/publicationFiles.js';
import type { loadQueueDocument as LoadQueueDocument } from '../../src/adapters/crq/queueEffects.js';
import type { fileRepairHarvestReads as FileRepairHarvestReads } from '../../src/adapters/crq/repairHarvestReads.js';
import type { toPlainJson as ToPlainJson } from '../../src/policy/crq/jsonValue.js';
import type { FixPrBacklog as FixPrBacklogClass } from '../../src/queue-runner/fixPrBacklog.js';
import type {
  finalizePublication as FinalizePublication,
  PublicationFinalizeEffects,
} from '../../src/queue-runner/publicationFinalize.js';
import type { publicationNewItem as PublicationNewItem } from '../../src/queue-runner/publicationEnroll.js';
import type {
  publishRepair as PublishRepair,
  PublicationPublishEffects,
} from '../../src/queue-runner/publicationPublish.js';
import type { PyError as PyErrorClass } from '../../src/queue-runner/pyErrors.js';
import type { Item, Queue } from '../../src/queue-runner/repairBackfill.js';
import type {
  decideRepairCleanup as DecideRepairCleanup,
  RepairCleanupProbes,
  RetentionRecord,
} from '../../src/queue-runner/repairCleanup.js';
import type {
  repairHarvest as RepairHarvest,
  RepairHarvestEffects,
} from '../../src/queue-runner/repairHarvest.js';

/** The runtime modules under test, from `src/` in vitest and from `dist/` in a child process. */
export interface Mods {
  PyError: typeof PyErrorClass;
  FixPrBacklog: typeof FixPrBacklogClass;
  filePublicationEffects: typeof FilePublicationEffects;
  loadQueueDocument: typeof LoadQueueDocument;
  fileRepairHarvestReads: typeof FileRepairHarvestReads;
  toPlainJson: typeof ToPlainJson;
  finalizePublication: typeof FinalizePublication;
  publicationNewItem: typeof PublicationNewItem;
  publishRepair: typeof PublishRepair;
  decideRepairCleanup: typeof DecideRepairCleanup;
  repairHarvest: typeof RepairHarvest;
}

export type Rec = Record<string, unknown>;
export type Entry = unknown[];
type Mode = 'ok' | 'runtime' | 'timeout-landed' | 'timeout-lost';

export interface Tick {
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

export interface Retained {
  job: string;
  head: string;
  base: string;
}

export interface Spec {
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

export interface Outcome {
  log: Entry[];
  ticks: { messages?: string[]; error?: string; queue: Rec; files: Record<string, string> }[];
  files: Record<string, string>;
  removed: string[];
}

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export function putFile(state: string, rel: string, doc: unknown): void {
  const path = join(state, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc));
}

// --- the TypeScript side ----------------------------------------------------

const NAMES: Record<string, PyErrorClass['kind']> = {
  value: 'ValueError',
  runtime: 'RuntimeError',
  os: 'OSError',
  key: 'KeyError',
  type: 'TypeError',
};

function raise(mods: Mods, directive: string | undefined): void {
  if (!directive) return;
  const [kind, ...rest] = directive.split(':');
  const text = rest.join(':');
  throw new mods.PyError(
    NAMES[kind as string] as PyErrorClass['kind'],
    kind === 'key' ? `'${text}'` : text,
  );
}

/** Python's `family()` reports the exception class name; PyError carries it as `kind`. */

const familyOf = (mods: Mods, e: unknown): string =>
  e instanceof mods.PyError ? e.kind : (e as Error).name;

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

function readBytes(mods: Mods, path: string): Promise<Buffer> {
  try {
    return Promise.resolve(readFileSync(path));
  } catch (e) {
    return Promise.reject(new mods.PyError('OSError', e instanceof Error ? e.message : String(e)));
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

/** One process's work: these ticks, from `offset`, against the scratch tree at `root`. */
export interface Run {
  root: string;
  spec: Spec;
  ticks: Tick[];
  offset: number;
  /** Durable: reload the queue and the world from disk, save at tick end, write the world back. */
  durable: boolean;
}

export async function runTs(mods: Mods, run: Run): Promise<Outcome> {
  const { PyError, FixPrBacklog } = mods;
  const { root, spec: bound, ticks: ticksToRun } = run;
  const stateRoot = join(root, 'state');
  const wtRoot = join(root, 'wt');
  const log: Entry[] = [];
  const worldPath = join(root, 'world.json');
  const saved = run.durable
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
  const reads = mods.fileRepairHarvestReads({ stateRoot, worktreeRoot: wtRoot });
  const files = mods.filePublicationEffects({ stateRoot });
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
            readManifest: () => readBytes(mods, join(path, 'manifest.json')),
            archiveDigest: async (archive) =>
              sha((await readBytes(mods, join(path, archive))).toString()),
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
    newItem: mods.publicationNewItem({
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
      mods.finalizePublication(finalizeEffects, backlog, p.q, p.item, p.run, p.rec, publication),
  });

  let q: Queue = { items: [bound.item as Item, ...((bound.extra ?? []) as Item[])] };

  const fx: RepairHarvestEffects = {
    ...reads,
    async requireCanonicalDelivery(job) {
      log.push(['canonical', job.job]);
      raise(mods, cur.tick.stale?.[job.job as string]);
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
      raise(mods, cur.tick.outcome?.[job.job as string]);
    },
    async recordUnpublishedFixedSibling(findingId, jobId, reason, repairBase) {
      log.push(['sibling', findingId, jobId, 'needs-human', reason, repairBase, 'exhausted']);
    },
    async cleanupHarvested(itemId, jobId, result, alternate) {
      log.push(['cleanup', itemId, jobId, alternate]);
      const decision = await mods.decideRepairCleanup(
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
      mods.publishRepair(
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
    log.push(['tick', index + run.offset]);
    for (const [rel, doc] of Object.entries(tick.files ?? {})) putFile(stateRoot, rel, doc);
    if (run.durable && index === 0) {
      // A fresh process: the queue is only what is on disk.
      q = mods.toPlainJson(
        await mods.loadQueueDocument(join(stateRoot, 'queue.json')),
      ) as unknown as Queue;
    }
    if (tick.restart) {
      if (!run.durable) {
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
      out.messages = await mods.repairHarvest(q, item, fx, tick.dry === true);
    } catch (e) {
      out.error = familyOf(mods, e);
      caught = e instanceof Error ? e.message : String(e);
    }
    // Key order matters to the JSON-text comparison: messages|error, queue, files.
    if (run.durable && !tick.crash) {
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

  if (run.durable) {
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
  return { log, ticks, files: out, removed: world.removed };
}

// --- the child process --------------------------------------------------------

/** The same modules `Mods` names, loaded from the built `dist/` (a plain `node` has no TS loader). */
async function loadDist(): Promise<Mods> {
  const load = async (rel: string): Promise<Record<string, unknown>> =>
    (await import(new URL(`../../dist/${rel}`, import.meta.url).href)) as Record<string, unknown>;
  const [files, queue, reads, json, backlog, finalize, enroll, publish, errors, cleanup, harvest] =
    await Promise.all([
      load('adapters/crq/publicationFiles.js'),
      load('adapters/crq/queueEffects.js'),
      load('adapters/crq/repairHarvestReads.js'),
      load('policy/crq/jsonValue.js'),
      load('queue-runner/fixPrBacklog.js'),
      load('queue-runner/publicationFinalize.js'),
      load('queue-runner/publicationEnroll.js'),
      load('queue-runner/publicationPublish.js'),
      load('queue-runner/pyErrors.js'),
      load('queue-runner/repairCleanup.js'),
      load('queue-runner/repairHarvest.js'),
    ]);
  return {
    PyError: errors.PyError,
    FixPrBacklog: backlog.FixPrBacklog,
    filePublicationEffects: files.filePublicationEffects,
    loadQueueDocument: queue.loadQueueDocument,
    fileRepairHarvestReads: reads.fileRepairHarvestReads,
    toPlainJson: json.toPlainJson,
    finalizePublication: finalize.finalizePublication,
    publicationNewItem: enroll.publicationNewItem,
    publishRepair: publish.publishRepair,
    decideRepairCleanup: cleanup.decideRepairCleanup,
    repairHarvest: harvest.repairHarvest,
  } as Mods;
}

// `node repairHarvestShadowTs.ts`: one durable segment per process. The request
// arrives as JSON on stdin and the outcome leaves as JSON on stdout.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const request = JSON.parse(readFileSync(0, 'utf8')) as Run;
  const outcome = await runTs(await loadDist(), { ...request, durable: true });
  process.stdout.write(JSON.stringify(outcome));
}
