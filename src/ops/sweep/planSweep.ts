// Sweep lane (WS-D, goal D1) — the sweep PLANNER: turn the workspace
// manifest (CONFIG-GRADE data — package discovery is the caller's business)
// plus a REQUIRED selector into work units, and each unit into exactly one
// dispatch-ready Job. The FACTORY is pure decision core: the changed-file
// listing and the ledger view both arrive through the {@link PlanSweepDeps}
// seams, the same factory-over-injected-stores idiom as the ledger and
// check-runner ops. The module also ships the REAL effects binding —
// {@link makeSubprocessSweepPlannerDeps}, the registry importer's input-
// driven binding (the worktreeFor.ts precedent of decision core + subprocess
// adapter in one family module); everything above the adapter is pure.
//
// Invariants honored here:
//   - UC §1 row 16: there is NO default selector. A missing selector is a
//     `failed` result naming the requirement — this op-level failure is the
//     loud library-level contract; the registry schema (the CLI arg-error
//     layer) mirrors it. An unknown selector mode fails the same way.
//   - UC §1 row 8 / R2 D6: when a ledger is configured the planner consults
//     the ledger view THROUGH the injected query dep. A package whose
//     baseline signatures are ALL in view.knownNoise contributes NO fix
//     units; every baseline signature in view.needsHuman is routed to the
//     report's needsHuman rows — the human routing surface — and is never
//     repackaged as an auto-fix decision.
//   - Store faults never fabricate ok: a failing ledger query or a failing
//     changed-files dep is a `failed` result — never a throw across the op
//     seam, never a plan silently built on missing evidence.
//   - Under changed-vs-base, a changed file matching no package is reported
//     as an orphan, never silently dropped: the report must account for
//     every file the dep showed it.
import { execFile } from 'node:child_process';
import { fingerprintFailure } from '../gates/fingerprint.js';
import type { CheckFailure } from '../gates/checkRunner.js';
import { makeLedgerQuery } from '../ledger/ledger.js';
import type { LedgerQueryInput, LedgerView } from '../ledger/ledger.js';
import { pathLedgerStore } from '../ledger/store.js';
import type { Job, Op, OpResult } from '../../kernel/types.js';

/**
 * The dispatch seam the phase-3 D4 plan wires: every sweep work unit becomes
 * a job running THIS op name. The planner emits jobs; the unit op executes
 * them — the name is the contract between the two.
 */
export const SWEEP_UNIT_OP = 'sweep.unit';

/** One manifest entry of the workspace — config-grade input, not discovery output. */
export interface PlanSweepPackage {
  name: string;
  /**
   * Repo-root-relative directory prefix (posix separators, as git reports
   * paths); '.' names the repo root. A single leading './' is accepted and
   * normalized; other non-normalized forms ('..' segments, trailing '/',
   * '././') are refused, and a BACKSLASH is refused outright (review-debt
   * #150: a win32-spelled path can never prefix-match git's posix output, so
   * its files would report as orphans and its jobs would never plan).
   */
  path: string;
}

/**
 * The REQUIRED scope selector — a discriminated union with no default (UC §1
 * row 16): `workspace-all` selects every manifest package, `changed-vs-base`
 * selects the packages the injected changed-file listing touches, and
 * `explicit` names manifest packages directly (unknown names fail loudly).
 */
export type PlanSweepSelector =
  | { mode: 'workspace-all' }
  | { mode: 'changed-vs-base'; base: string }
  | { mode: 'explicit'; packages: string[] };

/** The ledger the planner consults for suppression/escalation, when present. */
export interface PlanSweepLedgerConfig {
  /** Containment root, exactly as `ledger.query` reads it. */
  root: string;
  /** Path of the ledger file the query-bound store reads. */
  storePath: string;
  /** Per-call threshold overrides, forwarded verbatim to the query. */
  thresholds?: { suppressAt?: number; escalateAt?: number };
}

/** One per-package failure signature the caller derived from probes via {@link ledgerSignature}. */
export interface PlanSweepBaseline {
  package: string;
  signature: string;
}

