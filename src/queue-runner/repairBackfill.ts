/**
 * The queue side of `repair_tick.enqueue`, `backfill` and `archive_legacy`
 * (repair_tick.py:175-272, 848-892). Inactive: nothing imports this outside
 * tests. Items and queues are plain records edited in place; every read of the
 * run directory, inbox, receipts and git is injected. The review.ndjson parser
 * (`crq_repair.findings`) has no TS port, so `findings` is an injected effect.
 *
 * Python raises `KeyError`/`TypeError`/`AttributeError` for malformed records;
 * the port throws at the same points instead of inventing a default.
 */
import { receiptDigest } from '../policy/crq/ids.js';
import { itemRepo, sameRepo } from '../policy/crq/tickSchedule.js';
import { pySplitLines } from './fixPrBacklog.js';

type Rec = Record<string, unknown>;
export type Item = Rec;
export type Queue = Rec & { items: Item[] };

/** `review_receipt.KIND`. */
export const REVIEW_RECEIPT_KIND = 'merged-current';
/** `local_review_runtime.KIND` as spelled in `enqueue`. */
export const LOCAL_REVIEW_KIND = 'local-review';
/** `crq_repair.bounded.JOB_ID`. */
const JOB_ID = /^crq-[A-Za-z0-9._-]+$/;
const OPEN_STATES = ['queued', 'ready', 'publish_failed'];

/** One `findings(..., provenance=True)` row: the finding and its `_source`. */
export interface SourcedFinding {
  readonly finding: Rec;
  readonly source: Rec;
}

export interface RepairEnqueueEffects {
  /** `c.REPO`. */
  readonly primaryRepo: string;
  /** `((CONFIG.repair or {}).merged_current or {}).enabled is True`. */
  readonly mergedCurrentEnabled: boolean;
  /** `CONFIG['repair'].get('max_rounds_per_pin', 2)`. */
  readonly maxRoundsPerPin: number;
  /** `DEFAULT_REF`. */
  readonly defaultRef: string;
  /** `json.loads(STATE/receipts/<id>.json)`; throws when unreadable. */
  readReceipt(receiptId: string): Promise<Rec>;
  /** `crq_repair.findings(RUNS/<run>/review.ndjson[, provenance=True])`. */
  findings(run: string, provenance: boolean): Promise<SourcedFinding[]>;
  /** `c.git(*args)`: stripped stdout; throws on a non-zero exit. */
  git(...args: string[]): Promise<string>;
  /** `json.loads(STATE/repair/inbox/<job>.json)`; `null` when the file does not exist. */
  readInbox(jobId: string): Promise<Rec | null>;
  /** `atomic(STATE/repair/inbox/<job>.json, doc)`. */
  writeInbox(jobId: string, doc: Rec): Promise<void>;
  /** `(STATE/repair/<job>/result.json).exists()`. */
  resultExists(jobId: string): Promise<boolean>;
}

export interface RepairBackfillEffects extends RepairEnqueueEffects {
  /** Both `RUNS/<run>/meta.json` and `RUNS/<run>/review.ndjson` exist. */
  hasRunEvidence(run: string): Promise<boolean>;
  /** `json.loads(RUNS/<run>/meta.json)`. */
  readMeta(run: string): Promise<unknown>;
  /** `c.iso()`. */
  iso(): string;
}

export interface RepairArchiveEffects {
  iso(): string;
  /** `LEDGER/archive` mkdir, then move every `LEDGER/*-findings.md` into it. */
  archiveLedger(): Promise<void>;
}

// ---------------------------------------------------------------- py helpers

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (typeof v === 'bigint') return v !== 0n;
  if (Array.isArray(v)) return v.length > 0;
  if (isRec(v)) return Object.keys(v).length > 0;
  return true;
}

function dict(v: unknown, what: string): Rec {
  if (!isRec(v)) throw new TypeError(`${what} must be a dict`);
  return v;
}

/** `d[key]` */
function req(o: Rec, key: string): unknown {
  if (!Object.hasOwn(o, key)) throw new Error(`KeyError: ${key}`);
  return o[key];
}

