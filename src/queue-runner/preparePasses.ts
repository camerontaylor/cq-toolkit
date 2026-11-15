/**
 * The prepare passes of the Python tick (inactive; nothing imports this outside
 * tests): `prepare_current` (crq.py:1119), `push_current.prepare`,
 * `local_review_runtime.prepare`, `pr_info` (crq.py:646) and `quiet_reason`
 * (crq.py:783).
 *
 * Every effect is injected: git, the forge, receipts, the queue writer and the
 * clock. Items are plain records edited in place, exactly as Python edits its
 * dicts; the caller owns tick.lock. Domain refusals (`NotReady`) and the
 * "item finished, nothing to spawn" `None` return are tagged outcomes so this
 * module shares no exception class with the other slices. Anything Python lets
 * escape as KeyError/TypeError/ValueError/CalledProcessError throws here too,
 * because the tick routes those through its generic planning-error branch.
 */
import { currentEquivalence, reusableCurrent } from '../policy/crq/receiptIdentity.js';
import { MERGED_CURRENT_POLICY } from '../policy/crq/ids.js';
import { receiptJsonDigest } from '../policy/crq/pythonJson.js';

export type Item = Record<string, unknown>;
export type Queue = Record<string, unknown> & { items: Item[] };
export type PathRow = Record<string, unknown>;

export type PrepareOutcome<P> =
  | { readonly outcome: 'plan'; readonly plan: P }
  | { readonly outcome: 'not-ready'; readonly reason: string }
  | { readonly outcome: 'nothing-to-review' };

export interface CurrentPlan {
  base: string;
  head: string;
  target: string;
  cycle: null;
  branch: null;
  label: string;
  notes: string[];
  review_pin?: string;
}

const PROJECTION = 'current-affected-files/full-file-addition-projection';
const REVIEWER = 'coderabbit-review-agent-committed-v1';
const POLICY = MERGED_CURRENT_POLICY;
const FILE_BYTES = 262144;
const SCOPE_BYTES = 2097152;
const SCOPE_CAP_REASON = 'current content exceeds scope byte cap';

const plan = <P>(p: P): PrepareOutcome<P> => ({ outcome: 'plan', plan: p });
const notReady = (reason: string): PrepareOutcome<never> => ({ outcome: 'not-ready', reason });
const nothing: PrepareOutcome<never> = { outcome: 'nothing-to-review' };