/** JSON-serializable input of the sweep planner. */
export interface PlanSweepInput {
  /** Repository root (context for dispatch; the planner itself touches no fs). */
  repoRoot: string;
  /** The workspace manifest as given — selection never invents packages. */
  packages: PlanSweepPackage[];
  /** REQUIRED — there is no default selector (UC §1 row 16). */
  selector: PlanSweepSelector;
  /** Requested fixer labels; any non-empty set. Deduplicated, order-preserving. */
  fixers: string[];
  /** When set, the planner consults the ledger view (UC §1 row 8). */
  ledger?: PlanSweepLedgerConfig;
  /**
   * Per-package baseline signatures the caller derived from probes via
   * {@link ledgerSignature}. Inert unless `ledger` is set. Baselines naming
   * non-manifest packages are ignored ENTIRELY — no suppression role and no
   * human-routing rows.
   */
  baselineSignatures?: PlanSweepBaseline[];
  /** Known file-set per package name; a package absent here carries an empty file-set. */
  packageFiles?: Record<string, string[]>;
}

/** One work unit: fixer `fixer` applied to `package`'s `files`. */
export interface WorkUnit {
  package: string;
  fixer: string;
  files: string[];
}

/**
 * The planner's report: the plan as data. `jobs` is dispatch-ready (kernel
 * Job shape, JSON-serializable); `units` is the same work in planning terms;
 * `suppressed` and `needsHuman` are the ledger consult's auditable outcome;
 * `orphans` is present only when changed-vs-base saw files no package owns.
 */
export interface PlanSweepReport {
  jobs: Job[];
  units: WorkUnit[];
  suppressed: Array<{ package: string; reason: string }>;
  needsHuman: Array<{ package: string; signature: string }>;
  orphans?: string[];
}

/**
 * The injected-effects seam — the ONE place this module touches the world.
 * `changedFiles` lists repo-root-relative posix paths changed against a base
 * ref, each paired with its git status so deletion is selection evidence but
 * never a fixer target (review-debt #150); `queryLedger` is typically
 * `makeLedgerQuery(store)` from the ledger family. Optional only because a
 * sweep may run without a ledger: when input.ledger is set the dep is
 * REQUIRED and its absence is `failed`.
 */
export interface PlanSweepDeps {
  changedFiles: (base: string) => Promise<ChangedFile[]>;
  queryLedger?: (input: LedgerQueryInput) => Promise<OpResult<LedgerView>>;
}

/**
 * THE gates→ledger signature recipe (closes the VB2C batch finding routed to
 * D1): the drift-surviving COMPACT fingerprint of one check failure,
 * namespaced by its tool. Every `ledger.record` for a check failure MUST
 * carry THIS signature — it is the ledger identity planSweep matches against
 * `view.knownNoise` (suppression) and `view.needsHuman` (escalation). The
 * 32-bit compact form is the LEDGER identity only; gate decisions still
 * compare FULL canonical keys (fingerprintKey) — that contract is unchanged.
 *
 * `tool` is REQUIRED and non-empty: fingerprintFailure defaults a missing
 * tool to '', and a default-tool signature would let an eslint failure and a
 * vitest failure collide into one ledger row — the cross-tool trap this
 * recipe exists to close. The RangeError is a LIBRARY PRECONDITION, not an
 * op-seam throw: callers invoke this BEFORE any op boundary (it is the
 * probe→baseline derivation step), while ops themselves return OpResult and
 * never throw across the seam.
 */
export function ledgerSignature(failure: CheckFailure, tool: string): string {
  if (typeof tool !== 'string' || tool.length === 0) {
    throw new RangeError(
      "ledgerSignature: tool is required and must be a non-empty string — the fingerprint default tool ('') would collide signatures across tools",
    );
  }
  return fingerprintFailure(failure, { tool });
}

