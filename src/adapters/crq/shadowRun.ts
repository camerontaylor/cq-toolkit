/**
 * Read-only shadow-run harness for the CRQ tick and slot (plan: docs/crq/shadow-run-plan.md).
 * Inactive: nothing imports this module. It freezes a state root into two scratch copies, proves
 * the live root was not touched, and compares the artefacts the Python and TypeScript sides left
 * behind. `runComposedShadow` also drives both sides, but only through runners the caller injects;
 * this module spawns nothing and imports neither implementation.
 *
 * Safety: the live root is opened for reading only (`readFileSync`),
 * never locked and never written. The pre/post `queue.json` digest is the abort signal.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JsonValue } from '../../policy/crq/jsonValue.js';
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../policy/crq/ledger.js';

/** The state-root files a tick or slot reads or leaves behind. */
export const SHADOW_FILES = [
  'queue.json',
  'config.json',
  'runner-disabled',
  'events.jsonl',
  'heartbeat.json',
] as const;

export const PINNED_AT = '<pinned>';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Digest of the live `queue.json`, or null when it is absent. Read-only. */
export function liveQueueDigest(liveRoot: string): string | null {
  const path = join(liveRoot, 'queue.json');
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

export interface FrozenInput {
  /** The copy the Python side runs against. */
  readonly a: string;
  /** The byte-identical copy the TypeScript side runs against. */
  readonly b: string;
  /** The live `queue.json` digest at freeze time. */
  readonly liveDigest: string | null;
}

/** Absolute path with symlinks resolved, including the part that does not exist yet. */
function resolvedPath(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    current = parent;
  }
  return resolve(realpathSync.native(current), relative(current, absolute));
}

/** True when `target` is `root` itself or lies beneath it. */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Refuse scratch destinations that overlap the live root, comparing resolved paths so symlinked
 * or `.`/`..` aliases cannot slip through. `writeFileSync` replaces existing contents, so writing
 * into a directory that aliases the live root would clobber live state; the live root is read-only.
 */