/** Python `s[:n]`: counts code points, not UTF-16 units. */
export function pyPrefix(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('');
}
function str(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`);
  return value;
}
function rec(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${what} must be an object`);
  return value as Record<string, unknown>;
}
function rows(value: unknown): PathRow[] {
  if (!Array.isArray(value)) throw new TypeError('capture.paths must be a list');
  return value as PathRow[];
}
/** Python's `or {}` on an optional sub-dict. */
function orEmpty(value: unknown): Record<string, unknown> {
  return value ? rec(value, 'record') : {};
}
function isSelected(row: PathRow): boolean {
  return row.disposition === 'included' || row.disposition === 'renamed';
}
function sortedPaths(list: readonly PathRow[]): string[] {
  return [...new Set(list.map((r) => str(r.path, 'path')))].sort(codePointCompare);
}
function codePointCompare(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as string).codePointAt(0)! - (y[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

// ------------------------------------------------------------- prepare_current

export interface PrepareCurrentEffects {
  iso(): string;
  /** `live_items(q)`: the queue minus retired promotion records. */
  liveItems(queue: Queue): Item[];
  /** `review_receipt.SELECTORS[selector]`; throws (KeyError) on an unknown selector. */
  selectorRef(selector: string): string;
  /** `git rev-parse <ref>^{commit}` in the primary clone. */
  revParseCommit(ref: string): Promise<string>;
  /** `git rev-parse <commit>^{tree}`. */
  revParseTree(commit: string): Promise<string>;
  currentPaths(merge: string, target: string): Promise<PathRow[]>;
  /** `coderabbit --version`, stripped (the caller of this slice truncates to 100 code points). */
  reviewerVersion(): Promise<string>;
  buildCurrentProjection(
    target: string,
    selected: string[],
  ): Promise<{ base: string; head: string }>;
  updateRef(name: string, sha: string): Promise<void>;
  saveQueue(queue: Queue): Promise<void>;
  /** `review_receipt.read_receipt` then load the document: `{receiptId, document}`. */
  readReceipt(receiptId: string): Promise<{ receiptId: string; document: unknown }>;
  /** `review_receipt.write_receipt(current_document(item, outcome))`; returns the receipt id. */
  writeCurrentReceipt(item: Item, outcome: 'unsupported' | 'no-current-code'): Promise<string>;
}

export async function prepareCurrent(
  q: Queue,
  item: Item,
  dry: boolean,
  fx: PrepareCurrentEffects,
): Promise<PrepareOutcome<CurrentPlan>> {
  const subject = rec(item.subject, 'item.subject');
  if (dry) {
    return plan({
      base: '(dispatch-pin)',
      head: '(dispatch-pin)',
      target: str(subject.target_selector, 'target_selector'),
      cycle: null,
      branch: null,
      label: 'affected current files (not captured)',
      notes: [],
    });
  }
  if (
    fx.liveItems(q).some((i) => i.kind === 'merged' && i.pr === item.pr && i.state === 'reviewing')
  )
    return notReady('legacy source review still owns a live/ambiguous run; no new dispatch');
  if (!item.capture) {
    const target = await fx.revParseCommit(
      fx.selectorRef(str(subject.target_selector, 'selector')),
    );
    const paths = await fx.currentPaths(str(item.merge_commit, 'merge_commit'), target);
    const selected = sortedPaths(paths.filter(isSelected));
    const capture: Record<string, unknown> = {
      target,
      tree: await fx.revParseTree(target),
      paths,
      scope_digest: receiptJsonDigest(paths),
      policy: POLICY,
      projection: PROJECTION,
      reviewer: REVIEWER,
      reviewer_version: pyPrefix((await fx.reviewerVersion()).trim(), 100),
      captured_at: fx.iso(),
    };
    capture.equivalence = currentEquivalence(capture);
    if (selected.length > 0) {
      const built = await fx.buildCurrentProjection(target, selected);
      capture.base = built.base;
      capture.head = built.head;
      // Keep objects reachable through GC and daemon/caller restart.
      for (const part of ['base', 'head'] as const)
        await fx.updateRef(`refs/crq/current/${str(item.id, 'id')}/${part}`, built[part]);
    }
    item.capture = capture;
    await fx.saveQueue(q);
  }
  const capture = rec(item.capture, 'item.capture');
  const equivalence = capture.equivalence;
  if (equivalence === undefined) throw new TypeError('capture.equivalence missing');
  for (const other of q.items) {
    if (other === item || other.kind !== 'merged-current') continue;
    if (orEmpty(other.capture).equivalence !== equivalence) continue;
    if (
      other.receipt_id &&
      (other.state === 'done' || other.state === 'no-current-code' || other.state === 'unsupported')
    ) {
      // Verify retained bytes and semantic proof, never reuse legacy synthetic credit.
      const { document } = await fx.readReceipt(str(other.receipt_id, 'receipt_id'));
      const retained = rec(document, 'receipt document').capture;
      if (currentEquivalence(retained) !== currentEquivalence(capture))
        throw new Error('reuse receipt scope mismatch');
      if (other.state === 'done' && !reusableCurrent(document, capture)) continue;
      item.state = other.state;
      item.receipt_id = other.receipt_id;
      item.reused_from = other.id;
      await fx.saveQueue(q);
      return nothing;
    }
    if (other.state === 'reviewing')
      return notReady('equivalent current subject already reviewing: ' + str(other.id, 'id'));
  }
  const captured = rows(capture.paths);
  if (!captured.some(isSelected)) {
    const unsupported = captured.some(
      (r) => r.disposition === 'unsupported' || r.disposition === 'ambiguous',
    );
    const outcome = unsupported ? 'unsupported' : 'no-current-code';
    item.receipt_id = await fx.writeCurrentReceipt(item, outcome);
    item.state = outcome;
    await fx.saveQueue(q);
    return nothing;
  }
  const target = str(capture.target, 'capture.target');
  return plan({
    base: str(capture.base, 'capture.base'),
    head: str(capture.head, 'capture.head'),
    target,
    review_pin: target,
    cycle: null,
    branch: null,
    label: 'affected current files at ' + target,
    notes: [],
  });
}

// ------------------------------------------------------- push_current.prepare

export interface RepoConfig {
  readonly repo: string;
  readonly name: string;
  readonly clone: string;
  readonly defaultRef: string;
}

export interface PreparePushEffects {
  iso(): string;
  /** `repo_registry.by_repo(REPOS, item_repo(item))`; undefined when unconfigured. */
  repoConfig(item: Item): RepoConfig | undefined;
  /** `item_repo(item)`, for the refusal message. */
  itemRepo(item: Item): string;
  inScope(cfg: RepoConfig, path: string): boolean;
  revParse(ref: string, clone: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string, clone: string): Promise<boolean>;
  currentPaths(target: string, pre: string, clone: string): Promise<PathRow[]>;
  /** `_text_blob`: the blob decodes as UTF-8 and holds no NUL. */
  textBlob(clone: string, blob: string): Promise<boolean>;
  /** `_enroll`: one pending follow-up part; an existing id is kept (no-op). */
  enrollFollowup(
    q: Queue,
    cfg: RepoConfig,
    followup: {
      id: string;
      base: string;
      head: string;
      dependsOn: string;
      pathsFilter: string[];
      pin: string;
    },
  ): void;
  reviewerVersion(): Promise<string>;
  buildCurrentProjection(
    target: string,
    selected: string[],
    clone: string,
  ): Promise<{ base: string; head: string }>;
  updateRef(name: string, sha: string, clone: string): Promise<void>;
  saveQueue(queue: Queue): Promise<void>;
  writeCurrentReceipt(item: Item, outcome: 'unsupported' | 'no-current-code'): Promise<string>;
}

function rescueable(row: PathRow): boolean {
  return (
    row.disposition === 'unsupported' &&
    row.reason === SCOPE_CAP_REASON &&
    typeof row.blob === 'string' &&
    typeof row.bytes === 'number' &&
    Number.isInteger(row.bytes) &&
    row.bytes <= FILE_BYTES
  );
}

/** First sorted candidate rows that fit the 2 MiB scope, then the overflow. */
function splitScope(list: PathRow[]): { kept: PathRow[]; overflow: PathRow[] } {
  const candidates = list.filter((r) => isSelected(r) || rescueable(r));
  candidates.sort(
    (a, b) =>
      codePointCompare(str(a.path, 'path'), str(b.path, 'path')) ||
      codePointCompare(str(a.source_path, 'source_path'), str(b.source_path, 'source_path')),
  );
  const kept: PathRow[] = [];
  const overflow: PathRow[] = [];
  let total = 0;
  for (const row of candidates) {
    const bytes = row.bytes as number;
    if (total + bytes > SCOPE_BYTES) overflow.push(row);
    else {
      total += bytes;
      kept.push(row);
    }
  }
  return { kept, overflow };
}

export async function preparePushCurrent(
  q: Queue,
  item: Item,
  dry: boolean,
  fx: PreparePushEffects,
): Promise<PrepareOutcome<CurrentPlan>> {
  const subject = rec(item.subject, 'item.subject');
  if (dry) {
    return plan({
      base: '(dispatch-pin)',
      head: '(dispatch-pin)',
      target: str(subject.head, 'subject.head'),
      cycle: null,
      branch: null,
      label: 'push range (not captured)',
      notes: [],
    });
  }
  const cfg = fx.repoConfig(item);
  if (cfg === undefined) return notReady(`push item repo is not configured: ${fx.itemRepo(item)}`);
  const clone = cfg.clone;
  if (!item.capture) {
    const base = str(subject.base, 'subject.base');
    // Pinned at capture time; a follow-up part reuses its parent's target exactly.
    const target =
      (subject.pin as string | undefined) ||
      (await fx.revParse(cfg.defaultRef + '^{commit}', clone));
    if (!(await fx.isAncestor(base, target, clone)))
      return notReady('push base is not an ancestor of the repository default branch');
    let list = await fx.currentPaths(target, base, clone);
    if (subject.paths_filter) {
      const wanted = new Set(subject.paths_filter as string[]);
      list = list.filter((r) => wanted.has(str(r.path, 'path')));
    }
    for (const row of list) {
      if (!fx.inScope(cfg, str(row.path, 'path'))) {
        row.disposition = 'excluded-config';
        row.reason = `excluded by repos config for ${cfg.repo}`;
      } else if (rescueable(row) && !(await fx.textBlob(clone, str(row.blob, 'blob')))) {
        // current_paths caps before reading the blob: never let binary or
        // non-UTF-8 content into the projection through the split path.
        row.disposition = 'unsupported';
        row.reason = 'binary or non-UTF8 current blob';
      }
    }
    const { kept, overflow } = splitScope(list);
    for (const row of kept) if (!isSelected(row)) row.disposition = 'included';
    if (overflow.length > 0) {
      const id = str(item.id, 'id');
      const m = /-p(\d+)$/.exec(id);
      const n = m ? Number(m[1]) : 1;
      const followupId = id.replace(/-p\d+$/, '') + `-p${n + 1}`;
      fx.enrollFollowup(q, cfg, {
        id: followupId,
        base: str(subject.base, 'subject.base'),
        head: str(subject.head, 'subject.head'),
        dependsOn: id,
        pathsFilter: sortedPaths(overflow),
        pin: target,
      });
      for (const row of overflow) {
        row.disposition = 'deferred-split';
        row.reason = `deferred to follow-up review ${followupId} (review scope cap)`;
      }
    }
    const capture: Record<string, unknown> = {
      target,
      tree: await fx.revParse(target + '^{tree}', clone),
      paths: list,
      scope_digest: receiptJsonDigest(list),
      policy: POLICY,
      projection: PROJECTION,
      reviewer: REVIEWER,
      reviewer_version: pyPrefix((await fx.reviewerVersion()).trim(), 100),
      captured_at: fx.iso(),
    };
    capture.equivalence = currentEquivalence(capture);
    const selected = sortedPaths(kept);
    if (selected.length > 0) {
      const built = await fx.buildCurrentProjection(target, selected, clone);
      capture.base = built.base;
      capture.head = built.head;
      for (const part of ['base', 'head'] as const)
        await fx.updateRef(`refs/crq/current/${str(item.id, 'id')}/${part}`, built[part], clone);
    }
    item.capture = capture;
    await fx.saveQueue(q);
  }
  const capture = rec(item.capture, 'item.capture');
  const captured = rows(capture.paths);
  if (!captured.some(isSelected)) {
    const unsupported = captured.some(
      (r) => r.disposition === 'unsupported' || r.disposition === 'ambiguous',
    );
    const outcome = unsupported ? 'unsupported' : 'no-current-code';
    item.receipt_id = await fx.writeCurrentReceipt(item, outcome);
    item.state = outcome;
    await fx.saveQueue(q);
    return nothing;
  }
  const target = str(capture.target, 'capture.target');
  return plan({
    base: str(capture.base, 'capture.base'),
    head: str(capture.head, 'capture.head'),
    target,
    review_pin: target,
    cycle: null,
    branch: null,
    label:
      `push range ${pyPrefix(str(subject.base, 'subject.base'), 12)}..` +
      `${pyPrefix(str(subject.head, 'subject.head'), 12)} at ${pyPrefix(target, 12)}`,
    notes: [],
  });
}

// ------------------------------------------- local_review_runtime.prepare

export interface LocalReviewPlan {
  base: string;
  head: string;
  target: string;
  label: string;
  cycle: unknown;
  branch: null;
  notes: string[];
  review_pin: string;
  range_policy: 'full-range-once-v1';
  profile: unknown;
  config_digest: unknown;
}

export interface PrepareLocalReviewEffects {
  iso(): string;
  /** `repo_registry.same_repo(a, b)`. */
  sameRepo(a: string, b: string): boolean;
  /** The primary `REPO`, for the `pr.get("repo", REPO)` default. */
  readonly primaryRepo: string;
  /** `transport.clone_for(c, repo)`: an opaque clone handle. */
  cloneFor(repo: string): string;
  objectPresent(sha: string, clone: string): Promise<boolean>;
  fetch(clone: string): Promise<void>;
  /** `facts(c, base_commit, head_commit, profile, repo)`, today's re-resolved pinned facts. */
  facts(base: string, head: string, profile: unknown, repo: string): Promise<unknown>;
  /** `cycle_facts(c, pr, record_or_meta)`. */
  cycleFacts(pr: Item, record: Record<string, unknown>): Promise<unknown>;
  /** `operation.equivalent(a, b)`. */
  equivalent(a: unknown, b: unknown): boolean;
  /** `c.classify(Path(ndjson), 0)`. */
  classify(ndjson: string): Promise<Record<string, unknown>>;
  /** `complete(c, q, item, rdir, run_id, cls, completed_at, 0)`. */
  complete(
    q: Queue,
    item: Item,
    runId: string,
    cls: Record<string, unknown>,
    completedAt: string,
  ): Promise<void>;
  /** `json.loads((RUNS / run_id / "meta.json").read_text())`. */
  readMeta(runId: string): Promise<Record<string, unknown>>;
}

/** Python dict/list `==` over JSON-shaped data (bool/int cross-equality is not modelled). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null &&
    !Array.isArray(b)
  ) {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const keys = Object.keys(x);
    return (
      keys.length === Object.keys(y).length && keys.every((k) => k in y && deepEqual(x[k], y[k]))
    );
  }
  return false;
}

export async function prepareLocalReview(
  q: Queue,
  item: Item,
  dry: boolean,
  fx: PrepareLocalReviewEffects,
  opts: { completedOnly?: boolean } = {},
): Promise<PrepareOutcome<LocalReviewPlan>> {
  const wanted = rec(item.identity_inputs, 'identity_inputs');
  const wantedRepo = str(wanted.repo, 'identity_inputs.repo');
  const wantedBase = str(wanted.base_commit, 'base_commit');
  const wantedHead = str(wanted.head_commit, 'head_commit');
  if (!fx.sameRepo(wantedRepo, fx.primaryRepo)) {
    const clone = fx.cloneFor(wantedRepo);
    const present = [
      await fx.objectPresent(wantedBase, clone),
      await fx.objectPresent(wantedHead, clone),
    ];
    if (!present.every(Boolean)) await fx.fetch(clone);
  }
  // Re-resolve pinned objects/config but never today's profile flags.
  if (!deepEqual(await fx.facts(wantedBase, wantedHead, item.profile, wantedRepo), wanted))
    return notReady('pinned-local-review-facts-mismatch');
  for (const pr of q.items) {
    const prRepo = 'repo' in pr ? pr.repo : fx.primaryRepo;
    if ((pr.kind !== 'open' && pr.kind !== 'delta') || prRepo !== wantedRepo) continue;
    const cycles = Array.isArray(pr.cycles) ? (pr.cycles as Record<string, unknown>[]) : [];
    for (const record of [...cycles].reverse()) {
      const repeat =
        'repeat_requested' in item ? item.repeat_requested : (item.generation as number) > 1;
      if (repeat) continue; // an explicit repeat requires a fresh invocation
      if (record.base !== wantedBase || record.head !== wantedHead) continue;
      if (fx.equivalent(await fx.cycleFacts(pr, record), wanted)) {
        if (!dry) {
          const runId = str(record.run_id, 'run_id');
          const cls = await fx.classify(str(record.ndjson, 'ndjson'));
          if (!cls.counted || cls.outcome !== 'completed') continue;
          await fx.complete(q, item, runId, cls, (record.completed_at as string) || fx.iso());
        }
        return nothing;
      }
    }
    const run = opts.completedOnly ? null : pr.run;
    if (run) {
      const meta = await fx.readMeta(str(rec(run, 'run').run_id, 'run_id'));
      if (
        meta.base === wantedBase &&
        meta.head === wantedHead &&
        fx.equivalent(await fx.cycleFacts(pr, meta), wanted)
      )
        return notReady('equivalent-pr-review');
    }
  }
  return plan({
    base: wantedBase,
    head: wantedHead,
    target: wantedBase,
    label: 'local full-diff review',
    cycle: item.generation,
    branch: null,
    notes: [],
    review_pin: wantedBase,
    range_policy: 'full-range-once-v1',
    profile: item.profile,
    config_digest: wanted.config_digest,
  });
}

// ------------------------------------------------------------ pr_info, quiet_reason

export interface PrInfoEffects {
  /** The primary `REPO`. */
  readonly repo: string;
  /** `gh_json(args)`. */
  ghJson(args: string[]): Promise<unknown>;
}

export async function prInfo(
  pr: number,
  repo: string | undefined,
  fx: PrInfoEffects,
): Promise<Record<string, unknown>> {
  const out = await fx.ghJson([
    'pr',
    'view',
    String(pr),
    '--repo',
    repo || fx.repo,
    '--json',
    'number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt',
  ]);
  return rec(out, 'gh pr view output');
}

export interface QuietReasonEffects {
  /** `Path(repo_registry.by_repo(REPOS, item_repo(item))["clone"])`, or undefined for the primary clone. */
  cloneFor(item: Item): string | undefined;
  /** `active_agents_for(pr, branch)`; null = unknown. */
  activeAgentsFor(pr: number, branch: string): Promise<string[] | null>;
  ensureCommit(pr: number, sha: string, clone: string | undefined): Promise<boolean>;
  /** `int(git log -1 --format=%ct <sha>)` in the clone, in seconds. */
  commitTimestamp(sha: string, clone: string | undefined): Promise<number>;
  /** `parse_iso(s).timestamp()`, in seconds. */
  parseIsoSeconds(s: string): number;
  /** `time.time()`, in seconds. */
  nowSeconds(): number;
  /** `CONFIG["quiet_minutes"]`. */
  readonly quietMinutes: number;
}

/** Python `f"{x:.0f}"`: round-half-even on the exact double, `-0` kept for small negatives. */
export function formatAge(x: number): string {
  const a = Math.abs(x);
  const f = Math.floor(a);
  const d = a - f;
  const r = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
  return (x < 0 || Object.is(x, -0) ? '-' : '') + String(r);
}

export async function quietReason(
  item: Item,
  info: Record<string, unknown>,
  ignoreAge: boolean,
  fx: QuietReasonEffects,
): Promise<string | null> {
  const clone = fx.cloneFor(item);
  const pr = item.pr as number;
  const act = await fx.activeAgentsFor(pr, str(info.headRefName, 'headRefName'));
  if (act === null) return 'paseo agent list unavailable (fail closed)';
  if (act.length > 0) return 'active agent(s): ' + act.join('; ');
  if (ignoreAge) return null;
  const headOid = str(info.headRefOid, 'headRefOid');
  // Our own addressing push, and nobody else is running on it.
  if (orEmpty(item.last_push).sha === headOid) return null;
  if (!(await fx.ensureCommit(pr, headOid, clone)))
    return 'source head unavailable in repository clone';
  const ct = await fx.commitTimestamp(headOid, clone);
  const last = Math.max(ct, fx.parseIsoSeconds(str(info.updatedAt, 'updatedAt')));
  const age = (fx.nowSeconds() - last) / 60;
  if (age < fx.quietMinutes)
    return `recent activity ${formatAge(age)}m ago (< ${fx.quietMinutes}m quiet window)`;
  return null;
}