/**
 * Build the sweep planner over injected effects. Work units are the selected
 * packages × the requested fixers (a deduplicated, order-preserving set);
 * each unit becomes exactly ONE Job `{id, op: SWEEP_UNIT_OP, input: unit,
 * dependsOn: []}` whose id is the stable sanitized `sweep-<package>-<fixer>`
 * (unsafe characters fold to '-'; a sanitized collision — possible only from
 * adversarial manifest names — is disambiguated with a deterministic `-2`,
 * `-3`, … suffix, so identical input always yields identical ids).
 *
 * Selection per mode:
 *   - `workspace-all` — every manifest package; unit files come from
 *     `packageFiles` (empty file-set when absent).
 *   - `changed-vs-base` — the injected changed-file listing is mapped onto
 *     packages by LONGEST-PREFIX match of the package path (path-boundary
 *     aware: `packages/core` does not own `packages/corex/x.ts`; ties keep
 *     the first manifest entry). A package no changed file touches is not
 *     selected — there is nothing for a fixer to run on. Unit files are the
 *     mapped changed files (the diff IS this mode's file-set, superseding
 *     `packageFiles`); unmatched files are the report's sorted `orphans`.
 *   - `explicit` — every name is validated against the manifest; an unknown
 *     name is a `failed` result naming it.
 *
 * Ledger consult (only when `ledger` is set): one query produces the view.
 * A package whose baseline signatures are non-empty and ALL in knownNoise
 * contributes no fix units and is listed in `suppressed` with the reason;
 * every baseline signature in needsHuman is appended to `needsHuman` rows —
 * including for a suppressed package (the suppression skips AUTO-fix; the
 * row routes the signature to a human). A package with at least one fresh
 * signature still plans, its escalated signatures routed alongside. A
 * non-ok query result, a missing queryLedger dep with ledger configured, or
 * a thrown/rejected dep is `failed` — never a fabricated ok, never a throw
 * across the op seam. Selector absence/malformation and manifest defects
 * (duplicate names, empty fields, empty fixer set) are likewise `failed`.
 */