/** `d.get(key[, default])`; an absent key with no default is `undefined`. */
function get(o: Rec, key: string, fallback?: unknown): unknown {
  return Object.hasOwn(o, key) ? o[key] : fallback;
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a str`);
  return v;
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new TypeError(`${what} must be a list`);
  return v;
}

/** Python `==` over JSON values: `1 == 1.0 == True`, `None` equals only `None`. */
function pyEq(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  const num = (v: unknown): number | bigint | null =>
    typeof v === 'number' || typeof v === 'bigint' ? v : typeof v === 'boolean' ? Number(v) : null;
  const nx = num(x);
  const ny = num(y);
  if (nx !== null || ny !== null) return nx !== null && ny !== null && nx <= ny && ny <= nx;
  if (Array.isArray(x)) {
    return Array.isArray(y) && x.length === y.length && x.every((e, i) => pyEq(e, y[i]));
  }
  if (isRec(x)) {
    if (!isRec(y)) return false;
    const keys = Object.keys(x);
    return (
      keys.length === Object.keys(y).length &&
      keys.every((k) => Object.hasOwn(y, k) && pyEq(x[k], y[k]))
    );
  }
  return x === y;
}

/** `item.setdefault('repair_runs', {})`. */
function repairRuns(item: Item): Rec {
  if (!Object.hasOwn(item, 'repair_runs')) item.repair_runs = {};
  return dict(item.repair_runs, 'repair_runs');
}

/** `own_range`: `bool(commits) and set(commits) <= set(q.get('repair_own_commits', []))`. */
async function ownRange(
  q: Queue,
  fx: Pick<RepairEnqueueEffects, 'git'>,
  base: unknown,
  head: unknown,
): Promise<boolean> {
  const commits = pySplitLines(
    await fx.git('rev-list', `${str(base, 'base')}..${str(head, 'head')}`),
  );
  if (commits.length === 0) return false;
  const owned = new Set(list(get(q, 'repair_own_commits', []), 'repair_own_commits'));
  return commits.every((c) => owned.has(c));
}

/** `meta.get('pr_head', meta['head'])`. */
const prHead = (meta: Rec): unknown =>
  Object.hasOwn(meta, 'pr_head') ? meta.pr_head : req(meta, 'head');

// ------------------------------------------------------------------- enqueue

/**
 * `repair_tick.enqueue`: queue one repair record (and its inbox jobs) for a
 * review run's actionable findings. Returns true when a repair is queued or
 * still drainable for the run.
 */
export async function repairEnqueue(
  q: Queue,
  item: Item,
  metaIn: unknown,
  fx: RepairEnqueueEffects,
): Promise<boolean> {
  const meta = dict(metaIn, 'meta');
  const metaRun = get(meta, 'run_id');
  if (
    get(item, 'kind') === LOCAL_REVIEW_KIND ||
    get(meta, 'kind') === LOCAL_REVIEW_KIND ||
    list(get(item, 'cycles', []), 'cycles').some((cycle) => {
      const c = dict(cycle, 'cycle');
      return get(c, 'source') === LOCAL_REVIEW_KIND && pyEq(get(c, 'run_id'), metaRun);
    })
  ) {
    return false;
  }
  if (!sameRepo(itemRepo(item, fx.primaryRepo), fx.primaryRepo)) {
    // The repair drain never runs for non-primary repositories.
    return false;
  }
  const kind = req(item, 'kind');
  const isReceipt = kind === REVIEW_RECEIPT_KIND;
  let doc: Rec | undefined;
  if (isReceipt) {
    if (!fx.mergedCurrentEnabled) return false;
    // Require complete supported finding scope, not a partial repair of a mixed receipt.
    doc = dict(await fx.readReceipt(str(req(item, 'receipt_id'), 'receipt_id')), 'receipt');
    const docFindings = get(doc, 'findings');
    if (
      get(doc, 'outcome') !== 'terminal-with-findings' ||
      !truthy(docFindings) ||
      list(docFindings, 'findings').some((f) => {
        const severity = get(dict(f, 'finding'), 'severity');
        return severity !== 'critical' && severity !== 'major';
      })
    ) {
      return false;
    }
  }
  // `item.setdefault(...)` runs before `meta['run_id']`, so a KeyError leaves it behind.
  const runs = repairRuns(item);
  const runId = str(req(meta, 'run_id'), 'run_id');
  const existing = get(runs, runId);
  const sourced = await fx.findings(runId, true);
  const actionable = sourced.map((s) => s.finding);
  const sources = sourced.map((s) => ({ ...s.source, run: runId }));
  if (truthy(existing)) {
    const record = dict(existing, 'repair record');
    for (const jobId of list(get(record, 'jobs', []), 'jobs')) {
      const job = await fx.readInbox(str(jobId, 'job id'));
      if (job === null) continue;
      const matches = actionable.flatMap((finding, n) =>
        pyEq(finding, get(job, 'finding')) ? [sources[n]] : [],
      );
      if (matches.length === 1 && !truthy(get(job, 'source'))) {
        job.source = matches[0];
        await fx.writeInbox(jobId as string, job);
      }
    }
    return OPEN_STATES.includes(req(record, 'state') as string);
  }
  if (actionable.length === 0) return false;
  if (await ownRange(q, fx, req(meta, 'base'), prHead(meta))) return false;
  const pin = truthy(get(meta, 'review_pin'))
    ? meta.review_pin
    : truthy(get(item, 'pinned_base'))
      ? item.pinned_base
      : req(meta, 'base');
  // Delta items are separate queue entries but share a PR/pin repair ceiling.
  const history = q.items
    .filter((i) => pyEq(get(i, 'pr'), get(item, 'pr')))
    .flatMap((i) =>
      Object.values(dict(get(i, 'repair_runs', {}), 'repair_runs')).map((r) =>
        dict(r, 'repair record'),
      ),
    );
  const count = history.filter((r) => pyEq(get(r, 'pin'), pin)).length;
  if (count >= fx.maxRoundsPerPin) {
    item.last_error = 'repair round ceiling reached; needs human';
    return false;
  }
  const openPr = (kind === 'open' || kind === 'delta') && truthy(get(meta, 'pr_branch'));
  let base: unknown = isReceipt
    ? req(dict(req(item, 'capture'), 'capture'), 'target')
    : openPr
      ? prHead(meta)
      : await fx.git('rev-parse', fx.defaultRef);
  if (!openPr && !isReceipt) {
    // An interrupted enqueue can leave inbox jobs whose base predates a
    // moved default-branch tip; adopt it so harvest's predecessor check holds.
    for (let n = 1; n <= actionable.length; n++) {
      const prev = await fx.readInbox(`crq-${runId}-F${n}`);
      if (
        prev !== null &&
        pyEq(get(prev, 'finding'), actionable[n - 1]) &&
        truthy(get(prev, 'repair_base'))
      ) {
        base = prev.repair_base;
        break;
      }
    }
  }
  const record: Rec = {
    jobs: [] as string[],
    pin,
    base,
    branch: get(meta, 'pr_branch', null),
    open_pr: openPr,
    round: count + 1,
    state: 'queued',
  };
  const reviewedDiff = await fx.git(
    'diff',
    str(req(meta, 'base'), 'base'),
    str(req(meta, 'head'), 'head'),
  );
  if (!JOB_ID.test(`crq-${runId}-F1`)) {
    // bounded.job_path refuses such ids, so the job would never drain.
    item.last_error = 'repair not enqueued: run id outside the job-id grammar';
    return false;
  }
  for (let n = 1; n <= actionable.length; n++) {
    const finding = actionable[n - 1] as Rec;
    const jobId = `crq-${runId}-F${n}`;
    const prior = history
      .flatMap((r) => list(get(r, 'verdicts', []), 'verdicts').map((v) => dict(v, 'verdict')))
      .filter((v) => {
        const vf = dict(get(v, 'finding', {}), 'verdict finding');
        return (
          get(v, 'verdict') === 'NOT-FIXED' &&
          pyEq(get(vf, 'path'), req(finding, 'path')) &&
          pyEq(get(vf, 'severity'), req(finding, 'severity'))
        );
      });
    const job: Rec = {
      job: jobId,
      item: req(item, 'id'),
      kind: item.kind,
      pr: req(item, 'pr'),
      run: runId,
      cycle: get(meta, 'cycle', null),
      repair_base: base,
      branch: record.branch,
      finding,
      repair_round: count + 1,
      prior: prior.length > 0 ? prior[prior.length - 1] : null,
      recurrence: prior.length > 0,
      review_diff: reviewedDiff,
      source: sources[n - 1],
    };
    const prev = await fx.readInbox(jobId);
    if (prev === null) {
      await fx.writeInbox(jobId, job);
    } else {
      if (!truthy(get(prev, 'source')) && pyEq(get(prev, 'finding'), finding)) {
        prev.source = sources[n - 1];
        await fx.writeInbox(jobId, prev);
      }
      if (
        (!pyEq(get(prev, 'repair_base'), base) || !pyEq(get(prev, 'finding'), finding)) &&
        !(await fx.resultExists(jobId))
      ) {
        // Stale orphan that never ran: rebind to this record.
        await fx.writeInbox(jobId, job);
      }
    }
    (record.jobs as string[]).push(jobId);
    for (const blocker of list(get(item, 'blocking', []), 'blocking')) {
      const b = dict(blocker, 'blocker');
      if (pyEq(get(b, 'run'), runId) && pyEq(get(b, 'run_finding'), n)) b.repair_job = jobId;
    }
  }
  if (isReceipt) {
    const receiptFindings = list(get(doc as Rec, 'findings'), 'findings');
    record.receipt_id = req(item, 'receipt_id');
    record.receipt_findings = receiptFindings.map((f) => receiptDigest(f)).sort();
    record.repair_findings = actionable.map((f) => receiptDigest(f)).sort();
  }
  runs[runId] = record;
  return true;
}

// ------------------------------------------------------------------ backfill

/**
 * `repair_tick.backfill`: enqueue every legacy cycle's findings, and record
 * the cycles that have no repair verdict as `legacy_repair_missing`.
 */
export async function repairBackfill(q: Queue, fx: RepairBackfillEffects): Promise<void> {
  if (truthy(q.legacy_repair_backfilled)) return;
  const missing: Rec[] = [];
  for (const item of q.items) {
    if (!sameRepo(itemRepo(item, fx.primaryRepo), fx.primaryRepo)) {
      // Foreign cycles are review evidence, never legacy repair debt.
      continue;
    }
    for (const cycleIn of list(get(item, 'cycles', []), 'cycles')) {
      const cycle = dict(cycleIn, 'cycle');
      if (get(cycle, 'source') === LOCAL_REVIEW_KIND) continue;
      const run = str(req(cycle, 'run_id'), 'run_id');
      if (!(await fx.hasRunEvidence(run))) {
        // No evidence means no verdict and no archive permission.
        if (
          truthy(get(cycle, 'findings')) ||
          truthy(get(cycle, 'severity_counts')) ||
          truthy(get(item, 'blocking')) ||
          run.startsWith('signer:')
        ) {
          missing.push({ item: req(item, 'id'), run });
        }
        continue;
      }
      const meta = dict(await fx.readMeta(run), 'meta');
      if (get(meta, 'kind') === LOCAL_REVIEW_KIND) continue;
      const queued = await repairEnqueue(q, item, meta, fx);
      if (
        !queued &&
        !Object.hasOwn(dict(get(item, 'repair_runs', {}), 'repair_runs'), run) &&
        (await fx.findings(run, false)).length > 0
      ) {
        if (!(await ownRange(q, fx, req(meta, 'base'), prHead(meta)))) {
          missing.push({
            item: req(item, 'id'),
            run,
            reason: truthy(get(item, 'last_error')) ? item.last_error : 'no repair verdict',
          });
        }
      }
    }
  }
  q.legacy_repair_missing = missing;
  if (missing.length === 0) q.legacy_repair_backfilled = fx.iso();
  // Archive only when all backfilled findings have terminal verdicts.
}

// ------------------------------------------------------------- archiveLegacy

/** `repair_tick.archive_legacy`: archive the legacy ledger once nothing is owed. */
export async function repairArchiveLegacy(q: Queue, fx: RepairArchiveEffects): Promise<void> {
  if (truthy(q.legacy_repair_missing) || !truthy(q.legacy_repair_backfilled)) return;
  const records = q.items.flatMap((i) =>
    Object.values(dict(get(i, 'repair_runs', {}), 'repair_runs')).map((r) =>
      dict(r, 'repair record'),
    ),
  );
  if (records.some((r) => OPEN_STATES.includes(req(r, 'state') as string))) return;
  if (truthy(q.legacy_ledger_archived)) return;
  await fx.archiveLedger();
  q.legacy_ledger_archived = fx.iso();
}