function rejectLiveOverlap(liveRoot: string, destinations: readonly string[]): void {
  const live = resolvedPath(liveRoot);
  for (const destination of destinations) {
    const target = resolvedPath(destination);
    if (isWithin(live, target) || isWithin(target, live)) {
      throw new Error(
        `scratch destination ${target} overlaps the live root ${live}; refusing to write`,
      );
    }
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Copy the live state root into `<scratch>/a` and `<scratch>/b`; the source is only read. */
export function freezeStateRoot(liveRoot: string, scratch: string): FrozenInput {
  const a = join(scratch, 'a');
  const b = join(scratch, 'b');
  rejectLiveOverlap(liveRoot, [a, b]);
  const liveDigest = liveQueueDigest(liveRoot);
  // Capture each live file once, so both copies come from one consistent snapshot.
  const captured = SHADOW_FILES.map((name) => {
    const source = join(liveRoot, name);
    return { name, bytes: existsSync(source) ? readFileSync(source) : null };
  });
  for (const dir of [a, b]) {
    mkdirSync(dir, { recursive: true });
    // Refuse symlinks at every destination before the first write, so a link planted in a reused
    // scratch directory cannot redirect a copy onto live state.
    for (const { name } of captured) {
      const target = join(dir, name);
      if (lstatOrNull(target)?.isSymbolicLink()) {
        throw new Error(`scratch destination ${target} is a symbolic link; refusing to write`);
      }
    }
    for (const { name, bytes } of captured) {
      const target = join(dir, name);
      // Preserve absence: a retained destination file must not survive when the live one is absent,
      // or the two copies would start from different inputs. Replace stale files, then create
      // exclusively ('wx') so the write can never follow a link that appeared meanwhile.
      if (existsSync(target)) unlinkSync(target);
      if (bytes !== null) writeFileSync(target, bytes, { flag: 'wx' });
    }
  }
  return { a, b, liveDigest };
}

/** True when the live `queue.json` is byte-identical to what was frozen. */
export function liveUnchanged(liveRoot: string, frozen: FrozenInput): boolean {
  return liveQueueDigest(liveRoot) === frozen.liveDigest;
}

export type FileVerdict = 'same' | 'differs' | 'missing-a' | 'missing-b';

export interface ShadowDiff {
  readonly queue: FileVerdict;
  /** Composed runs only: the extra state-root artefacts and the tick log. */
  readonly composed?: ComposedVerdicts;
  /** `events.jsonl`: first differing line (1-based) when it differs. */
  readonly events: { readonly verdict: FileVerdict; readonly line?: number };
  readonly heartbeat: FileVerdict;
  readonly phaseCalls: 'same' | 'differs';
  readonly slotDecision: 'same' | 'differs';
}

/** What only a composed-phase run leaves behind (`crq.tick` writes these; the plan never does). */
export const COMPOSED_FILES = ['status.json', 'status.md', 'next-review-at'] as const;

export interface ComposedVerdicts {
  readonly files: Readonly<Record<(typeof COMPOSED_FILES)[number], FileVerdict>>;
  /** The returned tick log, compared line by line. */
  readonly log: 'same' | 'differs';
}

export interface Artefacts {
  readonly root: string;
  /** Ordered phase calls the implementation made (recorded by the caller's stubs). */
  readonly phaseCalls: readonly string[];
  /** The slot lock or early-exit decision, e.g. the runner-disabled or queue-changed log. */
  readonly slotDecision: string;
}

function readOptional(path: string): Uint8Array | null {
  return existsSync(path) ? readFileSync(path) : null;
}

function presence(a: Uint8Array | null, b: Uint8Array | null): FileVerdict | null {
  if (a === null && b === null) return 'same';
  if (a === null) return 'missing-a';
  if (b === null) return 'missing-b';
  return null;
}

/** `queue.json` by value: key order ignored, `1 == 1.0`. */
function compareQueue(a: Uint8Array | null, b: Uint8Array | null): FileVerdict {
  const absent = presence(a, b);
  if (absent) return absent;
  return ledgerValueEqual(
    parseJsonValue(new TextDecoder().decode(a as Uint8Array), { duplicates: 'error' }),
    parseJsonValue(new TextDecoder().decode(b as Uint8Array), { duplicates: 'error' }),
  )
    ? 'same'
    : 'differs';
}

/** An instant as text that keeps fractional digits beyond the milliseconds `Date.parse` drops. */
function instantKey(value: string): string {
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)$/i.exec(value);
  const base = match ? Date.parse(`${match[1]}${match[3]}`) : Date.parse(value);
  const fraction = match?.[2] ? match[2].replace(/0+$/, '') : '';
  return `${base}.${fraction}`;
}

/** Replace an `at` that denotes the pinned instant, so only real clock drift shows. */
function normaliseEvent(line: string, pinnedAt: string): JsonValue {
  const value = parseJsonValue(line);
  if (!(value instanceof JsonObject)) return value;
  const pinned = instantKey(pinnedAt);
  return new JsonObject(
    value.entries.map(([key, entry]) =>
      key === 'at' && typeof entry === 'string' && instantKey(entry) === pinned
        ? [key, PINNED_AT]
        : [key, entry],
    ),
  );
}

function compareEvents(
  a: Uint8Array | null,
  b: Uint8Array | null,
  pinnedAt: string,
): ShadowDiff['events'] {
  const absent = presence(a, b);
  if (absent) return { verdict: absent };
  const lines = (bytes: Uint8Array): string[] =>
    new TextDecoder()
      .decode(bytes)
      .split('\n')
      .filter((line) => line !== '');
  const left = lines(a as Uint8Array);
  const right = lines(b as Uint8Array);
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined || r === undefined) return { verdict: 'differs', line: i + 1 };
    if (!ledgerValueEqual(normaliseEvent(l, pinnedAt), normaliseEvent(r, pinnedAt)))
      return { verdict: 'differs', line: i + 1 };
  }
  return { verdict: 'same' };
}

function compareBytes(a: Uint8Array | null, b: Uint8Array | null): FileVerdict {
  const absent = presence(a, b);
  if (absent) return absent;
  return Buffer.compare(Buffer.from(a as Uint8Array), Buffer.from(b as Uint8Array)) === 0
    ? 'same'
    : 'differs';
}