export function makePlanSweep(deps: PlanSweepDeps): Op<PlanSweepInput, PlanSweepReport> {
  return async (input) => {
    const fault = inputFaultOf(input);
    if (fault !== null) return { status: 'failed', error: fault };

    // Manifest paths are normalized once ('./x' → 'x', '.' = the repo root)
    // so changed-vs-base comparisons meet git's repo-root-relative paths on
    // equal terms; validation has already refused every other non-normalized
    // form.
    const manifest: PlanSweepPackage[] = input.packages.map((pkg) => ({
      ...pkg,
      path: normalizedManifestPath(pkg.path) as string,
    }));

    const byName = new Map(manifest.map((p): [string, PlanSweepPackage] => [p.name, p]));
    const fixers = [...new Set(input.fixers)];
    let selected: Array<{ pkg: PlanSweepPackage; files: string[] }>;
    let orphans: string[] = [];

    switch (input.selector.mode) {
      case 'workspace-all': {
        selected = manifest.map((pkg) => ({
          pkg,
          files: fileSetOf(pkg.name, input.packageFiles),
        }));
        break;
      }
      case 'changed-vs-base': {
        let changed: ChangedFile[];
        try {
          changed = await deps.changedFiles(input.selector.base);
        } catch (err) {
          return {
            status: 'failed',
            error: `sweep: could not list files changed against "${input.selector.base}" — ${messageOf(err)}`,
          };
        }
        // Deletion is SELECTION evidence but never a fixer target
        // (review-debt #150): a 'D' path — and the SOURCE side of a rename —
        // selects its package, yet is filtered from the unit's file-set
        // because a fixer cannot open a path the working tree no longer has.
        const fileSets = new Map<string, string[]>();
        const touched = new Set<string>();
        for (const change of changed) {
          const pkg = longestPrefixPackage(change.path, manifest);
          if (pkg === undefined) {
            orphans.push(change.path);
            continue;
          }
          touched.add(pkg.name);
          if (change.deleted) continue;
          const bucket = fileSets.get(pkg.name);
          if (bucket === undefined) fileSets.set(pkg.name, [change.path]);
          else bucket.push(change.path);
        }
        selected = manifest.flatMap((pkg) => {
          if (!touched.has(pkg.name)) return [];
          return [{ pkg, files: fileSets.get(pkg.name) ?? [] }];
        });
        break;
      }
      case 'explicit': {
        const names = [...new Set(input.selector.packages)];
        const unknown = names.filter((n) => !byName.has(n));
        if (unknown.length > 0) {
          return {
            status: 'failed',
            error: `sweep: explicit selector names unknown package(s): ${unknown.join(', ')} — the manifest is the only selection universe`,
          };
        }
        selected = names.flatMap((n) => {
          const pkg = byName.get(n);
          return pkg === undefined ? [] : [{ pkg, files: fileSetOf(n, input.packageFiles) }];
        });
        break;
      }
      default: {
        return {
          status: 'failed',
          error: `sweep: unknown selector mode ${JSON.stringify((input.selector as { mode?: unknown }).mode)} — valid modes: workspace-all, changed-vs-base, explicit; there is NO default selector`,
        };
      }
    }

    const baselinesByPackage = new Map<string, string[]>();
    for (const baseline of input.baselineSignatures ?? []) {
      const signatures = baselinesByPackage.get(baseline.package);
      if (signatures === undefined) baselinesByPackage.set(baseline.package, [baseline.signature]);
      else if (!signatures.includes(baseline.signature)) signatures.push(baseline.signature);
    }

    let knownNoise: string[] = [];
    let humanSignatures: string[] = [];
    if (input.ledger !== undefined) {
      if (deps.queryLedger === undefined) {
        return {
          status: 'failed',
          error:
            'sweep: ledger is configured but the queryLedger dependency was not provided — the planner never reads a ledger store itself',
        };
      }
      const queryInput: LedgerQueryInput =
        input.ledger.thresholds === undefined
          ? { root: input.ledger.root, storePath: input.ledger.storePath }
          : {
              root: input.ledger.root,
              storePath: input.ledger.storePath,
              thresholds: input.ledger.thresholds,
            };
      let view: OpResult<LedgerView>;
      try {
        view = await deps.queryLedger(queryInput);
      } catch (err) {
        return { status: 'failed', error: `sweep: the ledger query threw — ${messageOf(err)}` };
      }
      if (view.status !== 'ok') {
        const detail =
          view.status === 'failed'
            ? view.error
            : view.status === 'indeterminate'
              ? view.detail
              : view.status === 'needs-human'
                ? view.reason
                : 'no detail reported';
        return {
          status: 'failed',
          error: `sweep: the ledger query returned ${view.status} instead of a view — ${detail}`,
        };
      }
      knownNoise = view.value.knownNoise;
      humanSignatures = view.value.needsHuman;
    }

    // needsHuman routing is SELECTOR-INDEPENDENT (fresh#3): every
    // view.needsHuman signature some MANIFEST package baselines routes to
    // the report's rows, whether or not the selector selected that package
    // — a changed-vs-base sweep must not silently drop an escalated package
    // just because no changed file touches it. Baselines naming
    // non-manifest packages are ignored ENTIRELY (no suppression role, no
    // human-routing rows): a human must never be routed to a package the
    // manifest does not define. Suppression is unchanged.
    const needsHuman: Array<{ package: string; signature: string }> = [];
    if (input.ledger !== undefined) {
      for (const [pkgName, signatures] of baselinesByPackage) {
        if (!byName.has(pkgName)) continue;
        for (const signature of signatures) {
          if (humanSignatures.includes(signature)) {
            needsHuman.push({ package: pkgName, signature });
          }
        }
      }
    }

    const units: WorkUnit[] = [];
    const jobs: Job[] = [];
    const suppressed: Array<{ package: string; reason: string }> = [];
    const usedIds = new Set<string>();
    for (const { pkg, files } of selected) {
      const signatures = baselinesByPackage.get(pkg.name);
      if (input.ledger !== undefined && signatures !== undefined && signatures.length > 0) {
        if (signatures.every((s) => knownNoise.includes(s))) {
          suppressed.push({
            package: pkg.name,
            reason: `all ${signatures.length} baseline signature(s) are known ledger noise`,
          });
          continue;
        }
      }
      for (const fixer of fixers) {
        const unit: WorkUnit = { package: pkg.name, fixer, files };
        units.push(unit);
        jobs.push({
          id: nextJobId(pkg.name, fixer, usedIds),
          op: SWEEP_UNIT_OP,
          input: unit,
          dependsOn: [],
        });
      }
    }

    const report: PlanSweepReport =
      orphans.length === 0
        ? { jobs, units, suppressed, needsHuman }
        : { jobs, units, suppressed, needsHuman, orphans: [...orphans].sort() };
    return { status: 'ok', value: report };
  };
}

/**
 * Library-level input contract: everything checkable without an injected
 * effect, each violation a `failed` message naming the requirement. The
 * registry schema (next slice) mirrors these bounds for JSON dispatch; the
 * op-level check keeps the library contract loud without any schema.
 */
