/**
 * `repair_tick.finalize_publication` (repair_tick.py:804-881): record a
 * published repair and, for a non-PR publication, create or adopt its fix PR.
 * Inactive: nothing imports this outside tests.
 *
 * Every read and effect is injected. This module has no Git, forge, disk or
 * clock access, and application code never creates a PR: binding `createPr`
 * to `gh pr create` and the file effects to `state/repair/<job>/` is the
 * remaining runtime work, see `docs/crq/tick-slot-missing-effects.md`.
 *
 * Like Python it mutates `record`, `item`, `publication` and the queue in
 * place; the order of those writes and of the effects is part of the
 * contract and pinned by `test/queue-runner/publicationFinalize.test.ts`:
 *
 * 1. `record.publication`, `repair_own_commits` and `published_commits` are
 *    written first. Only the backfill hold (a creation the tick budget does
 *    not allow yet) restores them; the attempts-exhausted stale mark and a
 *    PR identity refusal leave them in place, as Python does.
 * 2. An open-PR publication records `last_push` and the same-PR `fix_pr`, with
 *    no forge call, and is `published`.
 * 3. A branch publication lists the branch's PRs. Empty means the create never
 *    landed: after `PR_CREATE_ATTEMPTS` it goes `stale`; a backfill item with
 *    no free slot is held; otherwise the body is written, the journal gains
 *    `pr_create_pending`/`pr_create_attempts`, the queue is saved, the slot is
 *    reserved, then the PR is created and the branch listed again.
 * 4. Whatever listing results (found or created) must be exactly one PR at the
 *    prepared `head` (#2290), else `ValueError`, never recorded or enrolled.
 * 5. The slot reserved for a backfill create is released only when `gh`
 *    reports a non-zero exit (`RuntimeError`); a timeout or any other failure
 *    may have created the PR, so the slot stays taken for the rest of the tick.
 */
import { pyEq, truthy } from './repairBackfill.js';
import { BACKFILL_ITEM, type FixPrBacklog } from './fixPrBacklog.js';
import { isPyError, PyError } from './pyErrors.js';

type Rec = Record<string, unknown>;

/** `repair_tick.PR_CREATE_ATTEMPTS`. */
export const PR_CREATE_ATTEMPTS = 3;
/** `runtime_target.DEFAULT_BRANCH`, the `--base` of `gh pr create`. */
export const FIX_PR_BASE = 'main';

export const REFUSE_FIX_PR_IDENTITY = 'fix PR identity or prepared head mismatch';

/** One row of `gh pr list --head <branch> --state all --json number,url,state,headRefOid`. */
export interface FixPrRow {
  readonly number?: unknown;
  readonly url?: unknown;
  readonly state?: unknown;
  readonly headRefOid?: unknown;
}

/** The `gh pr create` argv's variable parts; `--repo` is the binding's own. */
export interface CreatePrRequest {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly bodyFile: string;
}

export interface PublicationFinalizeEffects {
  /** `c.REPO`. */
  readonly repo: string;
  /** `c.CONFIG['repair'].get('fix_pr_cycles', 1)`; `undefined` is the default 1. */
  readonly fixPrCycles?: number;
  /** `c.iso()`. */
  iso(): string;
  /** `c.gh_json(['pr', 'list', '--repo', REPO, '--head', <branch>, '--state', 'all', ...])`. */
  listBranchPrs(branch: string): Promise<readonly FixPrRow[]>;
  /** `repair_provenance(c, record, run)`: the provenance table lines. */
  repairProvenance(record: Rec, run: string): Promise<readonly string[]>;
  /** `(STATE/repair/<job>/fix-pr.md).write_text(text)`; resolves to the path. */
  writeFixPrBody(jobId: unknown, text: string): Promise<string>;
  /** `atomic(STATE/repair/<job>/publication.json, publication)`. */
  writeJournal(jobId: unknown, publication: Rec): Promise<void>;
  /** `c.save_queue(q)`. */
  saveQueue(q: Rec): Promise<void>;
  /**
   * `c.run(['gh', 'pr', 'create', ...])`. A non-zero `gh` exit throws
   * `PyError('RuntimeError')`; any other throw (a timeout) is a create that
   * may have landed.
   */
  createPr(request: CreatePrRequest): Promise<void>;
  /** `c.new_item(q, [], False, **fields)`. */
  newItem(q: Rec, fields: Rec): Promise<void>;
}

