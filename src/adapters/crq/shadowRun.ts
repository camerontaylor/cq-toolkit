/**
 * Read-only shadow-run harness for the CRQ tick and slot (plan: docs/crq/shadow-run-plan.md).
 * Inactive: nothing imports this module, and it never runs either implementation. It only
 * freezes a state root into two scratch copies, proves the live root was not touched, and
 * compares the artefacts the Python and TypeScript sides left behind.
 *
 * Safety: the live root is opened for reading only (`copyFileSync` source, `readFileSync`),
 * never locked and never written. The pre/post `queue.json` digest is the abort signal.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Copy the live state root into `<scratch>/a` and `<scratch>/b`; the source is only read. */
export function freezeStateRoot(liveRoot: string, scratch: string): FrozenInput {
  const liveDigest = liveQueueDigest(liveRoot);
  const a = join(scratch, 'a');
  const b = join(scratch, 'b');
  for (const dir of [a, b]) {
    mkdirSync(dir, { recursive: true });
    for (const name of SHADOW_FILES) {
      const source = join(liveRoot, name);
      if (existsSync(source)) copyFileSync(source, join(dir, name));
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
  /** `events.jsonl`: first differing line (1-based) when it differs. */
  readonly events: { readonly verdict: FileVerdict; readonly line?: number };
  readonly heartbeat: FileVerdict;
  readonly phaseCalls: 'same' | 'differs';
  readonly slotDecision: 'same' | 'differs';
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

/** Replace an `at` that denotes the pinned instant, so only real clock drift shows. */
function normaliseEvent(line: string, pinnedAt: string): JsonValue {
  const value = parseJsonValue(line);
  if (!(value instanceof JsonObject)) return value;
  const pinned = Date.parse(pinnedAt);
  return new JsonObject(
    value.entries.map(([key, entry]) =>
      key === 'at' && typeof entry === 'string' && Date.parse(entry) === pinned
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

export const identical = (diff: ShadowDiff): boolean =>
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