/** Compare the artefacts of the two runs (not their logs). `pinnedAt` is the injected clock. */
export function compareArtefacts(a: Artefacts, b: Artefacts, pinnedAt: string): ShadowDiff {
  const read = (artefacts: Artefacts, name: string): Uint8Array | null =>
    readOptional(join(artefacts.root, name));
  return {
    queue: compareQueue(read(a, 'queue.json'), read(b, 'queue.json')),
    events: compareEvents(read(a, 'events.jsonl'), read(b, 'events.jsonl'), pinnedAt),
    heartbeat: compareBytes(read(a, 'heartbeat.json'), read(b, 'heartbeat.json')),
    phaseCalls:
      a.phaseCalls.length === b.phaseCalls.length &&
      a.phaseCalls.every((c, i) => c === b.phaseCalls[i])
        ? 'same'
        : 'differs',
    slotDecision: a.slotDecision === b.slotDecision ? 'same' : 'differs',
  };
}

/**
 * `compareArtefacts` plus the composed-run artefacts. `status.json` is compared by value like the
 * queue; `status.md` and `next-review-at` by bytes, so a drifting timestamp or word shows.
 */
export function compareComposedArtefacts(
  a: Artefacts,
  b: Artefacts,
  pinnedAt: string,
  logs: { readonly a: readonly string[]; readonly b: readonly string[] },
): ShadowDiff {
  const read = (artefacts: Artefacts, name: string): Uint8Array | null =>
    readOptional(join(artefacts.root, name));
  return {
    ...compareArtefacts(a, b, pinnedAt),
    composed: {
      files: {
        'status.json': compareBytes(read(a, 'status.json'), read(b, 'status.json')),
        'status.md': compareBytes(read(a, 'status.md'), read(b, 'status.md')),
        'next-review-at': compareBytes(read(a, 'next-review-at'), read(b, 'next-review-at')),
      },
      log:
        logs.a.length === logs.b.length && logs.a.every((line, i) => line === logs.b[i])
          ? 'same'
          : 'differs',
    },
  };
}

export const identical = (diff: ShadowDiff): boolean =>
  (diff.composed === undefined ||
    (diff.composed.log === 'same' &&
      COMPOSED_FILES.every((name) => diff.composed?.files[name] === 'same'))) &&
  diff.queue === 'same' &&
  diff.events.verdict === 'same' &&
  diff.heartbeat === 'same' &&
  diff.phaseCalls === 'same' &&
  diff.slotDecision === 'same';

/** An allow-list entry for a known, explained divergence. */
export interface ExplainedDivergence {
  readonly id: string;
  readonly explains: (diff: ShadowDiff) => boolean;
}

export type SampleClass = 'identical' | 'explained' | 'unexplained' | 'aborted';

export interface SampleReport {
  readonly sample: string;
  readonly class: SampleClass;
  readonly explainedBy?: string;
  readonly diff?: ShadowDiff;
}

/** Classify one sample; a changed live queue aborts it regardless of the diff. */
export function classifySample(
  sample: string,
  diff: ShadowDiff,
  liveWasUnchanged: boolean,
  allowList: readonly ExplainedDivergence[],
): SampleReport {
  if (!liveWasUnchanged) return { sample, class: 'aborted' };
  if (identical(diff)) return { sample, class: 'identical', diff };
  const match = allowList.find((entry) => entry.explains(diff));
  return match
    ? { sample, class: 'explained', explainedBy: match.id, diff }
    : { sample, class: 'unexplained', diff };
}

export interface ShadowSummary {
  readonly identical: number;
  readonly explained: number;
  readonly unexplained: number;
  readonly aborted: number;
}

export function summarize(reports: readonly SampleReport[]): ShadowSummary {
  const count = (kind: SampleClass): number => reports.filter((r) => r.class === kind).length;
  return {
    identical: count('identical'),
    explained: count('explained'),
    unexplained: count('unexplained'),
    aborted: count('aborted'),
  };
}

/** The gap rows a composed run left open (`composeFullTick`'s `unbound` and `staged`). */
export interface ComposedGaps {
  readonly complete: boolean;
  readonly unbound: readonly string[];
  readonly staged: readonly string[];
}

export interface ComposedRunResult {
  /** The tick's returned log lines. */
  readonly log: readonly string[];
  /** Ordered calls to the stubbed (unbound) effects, recorded by the runner. */
  readonly phaseCalls: readonly string[];
  /** The TS side reports its composition's open rows; the Python side has none. */
  readonly gaps?: ComposedGaps;
}

/** Runs one implementation's whole tick over a frozen copy and resolves when it is done. */
export type ComposedRunner = (root: string) => Promise<ComposedRunResult>;