function inputFaultOf(input: PlanSweepInput): string | null {
  if (typeof input.repoRoot !== 'string' || input.repoRoot === '') {
    return 'sweep: repoRoot must be a non-empty string';
  }
  // SHAPE guards over typed fields: these values are reachable from an
  // untyped caller past any schema (the ledger boundary's lengthFaultOf
  // precedent — a malformed library input is a `failed` result, never an
  // escaping TypeError from iterating a non-array or reading a null).
  if (!Array.isArray(input.packages)) {
    return 'sweep: packages must be an array of manifest entries';
  }
  const seen: string[] = [];
  for (const [index, pkg] of input.packages.entries()) {
    // A null/garbage ELEMENT is reachable from an untyped caller too — the
    // fault names the index so the manifest defect is locatable.
    if (pkg === null || typeof pkg !== 'object') {
      return `sweep: packages[${String(index)}] must be a manifest entry with a non-empty name and path`;
    }
    if (
      typeof pkg.name !== 'string' ||
      pkg.name === '' ||
      typeof pkg.path !== 'string' ||
      pkg.path === ''
    ) {
      return `sweep: packages[${String(index)}] must have a non-empty name and path`;
    }
    if (pkg.path.includes('\\')) {
      return `sweep: packages[${String(index)}] path '${pkg.path}' contains a backslash — manifest paths are repo-root-relative POSIX (git reports posix separators); a backslash cannot be safely reinterpreted as a separator on posix or as a literal on win32, so the entry can never prefix-match git's output`;
    }
    if (normalizedManifestPath(pkg.path) === null) {
      return `sweep: packages[${String(index)}] path '${pkg.path}' must be a normalized repo-root-relative posix path — an optional leading './' is normalized; '..' segments, empty segments, trailing '/' and backslashes are refused`;
    }
    if (seen.includes(pkg.name)) {
      return `sweep: duplicate package name in the manifest: ${pkg.name}`;
    }
    seen.push(pkg.name);
  }
  if (!Array.isArray(input.fixers) || input.fixers.length === 0) {
    return 'sweep: fixers must be a non-empty set of requested fixer labels';
  }
  if (input.fixers.some((fixer) => typeof fixer !== 'string' || fixer === '')) {
    return 'sweep: every requested fixer label must be a non-empty string';
  }
  if (input.baselineSignatures !== undefined) {
    if (!Array.isArray(input.baselineSignatures)) {
      return 'sweep: baselineSignatures must be an array of {package, signature} entries';
    }
    for (const [index, baseline] of input.baselineSignatures.entries()) {
      // Element shape, mirroring the packages guard: a null/garbage entry
      // reachable from an untyped caller is a `failed` result naming the
      // index, never a TypeError at the package/signature reads.
      if (baseline === null || typeof baseline !== 'object') {
        return `sweep: baselineSignatures[${String(index)}] must be a {package, signature} entry with non-empty strings`;
      }
      if (
        typeof baseline.package !== 'string' ||
        baseline.package === '' ||
        typeof baseline.signature !== 'string' ||
        baseline.signature === ''
      ) {
        return `sweep: baselineSignatures[${String(index)}] must carry a non-empty package and signature`;
      }
    }
  }
  if (
    input.selector === undefined ||
    input.selector === null ||
    typeof input.selector !== 'object'
  ) {
    return 'sweep: selector is required — pass one of {mode:"workspace-all"}, {mode:"changed-vs-base",base}, {mode:"explicit",packages}; there is NO default selector (UC §1 row 16)';
  }
  if (input.selector.mode === 'changed-vs-base') {
    if (typeof input.selector.base !== 'string' || input.selector.base === '') {
      return 'sweep: changed-vs-base requires a non-empty base ref';
    }
    // The base lands verbatim in `git diff --name-status -z <base> --` — a
    // dash-leading ref would be parsed as an OPTION before the trailing
    // `--` terminator ever applies (see the
    // makeSubprocessSweepPlannerDeps JSDoc for the two different `--`
    // traps).
    if (input.selector.base.startsWith('-')) {
      return `sweep: changed-vs-base base '${input.selector.base}' must not start with '-' — it is a positional git argument, never a flag`;
    }
  }
  if (input.selector.mode === 'explicit') {
    if (!Array.isArray(input.selector.packages)) {
      return 'sweep: explicit selector requires a packages array';
    }
    // Aligned with the registry schema's min(1): an empty explicit scope is
    // a misconfiguration, not an honest empty sweep.
    if (input.selector.packages.length === 0) {
      return 'sweep: explicit selector requires at least one package — an empty explicit scope plans nothing and hides the misconfiguration';
    }
    if (input.selector.packages.some((name) => typeof name !== 'string' || name === '')) {
      return 'sweep: explicit selector package names must be non-empty strings';
    }
  }
  if (input.packageFiles !== undefined) {
    if (input.packageFiles === null || typeof input.packageFiles !== 'object') {
      return 'sweep: packageFiles must be an object mapping package names to file arrays';
    }
    for (const [name, files] of Object.entries(input.packageFiles)) {
      if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || file === '')) {
        return `sweep: packageFiles['${name}'] must be an array of non-empty path strings`;
      }
    }
  }
  if (input.ledger !== undefined) {
    if (input.ledger === null || typeof input.ledger !== 'object') {
      return 'sweep: ledger must be an object with a non-empty root and storePath — the query-bound store is built from them';
    }
    if (
      typeof input.ledger.root !== 'string' ||
      input.ledger.root === '' ||
      typeof input.ledger.storePath !== 'string' ||
      input.ledger.storePath === ''
    ) {
      return 'sweep: ledger requires a non-empty root and storePath — the query-bound store is built from them';
    }
  }
  return null;
}