/** `d[key]`: a missing key is a `KeyError`. */
function req(o: Rec, key: string): unknown {
  if (!Object.hasOwn(o, key)) throw new PyError('KeyError', `'${key}'`);
  return o[key];
}

function reqStr(o: Rec, key: string): string {
  const value = req(o, key);
  if (typeof value !== 'string') throw new TypeError(`publication ${key} must be a str`);
  return value;
}

/** `str(n)` for the integral PR numbers a queue holds; anything else is unmodelled. */
function intText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'object' && value !== null && 'kind' in value && 'integer' in value) {
    const n = value as { kind: unknown; integer: unknown };
    if (n.kind === 'int' && typeof n.integer === 'bigint') return n.integer.toString();
  }
  // `str()` of a float, bool or None differs from `String()`: not modelled.
  throw new Error('unsupported PR number representation');
}

/** `x['key']` on a value that is not a dict is a `TypeError`. */
function rec(value: unknown, what: string): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new PyError('TypeError', `${what} must be a dict`);
  return value as Rec;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be a list`);
  return value;
}

/** `str.replace('|', '\\|').replace('\n', ' ')` over a verdict's `reason`. */
function cell(value: unknown): string {
  // `v['reason'].replace(...)` on a non-str is an `AttributeError`.
  if (typeof value !== 'string')
    throw new PyError('AttributeError', 'reason has no attribute replace');
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new PyError('TypeError', `${what} must be a str`);
  return value;
}

/** `record['jobs'][0]`. */
function firstJob(record: Rec): unknown {
  const jobs = list(req(record, 'jobs'), 'jobs');
  if (jobs.length === 0) throw new PyError('IndexError', 'list index out of range');
  return jobs[0];
}

/**
 * Finalize one publication. `backlog` is the tick's `TICK_BACKLOG`, shared
 * with `refreshFixPrBacklog`. Returns after the record is `published`, after a
 * `stale` mark or a hold; throws what Python raises.
 */
export async function finalizePublication(
  effects: PublicationFinalizeEffects,
  backlog: FixPrBacklog,
  q: Rec,
  item: Rec,
  run: string,
  record: Rec,
  publication: Rec,
): Promise<void> {
  const absent = Symbol('absent');
  const hadOwned = Object.hasOwn(q, 'repair_own_commits');
  const before = {
    publication: Object.hasOwn(record, 'publication') ? record.publication : absent,
    published: Object.hasOwn(record, 'published_commits') ? record.published_commits : absent,
    owned: hadOwned ? [...list(q.repair_own_commits, 'repair_own_commits')] : [],
    hadOwned,
  };
  record.publication = publication;
  const translated = list(req(publication, 'commits'), 'commits');
  const head = reqStr(publication, 'head');
  const branch = reqStr(publication, 'branch');
  if (!hadOwned) q.repair_own_commits = [];
  const owned = list(q.repair_own_commits, 'repair_own_commits');
  // `list.extend(generator)` appends as it goes, so a repeat inside
  // `translated` is dropped too.
  for (const sha of translated) if (!owned.some((o) => pyEq(o, sha))) owned.push(sha);
  record.published_commits = translated;
  if (truthy(req(publication, 'open_pr'))) {
    item.last_push = { sha: head, shas: translated, at: effects.iso() };
    const pr = req(item, 'pr');
    record.fix_pr = {
      number: pr,
      url: `https://github.com/${effects.repo}/pull/${intText(pr)}`,
    };
  } else {
    let prs = await effects.listBranchPrs(branch);
    if (prs.length === 0) {
      // recoverPublication reconciled the branch to the prepared head and
      // adopts a PR at that head before calling here: an empty list with a
      // journaled create pending means the create never landed.
      const attempts = attemptsOf(publication);
      if (attempts >= PR_CREATE_ATTEMPTS) {
        Object.assign(record, {
          state: 'stale',
          error: `fix PR creation never completed after ${PR_CREATE_ATTEMPTS} attempts; reconcile the PR for ${branch} manually`,
        });
        return;
      }
      if (!backlog.slotFree(item)) {
        // Held, not failed: no attempt counted, retried on a later tick. Undo
        // the bookkeeping above so the record reads as it did before.
        for (const [key, value] of [
          ['publication', before.publication],
          ['published_commits', before.published],
        ] as const) {
          if (value === absent) delete record[key];
          else record[key] = value;
        }
        if (before.hadOwned) owned.splice(0, owned.length, ...before.owned);
        else delete q.repair_own_commits;
        return;
      }
      const body = [
        `Verified CodeRabbit repairs from ${run}`,
        '',
        '| finding | verdict | reason |',
        '|---|---|---|',
      ];
      for (const v of list(req(record, 'verdicts'), 'verdicts')) {
        const row = rec(v, 'verdict');
        body.push(
          `| ${text(req(row, 'job'), 'job')} | ${text(req(row, 'verdict'), 'verdict')} | ${cell(req(row, 'reason'))} |`,
        );
      }
      body.push(...(await effects.repairProvenance(record, run)));
      const jobId = firstJob(record);
      const bodyFile = await effects.writeFixPrBody(jobId, `${body.join('\n')}\n`);
      publication.pr_create_pending = true;
      publication.pr_create_attempts = attempts + 1;
      await effects.writeJournal(jobId, publication);
      await effects.saveQueue(q);
      // Reserve the slot before creating: a create that lands but then times
      // out still counts for the rest of the tick, and the next tick's refresh
      // recounts from GitHub. Only a create gh reports as failed releases it.
      const reserved = typeof item.id === 'string' && item.id.startsWith(BACKFILL_ITEM);
      if (reserved) backlog.reserve();
      try {
        await effects.createPr({
          base: FIX_PR_BASE,
          head: branch,
          title: `fix: Address CodeRabbit findings from ${run}`,
          bodyFile,
        });
      } catch (e) {
        if (reserved && isPyError(e, 'RuntimeError')) backlog.release();
        throw e;
      }
      prs = await effects.listBranchPrs(branch);
    }
    // Exactly one PR, at the prepared head: never record or enroll another.
    if (prs.length !== 1 || req(rec(prs[0], 'PR row'), 'headRefOid') !== head)
      throw new PyError('ValueError', REFUSE_FIX_PR_IDENTITY);
    const pr = rec(prs[0], 'PR row');
    record.fix_pr = pr;
    const items = list(req(q, 'items'), 'items');
    const enrolled = items.some(
      (i) =>
        pyEq(req(rec(i, 'item'), 'pr'), req(pr, 'number')) && pyEq(req(i as Rec, 'kind'), 'open'),
    );
    if (!enrolled) {
      const number = req(pr, 'number');
      await effects.newItem(q, {
        id: `pr${intText(number)}`,
        pr: number,
        kind: 'open',
        tier: 1,
        prior_cycles: 2 - (effects.fixPrCycles ?? 1),
        repair_origin: run,
        why: 'verified repair fix PR',
      });
    }
  }
  record.state = 'published';
  item.state = 'done';
  await effects.saveQueue(q);
}

/** `publication.get('pr_create_attempts', 0)`: a bool is an int, any other non-number a `TypeError`. */
function attemptsOf(publication: Rec): number {
  const value = Object.hasOwn(publication, 'pr_create_attempts')
    ? publication.pr_create_attempts
    : 0;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value !== 'number')
    throw new PyError('TypeError', 'pr_create_attempts must be a number');
  return value;
}