/**
 * Live-root entries a composed sample may hold besides `SHADOW_FILES`: outputs the tick overwrites
 * without reading them (`status.json`, `status.md`, `next-review-at`) and the lock file. Any other
 * entry (`backfill-rollout.json`, `ledger`, `runs`, `receipts`, `reconcile`, `backfill/findings`
 * and whatever is added later) is an input the composed phases may read and the freeze does not
 * copy: both sides would run with that phase silently switched off and still report `identical`,
 * so the sample is refused (default-deny).
 */
export const COMPOSED_HARMLESS_ENTRIES: readonly string[] = [
  'status.json',
  'status.md',
  'next-review-at',
  'tick.lock',
];

export interface ComposedShadowOptions {
  readonly liveRoot: string;
  readonly scratch: string;
  readonly pinnedAt: string;
  readonly sample: string;
  /** Runs Python's `crq.tick` against copy `a`. Injected: this module never spawns it. */
  readonly python: ComposedRunner;
  /** Runs the TS composed `runTick` against copy `b`. */
  readonly ts: ComposedRunner;
  readonly allowList?: readonly ExplainedDivergence[];
}

export interface ComposedShadowReport {
  readonly report: SampleReport;
  readonly python: ComposedRunResult;
  readonly ts: ComposedRunResult;
  /** False while the TS composition has an open `unbound` or `staged` row; never silently true. */
  readonly complete: boolean;
  /** Every open row id, so a clean diff never reads as "the whole tick is shadowed". */
  readonly openRows: readonly string[];
}

/**
 * The composed-phase shadow: freeze the live root into two byte-identical copies, run Python's
 * `tick` on `a` and the composed TS tick on `b` (both injected, serially, so a fault on one side
 * cannot be mistaken for the other), then compare the state-root artefacts. The live root is only
 * read: it is digested before and after, and a change aborts the sample.
 */
export async function runComposedShadow(
  options: ComposedShadowOptions,
): Promise<ComposedShadowReport> {
  const allowed = new Set<string>([...SHADOW_FILES, ...COMPOSED_HARMLESS_ENTRIES]);
  const strays = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => !allowed.has(name))
          .sort()
      : [];
  const unfrozen = strays(options.liveRoot);
  if (unfrozen.length > 0) {
    throw new Error(
      `composed shadow refuses a live root holding inputs it does not freeze: ${unfrozen.join(', ')}`,
    );
  }
  // Validate both scratch destinations before anything is deleted: a live root nested under, or
  // aliased by, a copy would otherwise be removed as a "stray" before the freeze's own overlap
  // check runs, and a copy that is itself a symbolic link would redirect the deletion elsewhere.
  const sides = [join(options.scratch, 'a'), join(options.scratch, 'b')];
  rejectLiveOverlap(options.liveRoot, sides);
  for (const side of sides) {
    if (lstatOrNull(side)?.isSymbolicLink()) {
      throw new Error(`scratch destination ${side} is a symbolic link; refusing to clear it`);
    }
  }
  // A reused scratch is cleared of everything outside the same set, before either runner starts:
  // a copy keeping `receipts/`, `runs/` or `ledger/` from an earlier run (Python's tick creates
  // some itself) would feed one side an input the other lacks. `rmSync` never follows a link.
  for (const side of sides)
    for (const name of strays(side)) rmSync(join(side, name), { recursive: true, force: true });
  const frozen = freezeStateRoot(options.liveRoot, options.scratch);
  // The overwritten outputs of an earlier run are cleared on both sides, so each run starts equal.
  for (const dir of [frozen.a, frozen.b])
    for (const name of COMPOSED_HARMLESS_ENTRIES)
      rmSync(join(dir, name), { recursive: true, force: true });
  const python = await options.python(frozen.a);
  const ts = await options.ts(frozen.b);
  const diff = compareComposedArtefacts(
    { root: frozen.a, phaseCalls: python.phaseCalls, slotDecision: '' },
    { root: frozen.b, phaseCalls: ts.phaseCalls, slotDecision: '' },
    options.pinnedAt,
    { a: python.log, b: ts.log },
  );
  const report = classifySample(
    options.sample,
    diff,
    liveUnchanged(options.liveRoot, frozen),
    options.allowList ?? [],
  );
  const gaps = ts.gaps;
  const openRows =
    gaps === undefined ? ['<no composition report>'] : [...gaps.unbound, ...gaps.staged];
  return { report, python, ts, complete: gaps?.complete === true, openRows };
}