/** The known file-set for a package name; an absent entry is an empty file-set. */
function fileSetOf(name: string, packageFiles?: Record<string, string[]>): string[] {
  // OWNERSHIP check (jFLC3): a package literally named 'constructor' or
  // 'toString' would otherwise inherit the Object.prototype member as its
  // file-set — a function would land in unit.files and break the report's
  // JSON losslessness. Only an OWN property counts.
  if (packageFiles === undefined || !Object.hasOwn(packageFiles, name)) {
    return [];
  }
  return packageFiles[name] ?? [];
}

/**
 * Manifest paths are REPO-ROOT-RELATIVE posix — matching how git reports
 * changed-file paths. A single leading './' is semantically identical and
 * is normalized honestly ('./packages/core' → 'packages/core'), and '.'
 * names the repo root (the round-1 root-package rule); anything else
 * non-normalized — '..' segments, empty segments, a trailing '/', '././' —
 * returns null (the caller refuses).
 */
function normalizedManifestPath(path: string): string | null {
  if (path === '.') return '.';
  // A backslash is REFUSED, not converted (the worktreeFor
  // baselineCacheDirs rule): on posix it is a legal filename character and on
  // win32 it is a separator, so reinterpreting it either way is unsafe.
  if (path.includes('\\')) return null;
  let candidate = path;
  if (candidate.startsWith('./')) candidate = candidate.slice(2);
  if (
    candidate === '' ||
    candidate.endsWith('/') ||
    candidate.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return candidate;
}

/**
 * LONGEST-PREFIX package match of a repo-relative posix file path,
 * path-boundary aware: a package owns its path exactly and everything under
 * `path + '/'` — never a sibling sharing a string prefix (`packages/core`
 * does not own `packages/corex/x.ts`). A package whose path is `.` names the
 * REPO ROOT: it owns every repo-relative file with prefix length 0, so any
 * real directory prefix outranks it in the longest-prefix match. Ties (two
 * manifest entries with the same path — a manifest defect short of a
 * duplicate name) keep the FIRST entry, so the mapping is stable under
 * manifest reordering only where the data is genuinely ambiguous.
 */
function longestPrefixPackage(
  file: string,
  packages: readonly PlanSweepPackage[],
): PlanSweepPackage | undefined {
  let best: PlanSweepPackage | undefined;
  let bestLength = -1;
  for (const pkg of packages) {
    const dir = pkg.path.replace(/\/+$/, '');
    const isRoot = dir === '.';
    const owned = isRoot || file === dir || file.startsWith(`${dir}/`);
    if (owned) {
      const prefixLength = isRoot ? 0 : dir.length;
      if (prefixLength > bestLength) {
        best = pkg;
        bestLength = prefixLength;
      }
    }
  }
  return best;
}

/**
 * Stable, sanitized job id `sweep-<package>-<fixer>`: runs of characters
 * outside `[A-Za-z0-9._-]` fold to '-'. A sanitized collision (possible only
 * from adversarial names like `a/b`+`c` vs `a`+`b/c`) is disambiguated with
 * a deterministic `-2`, `-3`, … suffix — identical input always yields
 * identical ids, and two jobs never share one.
 */
function nextJobId(pkg: string, fixer: string, used: Set<string>): string {
  const base = `sweep-${sanitizedIdPart(pkg)}-${sanitizedIdPart(fixer)}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${String(n)}`;
  used.add(id);
  return id;
}

/** fold to '-' every run of characters a job id may not carry */
function sanitizedIdPart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Generous capture ceiling — a big diff listing must not truncate into a fake empty diff. */
const SWEEP_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * The default wall-clock cap for one git subprocess (the checkRunner's
 * 600_000ms registry default): a hung git surfaces as a REJECTION naming
 * the timeout — never an eternal await; the child is SIGKILLed.
 */
const SWEEP_GIT_TIMEOUT_MS = 600_000;

/**
 * The argv of the changed-file listing: `git diff --name-status -z <base> --`.
 * STATUS-aware since review-debt #150: `--name-only` emitted the pathname of
 * a DELETED file, which the planner then put into a unit's file-set — a
 * fixer cannot open a path the working tree no longer has. `--name-status`
 * pairs each path (and each side of a rename/copy) with its status letter so
 * deletion stays selection evidence without becoming a fixer target.
 *
 * The TRAILING `--` is a REV-LIST terminator — `base` stays a REVISION and
 * the empty tail means "all paths" — and it exists because a tracked file
 * spelled exactly like the base ref would otherwise die with "ambiguous
 * argument: both revision and filename" (exit 128). It is NOT the pathspec
 * form `-- <base>`: there the base would land AFTER the terminator and be
 * silently read as a PATH — the two traps are different, and both are why
 * the op boundary additionally rejects a dash-leading base outright (a
 * dash-leading value is parsed as an OPTION before any terminator applies).
 */
export function changedFilesArgs(base: string): string[] {
  return ['diff', '--name-status', '-z', base, '--'];
}

/**
 * One entry of the changed-file listing: a repo-root-relative posix path
 * with the git status code(s) it was reported under and whether the path
 * still exists in the working tree. A rename/copy record yields TWO entries
 * (source then destination); the SOURCE of a rename is `deleted: true` (the
 * rename removed it), the destination is not. Selection maps EVERY entry's
 * path onto packages (a rename touches both sides); only non-deleted entries
 * enter a unit's fixer file-set (review-debt #150).
 */
export interface ChangedFile {
  /** Repo-root-relative posix path. */
  path: string;
  /** The git status code ('M', 'A', 'D', 'R100', 'C75', …). */
  status: string;
  /** True when the path no longer exists in the working tree (a 'D' record, or the source side of a rename). */
  deleted: boolean;
}

/**
 * Parse `git diff --name-status -z` output into {@link ChangedFile} entries.
 * Records are `STATUS NUL path [NUL path2] NUL`; an R/C (rename/copy) record
 * carries the OLD then the NEW path — the old side of an R is DELETED, the
 * old side of a C still exists. NUL-delimited (`-z`) so filenames with
 * spaces, quotes, or newlines survive intact; empty entries from the trailing
 * NUL are dropped. This REPLACES the old name-only parser (review-debt #150):
 * the name-only contract silently admitted deleted paths into fixer
 * file-sets.
 */
export function parseNullDelimitedChangedFiles(text: string): ChangedFile[] {
  const tokens = text.split('\0');
  const files: ChangedFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index] as string;
    index += 1;
    if (status === '') continue; // trailing NUL / empty entry
    if (/^[RC]/.test(status)) {
      const source = tokens[index] as string | undefined;
      index += 1;
      const destination = tokens[index] as string | undefined;
      index += 1;
      if (source !== undefined && source !== '') {
        files.push({ path: source, status, deleted: status.startsWith('R') });
      }
      if (destination !== undefined && destination !== '') {
        files.push({ path: destination, status, deleted: false });
      }
      continue;
    }
    const path = tokens[index] as string | undefined;
    index += 1;
    if (path !== undefined && path !== '') {
      files.push({ path, status, deleted: status.startsWith('D') });
    }
  }
  return files;
}

/**
 * Auto-maintenance suppression, copied VERBATIM from the worktreeFor
 * sibling's runGit (its GIT_NO_AUTO_MAINTENANCE const and prepend — the
 * proven treatment for the detached background `gc --auto` /
 * `maintenance run --auto` hang class that inherits our stdio pipes).
 */
const GIT_NO_AUTO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

/**
 * Map an execFile failure onto the planner's git fault taxonomy. execFile
 * sets `killed` for BOTH the timeout SIGKILL and a maxBuffer overflow — and
 * the overflow's message names 'maxBuffer' — so that signature branches
 * FIRST and the failure names the right mechanism (an output limit is not a
 * timeout). Exported for the fault-mapping pins; runSweepGit is the only
 * production call site.
 */
export function mapSweepGitFault(
  args: string[],
  error: { message: string; killed?: boolean | null; code?: unknown },
  stderr: string,
  timeoutMs: number,
): Error {
  const name = `git ${args[0] ?? 'git'}`;
  if (error.message.includes('maxBuffer')) {
    return new Error(
      `${name} exceeded the output limit (maxBuffer ${String(SWEEP_GIT_MAX_BUFFER_BYTES)} bytes) — the listing is too large to map; narrow the diff base`,
      { cause: error },
    );
  }
  if (error.killed === true) {
    return new Error(
      `${name} timed out after ${String(timeoutMs)}ms and was SIGKILLed — the git call never produced evidence`,
      { cause: error },
    );
  }
  const exit = typeof error.code === 'number' ? ` (exit ${String(error.code)})` : '';
  return new Error(
    `${name}${exit} failed — ${stderr.trim() !== '' ? stderr.trim() : error.message}`,
    { cause: error },
  );
}

/**
 * Run git with an execFile ARGS ARRAY — never a shell string, so no config
 * value can be re-parsed as shell syntax (the repo's tooling convention).
 * A non-zero exit, a spawn failure, or a run exceeding the timeout
 * (SIGKILL) rejects with the captured stderr text.
 */
function runSweepGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_NO_AUTO_MAINTENANCE, ...args],
      {
        cwd,
        maxBuffer: SWEEP_GIT_MAX_BUFFER_BYTES,
        timeout: SWEEP_GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(mapSweepGitFault(args, error, stderr, SWEEP_GIT_TIMEOUT_MS));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * The REAL effects binding of the sweep planner (the registry importer's
 * input-driven binding): the changed-file listing runs the
 * {@link changedFilesArgs} argv — `git diff --name-status -z <base> --`,
 * the trailing `--` a REV-LIST terminator (see that JSDoc for the two
 * different `--` traps) — bound to the DISPATCHED input's repoRoot, and the
 * ledger view consults the ledger family's own store — `makeLedgerQuery`
 * over the containment-checked {@link pathLedgerStore}, with root +
 * storePath crossing the plain-JSON boundary from the query input. Both
 * effects are lazy per call; a library consumer injects fakes instead
 * (every decision test does exactly that).
 *
 * FLAG-INJECTION BOUNDARY: the trailing `--` terminator cannot protect a
 * dash-leading base — git parses OPTION-class arguments before it, so
 * `-X`-shaped values would still be consumed as options. The mechanism for
 * that class is (1) the op boundary rejecting a dash-leading base as a
 * `failed` result (inputFaultOf), and (2) execFile with an ARGS ARRAY — no
 * shell parsing, so no value can become shell syntax. A caller bypassing
 * both reaches the library-level contract the same way it reaches every
 * other malformed input: this adapter trusts the seam the way the ledger
 * ops trust the store contract.
 */
export function makeSubprocessSweepPlannerDeps(repoRoot: string): PlanSweepDeps {
  return {
    changedFiles: (base: string) =>
      runSweepGit(changedFilesArgs(base), repoRoot).then(parseNullDelimitedChangedFiles),
    queryLedger: (input: LedgerQueryInput) =>
      makeLedgerQuery((i) => pathLedgerStore(i.root, i.storePath))(input),
  };
}
